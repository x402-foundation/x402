package facilitator

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// timeSkewSeconds is the spec's floor for deadline and expiry checks.
const timeSkewSeconds = 6

// requestContext is what every payload shape derives from the requirements.
type requestContext struct {
	extra      authcapture.AuthCaptureExtra
	deployment authcapture.AuthCaptureDeployment
	chainID    *big.Int
}

// checkRequest runs the scheme, network and extra checks shared by collect and lifecycle payloads.
func checkRequest(payload types.PaymentPayload, requirements types.PaymentRequirements, payer string) (*requestContext, error) {
	if requirements.Scheme != authcapture.SchemeAuthCapture || payload.Accepted.Scheme != authcapture.SchemeAuthCapture {
		return nil, x402.NewVerifyError(ErrInvalidScheme, payer, fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}
	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, payer, fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}
	chainID, err := evm.GetEvmChainId(requirements.Network)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidNetwork, payer, err.Error())
	}

	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	if err != nil {
		return nil, x402.NewVerifyError(ErrExtra, payer, err.Error())
	}
	if extra.MinFeeBps > extra.MaxFeeBps || extra.MaxFeeBps > authcapture.BpsDenominator {
		return nil, x402.NewVerifyError(ErrExtra, payer, "fee bounds must satisfy minFeeBps <= maxFeeBps <= 10000")
	}
	if !authcapture.IsNonZeroAddress(extra.FeeRecipient) && extra.MaxFeeBps != 0 {
		return nil, x402.NewVerifyError(ErrZeroFeeReceiver, payer, "a zero feeRecipient requires minFeeBps and maxFeeBps of 0")
	}
	if extra.AutoCapture {
		return nil, x402.NewVerifyError(ErrUnsupportedPaymentFlow, payer, "autoCapture is removed; use paymentFlow")
	}
	switch extra.PaymentFlow {
	case "", authcapture.PaymentFlowEscrow:
	case authcapture.PaymentFlowAuthorization:
		if !authcapture.IsNonZeroAddress(extra.ReceiverAuthorizer) {
			return nil, x402.NewVerifyError(ErrMissingReceiverAuthorizer, payer, "paymentFlow authorization requires a non-zero receiverAuthorizer")
		}
	default:
		return nil, x402.NewVerifyError(ErrUnsupportedPaymentFlow, payer, fmt.Sprintf("unsupported paymentFlow: %s", extra.PaymentFlow))
	}
	return &requestContext{extra: extra, deployment: deployment, chainID: chainID}, nil
}

// controlsAddress reports whether address is one this facilitator submits transactions from.
func (f *AuthCaptureEvmScheme) controlsAddress(address string) bool {
	for _, controlled := range f.signer.GetAddresses() {
		if evm.NormalizeAddress(controlled) == evm.NormalizeAddress(address) {
			return true
		}
	}
	return false
}

// toSettleError converts a verification failure into the equivalent settle failure.
func toSettleError(err error, network x402.Network, payer string) error {
	ve := &x402.VerifyError{}
	if errors.As(err, &ve) {
		return x402.NewSettleError(ve.InvalidReason, ve.Payer, network, "", ve.InvalidMessage)
	}
	return x402.NewSettleError(ErrVerificationFailed, payer, network, "", err.Error())
}

func escrowABI(deployment *authcapture.AuthCaptureDeployment) (abi.ABI, error) {
	return abi.JSON(bytes.NewReader(authcapture.EscrowABIForDeployment(deployment)))
}

// escrowRevertReasons maps AuthCaptureEscrow custom errors to spec invalidReason codes.
var escrowRevertReasons = map[string]string{
	"AfterPreApprovalExpiry":       ErrAuthorizationExpired,
	"InvalidExpiries":              ErrDeadlineOrdering,
	"ExceedsMaxAmount":             ErrAmountMismatch,
	"ZeroAmount":                   ErrAmountMismatch,
	"AmountOverflow":               ErrAmountOverflow,
	"PaymentAlreadyCollected":      ErrPaymentAlreadyCollected,
	"TokenCollectionFailed":        ErrTokenCollectionFailed,
	"InvalidCollectorForOperation": ErrCollector,
	"InvalidSender":                ErrOperatorMismatch,
	"FeeBpsOverflow":               ErrFeeBps,
	"InvalidFeeBpsRange":           ErrFeeBpsRange,
	"FeeBpsOutOfRange":             ErrFeeBpsOutOfRange,
	"FeeAmountOutOfRange":          ErrFeeBpsOutOfRange,
	"ZeroFeeReceiver":              ErrZeroFeeReceiver,
	"InvalidFeeReceiver":           ErrFeeReceiver,
	"AfterAuthorizationExpiry":     ErrCaptureDeadlineExpired,
	"InsufficientAuthorization":    ErrInsufficientAuthorization,
	"ZeroAuthorization":            ErrZeroAuthorization,
	"AfterRefundExpiry":            ErrRefundDeadlineExpired,
	"RefundExceedsCapture":         ErrRefundExceedsCapture,
}

// revertReason decodes revert data against the escrow ABI's custom errors, falling
// back to ErrSimulationFailed for unknown or missing data.
func revertReason(deployment *authcapture.AuthCaptureDeployment, data []byte) string {
	if len(data) < 4 {
		return ErrSimulationFailed
	}
	contractABI, err := escrowABI(deployment)
	if err != nil {
		return ErrSimulationFailed
	}
	var selector [4]byte
	copy(selector[:], data[:4])
	abiErr, err := contractABI.ErrorByID(selector)
	if err != nil {
		return ErrSimulationFailed
	}
	if reason, ok := escrowRevertReasons[abiErr.Name]; ok {
		return reason
	}
	return ErrSimulationFailed
}

// errorRevertData extracts hex revert data from a JSON-RPC error, if it carries any.
func errorRevertData(err error) []byte {
	var withData interface{ ErrorData() interface{} }
	if !errors.As(err, &withData) {
		return nil
	}
	hexData, ok := withData.ErrorData().(string)
	if !ok {
		return nil
	}
	data, decodeErr := evm.HexToBytes(hexData)
	if decodeErr != nil {
		return nil
	}
	return data
}

// simulateEscrowCall eth_calls an AuthCaptureEscrow function as the operator and returns a typed
// VerifyError when it reverts. The escrow gates authorize, capture and void on msg.sender.
func simulateEscrowCall(
	ctx context.Context,
	signer Signer,
	deployment *authcapture.AuthCaptureDeployment,
	operator string,
	payer string,
	function string,
	args ...interface{},
) error {
	escrowABI := authcapture.EscrowABIForDeployment(deployment)
	if _, err := signer.ReadContractFrom(ctx, operator, deployment.Escrow, escrowABI, function, args...); err != nil {
		return x402.NewVerifyError(revertReason(deployment, errorRevertData(err)), payer, err.Error())
	}
	return nil
}

// needsFactoryDeploy reports whether the payer is a counterfactual smart wallet the
// facilitator must deploy before authorize.
func needsFactoryDeploy(sigData *evm.ERC6492SignatureData) bool {
	return evm.HasEIP6492Deployment(sigData) && !sigData.CodeDeployed
}

// simulateFactoryDeploy checks the ERC-6492 factory call succeeds. The escrow call itself
// cannot be simulated for an undeployed payer: Multicall3 is not the operator.
func simulateFactoryDeploy(ctx context.Context, signer evm.FacilitatorEvmSigner, sigData *evm.ERC6492SignatureData, payer string) error {
	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{
		{Address: common.BytesToAddress(sigData.Factory[:]).Hex(), CallData: sigData.FactoryCalldata},
	})
	if err != nil {
		return x402.NewVerifyError(ErrSimulationFailed, payer, err.Error())
	}
	if len(results) != 1 || !results[0].Success() {
		return x402.NewVerifyError(ErrSimulationFailed, payer, "smart wallet deployment simulation reverted")
	}
	return nil
}

// readPaymentState reads paymentState(paymentInfoHash), the single-use balance the
// facilitator checks before relaying a capture or void. It goes through Multicall so the
// three return values decode identically for every signer implementation.
func readPaymentState(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	deployment *authcapture.AuthCaptureDeployment,
	paymentInfoHashHex string,
) (hasCollectedPayment bool, capturableAmount *big.Int, refundableAmount *big.Int, err error) {
	hashBytes, err := evm.HexToBytes(paymentInfoHashHex)
	if err != nil {
		return false, nil, nil, fmt.Errorf("invalid paymentInfoHash: %w", err)
	}

	results, err := evm.Multicall(ctx, signer, []evm.MulticallCall{{
		Address:      deployment.Escrow,
		ABI:          authcapture.EscrowABIForDeployment(deployment),
		FunctionName: "paymentState",
		Args:         []interface{}{common.BytesToHash(hashBytes)},
	}})
	if err != nil {
		return false, nil, nil, err
	}
	if len(results) != 1 || !results[0].Success() {
		return false, nil, nil, fmt.Errorf("paymentState call failed")
	}
	outputs, ok := results[0].Result.([]interface{})
	if !ok || len(outputs) != 3 {
		return false, nil, nil, fmt.Errorf("unexpected paymentState result shape")
	}
	hasCollectedPayment, _ = outputs[0].(bool)
	capturableAmount = asBigInt(outputs[1])
	refundableAmount = asBigInt(outputs[2])
	if capturableAmount == nil || refundableAmount == nil {
		return false, nil, nil, fmt.Errorf("unexpected paymentState amount types")
	}
	return hasCollectedPayment, capturableAmount, refundableAmount, nil
}

// A capture or void usually follows the authorize immediately, and an RPC node behind
// the one that mined it may not show the collect yet. Reads are retried before the
// payment is treated as uncollected; tests shorten the delay.
const collectedReadAttempts = 5

var collectedReadDelay = time.Second

// readCollectedState is readPaymentState, retried while the payment reads as uncollected.
func readCollectedState(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	deployment *authcapture.AuthCaptureDeployment,
	paymentInfoHash string,
) (hasCollected bool, capturable *big.Int, refundable *big.Int, err error) {
	for attempt := 1; ; attempt++ {
		hasCollected, capturable, refundable, err = readPaymentState(ctx, signer, deployment, paymentInfoHash)
		if err != nil || hasCollected || attempt == collectedReadAttempts {
			return hasCollected, capturable, refundable, err
		}
		select {
		case <-ctx.Done():
			return false, nil, nil, ctx.Err()
		case <-time.After(collectedReadDelay):
		}
	}
}

// asBigInt normalizes a go-ethereum ABI-decoded numeric result to *big.Int.
func asBigInt(value interface{}) *big.Int {
	switch v := value.(type) {
	case *big.Int:
		return v
	case big.Int:
		return &v
	default:
		return nil
	}
}

// writeEscrow submits an AuthCaptureEscrow call from operator, mapping a revert to its typed reason.
func (f *AuthCaptureEvmScheme) writeEscrow(
	ctx context.Context,
	fctx *x402.FacilitatorContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	deployment *authcapture.AuthCaptureDeployment,
	operator string,
	payer string,
	function string,
	args ...interface{},
) (string, error) {
	return f.submitEscrowCall(ctx, fctx, payload, requirements, deployment, operator, payer, deployment.Escrow, 0, function, args...)
}

// submitEscrowCall submits an escrow-ABI call to target, the escrow itself or a custom operator
// forwarding to it. A non-empty from is the sender. A non-zero gas caps the call, needs a
// GasLimitWriter signer and ignores from.
func (f *AuthCaptureEvmScheme) submitEscrowCall(
	ctx context.Context,
	fctx *x402.FacilitatorContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	deployment *authcapture.AuthCaptureDeployment,
	from string,
	payer string,
	target string,
	gas uint64,
	function string,
	args ...interface{},
) (string, error) {
	network := x402.Network(payload.Accepted.Network)
	dataSuffix, err := evm.ResolveDataSuffix(fctx, evm.DataSuffixContext{Payload: payload, Requirements: requirements})
	if err != nil {
		return "", x402.NewSettleError(ErrPayloadFormat, payer, network, "", err.Error())
	}
	escrowABI := authcapture.EscrowABIForDeployment(deployment)
	var txHash string
	switch {
	case gas > 0:
		writer, ok := f.signer.(GasLimitWriter)
		if !ok {
			return "", x402.NewSettleError(ErrSimulationFailed, payer, network, "", "signer cannot cap gas for a custom operator")
		}
		txHash, err = writer.WriteContractWithGas(ctx, target, escrowABI, function, dataSuffix, gas, args...)
	case from != "":
		txHash, err = f.signer.WriteContractFrom(ctx, from, target, escrowABI, function, dataSuffix, args...)
	default:
		txHash, err = f.signer.WriteContract(ctx, target, escrowABI, function, dataSuffix, args...)
	}
	if err != nil {
		return "", x402.NewSettleError(revertReason(deployment, errorRevertData(err)), payer, network, "", err.Error())
	}
	return txHash, nil
}

// pendingKey is the pending-settlement store key: the payload's signature, except for a lifecycle
// payload whose authorizer is delegated to this facilitator. The facilitator produced that
// signature, which may differ between attempts, so the key is what the payload does to which payment.
func (f *AuthCaptureEvmScheme) pendingKey(payload types.PaymentPayload, requirements types.PaymentRequirements) string {
	switch payload.Payload["type"] {
	case opCapture, opVoid, opRefund:
		extra, _, err := authcapture.ParseAuthCaptureExtra(requirements)
		if err == nil && getDelegatedAuthorizer(f.config, extra.ReceiverAuthorizer) != nil {
			return lifecycleSettlementKey(payload, requirements)
		}
	}
	return settlementKey(payload.Payload)
}

// lifecycleSettlementKey is network, paymentInfoHash, type, amount and expected balances, or ""
// when the payload cannot be read.
func lifecycleSettlementKey(payload types.PaymentPayload, requirements types.PaymentRequirements) string {
	_, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	if err != nil {
		return ""
	}
	chainID, err := evm.GetEvmChainId(requirements.Network)
	if err != nil {
		return ""
	}
	paymentInfo, err := lifecyclePaymentInfo(payload.Payload)
	if err != nil {
		return ""
	}
	paymentInfoHash, err := authcapture.ComputePaymentInfoHash(chainID, paymentInfo, paymentInfo.Payer, deployment.Escrow)
	if err != nil {
		return ""
	}
	operation, _ := payload.Payload["type"].(string)
	amount, _ := payload.Payload["amount"].(string)
	expectedCapturable, _ := payload.Payload["expectedCapturableAmount"].(string)
	expectedRefundable, _ := payload.Payload["expectedRefundableAmount"].(string)
	return strings.Join([]string{
		requirements.Network, strings.ToLower(paymentInfoHash), operation, amount, expectedCapturable, expectedRefundable,
	}, "|")
}

// settlementKey is the pending-settlement key of a collect payload: its signature.
func settlementKey(payload map[string]interface{}) string {
	if sig, ok := payload["signature"].(string); ok {
		return sig
	}
	sig, _ := payload["authorizerSignature"].(string)
	return sig
}

// payloadPayer reads the payer straight from the wire payload for the pending-settlement
// path, where the original attempt already verified this exact payload.
func payloadPayer(payload map[string]interface{}) string {
	for _, key := range []string{"authorization", "permit2Authorization"} {
		if auth, ok := payload[key].(map[string]interface{}); ok {
			from, _ := auth["from"].(string)
			return from
		}
	}
	if info, ok := payload["paymentInfo"].(map[string]interface{}); ok {
		payer, _ := info["payer"].(string)
		return payer
	}
	return ""
}

// settledAmount is the amount reported in the SettleResponse: the hold for authorize, the
// amount the payload names for charge, capture and refund, and none for void.
func settledAmount(payload map[string]interface{}, requirements types.PaymentRequirements) string {
	if payload["type"] == opVoid {
		return ""
	}
	if amount, ok := payload["amount"].(string); ok {
		return amount
	}
	return requirements.Amount
}

// resumePending completes a settlement whose transaction was broadcast on an earlier
// attempt. It returns (nil, nil) when nothing is pending for the payload.
func (f *AuthCaptureEvmScheme) resumePending(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	check receiptCheck,
) (*x402.SettleResponse, error) {
	key := f.pendingKey(payload, requirements)
	if key == "" {
		return nil, nil
	}
	txHash, ok, _ := f.pendingStore.Get(ctx, key)
	if !ok {
		return nil, nil
	}
	_ = f.pendingStore.Delete(ctx, key)
	return f.awaitSettlement(ctx, payload, requirements, payloadPayer(payload.Payload), txHash, check)
}

// receiptCheck inspects a confirmed receipt. It returns a failed SettleResponse to reject the
// settlement, and nil, nil to accept it.
type receiptCheck func(ctx context.Context, receipt *evm.TransactionReceipt) (*x402.SettleResponse, error)

// awaitSettlement waits for txHash to confirm, applies check if set, and builds the SettleResponse.
func (f *AuthCaptureEvmScheme) awaitSettlement(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	payer string,
	txHash string,
	check receiptCheck,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	receipt, err := evm.WaitForSettleReceiptWithPendingStore(
		ctx, f.pendingStore, f.pendingKey(payload, requirements), f.signer, txHash, payer, network,
		ErrTransactionReverted, ErrTransactionReverted,
	)
	if err != nil {
		return nil, err
	}
	if check != nil {
		if rejected, err := check(ctx, receipt); rejected != nil || err != nil {
			return rejected, err
		}
	}
	return &x402.SettleResponse{
		Success:     true,
		Transaction: receipt.TxHash,
		Network:     network,
		Payer:       payer,
		Amount:      settledAmount(payload.Payload, requirements),
	}, nil
}

// readTokenBalance reads an ERC-20 balance. It returns nil when the read fails or decodes to
// an unexpected type, so callers can treat the balance as unknown.
func readTokenBalance(ctx context.Context, signer evm.FacilitatorEvmSigner, token, account string) *big.Int {
	balance, err := signer.ReadContract(ctx, token, evm.ERC20BalanceOfABI, "balanceOf", common.HexToAddress(account))
	if err != nil {
		return nil
	}
	return asBigInt(balance)
}
