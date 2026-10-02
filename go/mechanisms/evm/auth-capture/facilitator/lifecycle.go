package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// lifecyclePreconditions is the state common to capture and void: the resolved request,
// the escrow's paymentInfoHash, and the on-chain paymentState balances.
type lifecyclePreconditions struct {
	deployment       authcapture.AuthCaptureDeployment
	extra            authcapture.AuthCaptureExtra
	chainID          *big.Int
	paymentInfo      authcapture.PaymentInfoStruct
	paymentInfoHash  string
	capturableAmount *big.Int
	refundableAmount *big.Int
}

// checkLifecycleCommon validates what capture and void share without touching the chain: the
// request, the relay gates, the paymentInfo against the originally accepted requirements and
// the salt binding. The on-chain payment state is read separately, after the authorizer
// signature checks, so a forged payload cannot cost any RPC reads.
func (f *AuthCaptureEvmScheme) checkLifecycleCommon(
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	paymentInfo authcapture.PaymentInfoStruct,
	saltNonce string,
) (*lifecyclePreconditions, error) {
	payer := paymentInfo.Payer
	rc, err := checkRequest(payload, requirements, payer)
	if err != nil {
		return nil, err
	}
	extra := rc.extra

	if extra.OperatorType != "" && extra.OperatorType != "delegated" {
		return nil, x402.NewVerifyError(ErrLifecycleNotRelayed, payer, "lifecycle payloads require operatorType delegated")
	}
	if !authcapture.IsNonZeroAddress(extra.ReceiverAuthorizer) {
		return nil, x402.NewVerifyError(ErrLifecycleNotRelayed, payer, "lifecycle payloads require a non-zero receiverAuthorizer")
	}
	if extra.PaymentFlow != "" && extra.PaymentFlow != "escrow" {
		return nil, x402.NewVerifyError(ErrPayloadType, payer, fmt.Sprintf("capture and void require paymentFlow escrow, got %s", extra.PaymentFlow))
	}
	if !f.controlsAddress(extra.CaptureAuthorizer) {
		return nil, x402.NewVerifyError(ErrOperatorNotAdmitted, payer, fmt.Sprintf("captureAuthorizer %s is not controlled by this facilitator", extra.CaptureAuthorizer))
	}
	if !strings.EqualFold(paymentInfo.Operator, extra.CaptureAuthorizer) {
		return nil, x402.NewVerifyError(ErrOperatorMismatch, payer, "paymentInfo.operator does not match captureAuthorizer")
	}

	expectedSalt, err := authcapture.DeriveBoundSalt(
		authcapture.ExtraAddress(extra.ReceiverAuthorizer),
		authcapture.ExtraAddress(extra.Policy),
		saltNonce,
	)
	if err != nil {
		return nil, x402.NewVerifyError(ErrSaltBindingMismatch, payer, err.Error())
	}
	if !strings.EqualFold(expectedSalt, paymentInfo.Salt) {
		return nil, x402.NewVerifyError(ErrSaltBindingMismatch, payer, "salt does not match derived bound salt")
	}
	if mismatch := paymentInfoMismatch(paymentInfo, payload.Accepted.Amount, requirements, extra); mismatch != "" {
		return nil, x402.NewVerifyError(ErrPaymentInfoMismatch, payer, mismatch)
	}

	paymentInfoHash, err := authcapture.ComputePaymentInfoHash(rc.chainID, paymentInfo, payer, rc.deployment.Escrow)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, payer, err.Error())
	}

	return &lifecyclePreconditions{
		deployment:      rc.deployment,
		extra:           extra,
		chainID:         rc.chainID,
		paymentInfo:     paymentInfo,
		paymentInfoHash: paymentInfoHash,
	}, nil
}

// loadCollectedState fills the on-chain balances and requires the payment to be collected.
func (f *AuthCaptureEvmScheme) loadCollectedState(ctx context.Context, lc *lifecyclePreconditions) error {
	payer := lc.paymentInfo.Payer
	hasCollected, capturable, refundable, err := readCollectedState(ctx, f.signer, &lc.deployment, lc.paymentInfoHash)
	if err != nil {
		return x402.NewVerifyError(ErrUnexpectedPaymentState, payer, err.Error())
	}
	if !hasCollected {
		return x402.NewVerifyError(ErrUnexpectedPaymentState, payer, "payment has not been collected on-chain")
	}
	lc.capturableAmount = capturable
	lc.refundableAmount = refundable
	return nil
}

// paymentInfoMismatch returns a description of the first paymentInfo field that differs
// from what the requirements dictate, or "" when they all match. maxAmount is the amount
// the payer authorized, so it is compared with the accepted amount: on the settle path
// requirements.Amount carries the capture amount, which may be a partial one.
func paymentInfoMismatch(
	info authcapture.PaymentInfoStruct,
	acceptedAmount string,
	requirements types.PaymentRequirements,
	extra authcapture.AuthCaptureExtra,
) string {
	switch {
	case !strings.EqualFold(info.Receiver, requirements.PayTo):
		return "paymentInfo.receiver does not match requirements.payTo"
	case !strings.EqualFold(info.Token, requirements.Asset):
		return "paymentInfo.token does not match requirements.asset"
	case info.MaxAmount != acceptedAmount:
		return "paymentInfo.maxAmount does not match the accepted amount"
	case !strings.EqualFold(info.FeeReceiver, extra.FeeRecipient):
		return "paymentInfo.feeReceiver does not match extra.feeRecipient"
	case info.MinFeeBps != extra.MinFeeBps || info.MaxFeeBps != extra.MaxFeeBps:
		return "paymentInfo fee bounds do not match extra"
	case info.AuthorizationExpiry != extra.CaptureDeadline || info.RefundExpiry != extra.RefundDeadline:
		return "paymentInfo deadlines do not match extra"
	}
	return ""
}

// tuple returns the paymentInfo as the first escrow call argument.
func (lc *lifecyclePreconditions) tuple() (authcapture.PaymentInfoAbiTuple, error) {
	tuple, err := lc.paymentInfo.ToAbiTuple()
	if err != nil {
		return tuple, x402.NewVerifyError(ErrPayloadFormat, lc.paymentInfo.Payer, err.Error())
	}
	return tuple, nil
}

// simulateLifecycle simulates an operator-gated escrow call taking the paymentInfo first.
func (f *AuthCaptureEvmScheme) simulateLifecycle(ctx context.Context, lc *lifecyclePreconditions, function string, args ...interface{}) error {
	tuple, err := lc.tuple()
	if err != nil {
		return err
	}
	return simulateEscrowCall(ctx, f.signer, &lc.deployment, lc.paymentInfo.Operator, lc.paymentInfo.Payer, function, append([]interface{}{tuple}, args...)...)
}

// writeLifecycle submits an operator-gated escrow call taking the paymentInfo first.
func (f *AuthCaptureEvmScheme) writeLifecycle(
	ctx context.Context,
	fctx *x402.FacilitatorContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	lc *lifecyclePreconditions,
	function string,
	args ...interface{},
) (string, error) {
	tuple, err := lc.tuple()
	if err != nil {
		return "", toSettleError(err, x402.Network(payload.Accepted.Network), lc.paymentInfo.Payer)
	}
	return f.writeEscrow(ctx, fctx, payload, requirements, &lc.deployment, lc.paymentInfo.Payer, function, append([]interface{}{tuple}, args...)...)
}

// capturePreconditions is the verified state verifyCapture derives and settleCapture reuses.
type capturePreconditions struct {
	lifecycle   *lifecyclePreconditions
	amount      *big.Int
	fee         authcapture.CaptureFee
	feeReceiver string
	withVoid    bool
}

// parseCaptureFee reads the deployment's fee field (feeBps on v1.0, feeAmount on v1.1).
func parseCaptureFee(p *authcapture.CapturePayload, deployment *authcapture.AuthCaptureDeployment) (authcapture.CaptureFee, bool) {
	if deployment.Version == authcapture.AuthCaptureDeploymentV1_0 {
		return authcapture.CaptureFee{Bps: p.FeeBps}, p.FeeBps != nil && p.FeeAmount == ""
	}
	amount, ok := new(big.Int).SetString(p.FeeAmount, 10)
	return authcapture.CaptureFee{Amount: amount}, ok && p.FeeBps == nil
}

// feeWithinBounds applies the escrow's fee range: feeBps in [min, max] on v1.0, and
// feeAmount in [amount*min/10000, amount*max/10000] on v1.1.
func feeWithinBounds(fee authcapture.CaptureFee, amount *big.Int, extra authcapture.AuthCaptureExtra) bool {
	if fee.Bps != nil {
		return *fee.Bps >= extra.MinFeeBps && *fee.Bps <= extra.MaxFeeBps
	}
	lowest := authcapture.FeeAmountFromBps(amount, extra.MinFeeBps)
	highest := authcapture.FeeAmountFromBps(amount, extra.MaxFeeBps)
	return fee.Amount.Cmp(lowest) >= 0 && fee.Amount.Cmp(highest) <= 0
}

func parseUint(value string) (*big.Int, bool) {
	n, ok := new(big.Int).SetString(value, 10)
	return n, ok && n.Sign() >= 0
}

// checkCapturePreconditions validates a capture payload per the spec's Lifecycle payloads checklist.
// Every check that needs no chain read, including both authorizer signatures, runs before the
// payment state is read.
func (f *AuthCaptureEvmScheme) checkCapturePreconditions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*capturePreconditions, error) {
	p, err := authcapture.CapturePayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	payer := p.PaymentInfo.Payer

	lc, err := f.checkLifecycleCommon(payload, requirements, p.PaymentInfo, p.SaltNonce)
	if err != nil {
		return nil, err
	}

	fee, ok := parseCaptureFee(p, &lc.deployment)
	if !ok {
		return nil, x402.NewVerifyError(ErrPayloadFormat, payer, "fee field does not match the deployment's fee encoding")
	}
	amount, amountOK := parseUint(p.Amount)
	expectedCapturable, capturableOK := parseUint(p.ExpectedCapturableAmount)
	expectedRefundable, refundableOK := parseUint(p.ExpectedRefundableAmount)
	if !amountOK || !capturableOK || !refundableOK {
		return nil, x402.NewVerifyError(ErrPayloadFormat, payer, "amount, expectedCapturableAmount and expectedRefundableAmount must be unsigned integers")
	}
	if uint64(time.Now().Unix()) >= p.PaymentInfo.AuthorizationExpiry {
		return nil, x402.NewVerifyError(ErrCaptureDeadlineExpired, payer, "authorizationExpiry has passed")
	}
	if amount.Sign() <= 0 {
		return nil, x402.NewVerifyError(ErrInsufficientAuthorization, payer, "amount must be > 0 and <= capturableAmount")
	}
	if !strings.EqualFold(p.FeeReceiver, lc.extra.FeeRecipient) {
		return nil, x402.NewVerifyError(ErrFeeReceiver, payer, "feeReceiver does not match extra.feeRecipient")
	}
	if !feeWithinBounds(fee, amount, lc.extra) {
		return nil, x402.NewVerifyError(ErrFeeBpsOutOfRange, payer, "fee outside extra bounds")
	}

	captureSig, err := evm.HexToBytes(p.AuthorizerSignature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrSignature, payer, err.Error())
	}
	valid, err := authcapture.VerifyCapture(ctx, f.signer, lc.extra.ReceiverAuthorizer, &lc.deployment, lc.extra.CaptureAuthorizer, lc.chainID,
		authcapture.CaptureParams{
			PaymentInfoHash:    lc.paymentInfoHash,
			Amount:             amount,
			Fee:                fee,
			FeeReceiver:        p.FeeReceiver,
			ExpectedCapturable: expectedCapturable,
			ExpectedRefundable: expectedRefundable,
		}, captureSig)
	if err != nil {
		return nil, x402.NewVerifyError(ErrAuthorizerSignature, payer, err.Error())
	}
	if !valid {
		return nil, x402.NewVerifyError(ErrAuthorizerSignature, payer, "authorizer signature invalid")
	}
	if p.VoidAuthorizerSignature != "" {
		if err := f.checkVoidSignature(ctx, lc, p.VoidAuthorizerSignature, ErrVoidAuthorizerSignature); err != nil {
			return nil, err
		}
	}

	if err := f.loadCollectedState(ctx, lc); err != nil {
		return nil, err
	}
	if expectedCapturable.Cmp(lc.capturableAmount) != 0 || expectedRefundable.Cmp(lc.refundableAmount) != 0 {
		return nil, x402.NewVerifyError(ErrUnexpectedPaymentState, payer, "expected capturable/refundable amount is stale")
	}
	if amount.Cmp(lc.capturableAmount) > 0 {
		return nil, x402.NewVerifyError(ErrInsufficientAuthorization, payer, "amount must be > 0 and <= capturableAmount")
	}
	if p.VoidAuthorizerSignature != "" && amount.Cmp(lc.capturableAmount) >= 0 {
		return nil, x402.NewVerifyError(ErrVoidRemainderFullCapture, payer, "voidAuthorizerSignature present but amount leaves no remainder to void")
	}

	return &capturePreconditions{
		lifecycle:   lc,
		amount:      amount,
		fee:         fee,
		feeReceiver: p.FeeReceiver,
		withVoid:    p.VoidAuthorizerSignature != "",
	}, nil
}

// checkVoidSignature verifies the receiverAuthorizer's Void signature over the paymentInfoHash.
// invalidReason names the failure for a signature that does not verify.
func (f *AuthCaptureEvmScheme) checkVoidSignature(ctx context.Context, lc *lifecyclePreconditions, voidSignature, invalidReason string) error {
	payer := lc.paymentInfo.Payer
	sig, err := evm.HexToBytes(voidSignature)
	if err != nil {
		return x402.NewVerifyError(invalidReason, payer, err.Error())
	}
	valid, err := authcapture.VerifyVoid(ctx, f.signer, lc.extra.ReceiverAuthorizer, lc.extra.CaptureAuthorizer, lc.chainID, lc.paymentInfoHash, sig)
	if err != nil {
		return x402.NewVerifyError(invalidReason, payer, err.Error())
	}
	if !valid {
		return x402.NewVerifyError(invalidReason, payer, "void authorizer signature invalid")
	}
	return nil
}

func (pre *capturePreconditions) captureArgs() []interface{} {
	return []interface{}{pre.amount, pre.fee.Arg(), common.HexToAddress(pre.feeReceiver)}
}

// simulateCapture simulates the capture, and the void when a capture-and-void payload carries one.
func (f *AuthCaptureEvmScheme) simulateCapture(ctx context.Context, pre *capturePreconditions) error {
	if err := f.simulateLifecycle(ctx, pre.lifecycle, "capture", pre.captureArgs()...); err != nil {
		return err
	}
	if pre.withVoid {
		return f.simulateLifecycle(ctx, pre.lifecycle, "void")
	}
	return nil
}

// verifyCapture validates a capture payload and simulates it.
func (f *AuthCaptureEvmScheme) verifyCapture(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.VerifyResponse, error) {
	pre, err := f.checkCapturePreconditions(ctx, payload, requirements)
	if err != nil {
		return nil, err
	}
	if err := f.simulateCapture(ctx, pre); err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: pre.lifecycle.paymentInfo.Payer}, nil
}

// settleCapture submits the capture, then any voidAuthorizerSignature void of the remaining hold.
func (f *AuthCaptureEvmScheme) settleCapture(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	if resp, err := f.resumePending(ctx, payload, requirements); resp != nil || err != nil {
		return resp, err
	}

	pre, err := f.checkCapturePreconditions(ctx, payload, requirements)
	if err != nil {
		return nil, toSettleError(err, network, "")
	}
	payer := pre.lifecycle.paymentInfo.Payer
	if f.config.SimulateInSettle {
		if err := f.simulateCapture(ctx, pre); err != nil {
			return nil, toSettleError(err, network, payer)
		}
	}

	txHash, err := f.writeLifecycle(ctx, fctx, payload, requirements, pre.lifecycle, "capture", pre.captureArgs()...)
	if err != nil {
		return nil, err
	}
	resp, err := f.awaitSettlement(ctx, payload, requirements, payer, txHash)
	if err != nil || !pre.withVoid {
		return resp, err
	}

	// The capture is the settlement of record, so a failed void is reported in Extra.
	voidTx, voidErr := f.voidRemainder(ctx, fctx, payload, requirements, pre.lifecycle)
	switch {
	case voidErr != nil:
		resp.Extra = map[string]interface{}{"voidError": voidErr.Error()}
	case voidTx != "":
		resp.Extra = map[string]interface{}{"voidTransaction": voidTx}
	}
	return resp, nil
}

// voidRemainder voids the hold left after a capture. It returns an empty hash when a race
// already emptied the hold, which the spec treats as capture-only success.
func (f *AuthCaptureEvmScheme) voidRemainder(
	ctx context.Context,
	fctx *x402.FacilitatorContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	lc *lifecyclePreconditions,
) (string, error) {
	_, capturable, _, err := readPaymentState(ctx, f.signer, &lc.deployment, lc.paymentInfoHash)
	if err != nil {
		return "", err
	}
	if capturable.Sign() <= 0 {
		return "", nil
	}
	txHash, err := f.writeLifecycle(ctx, fctx, payload, requirements, lc, "void")
	if err != nil {
		return "", err
	}
	receipt, err := f.signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return "", err
	}
	if receipt.Status != evm.TxStatusSuccess {
		return "", fmt.Errorf("void transaction %s reverted", txHash)
	}
	return txHash, nil
}

// checkVoidPreconditions validates a void payload per the spec's Lifecycle payloads checklist.
func (f *AuthCaptureEvmScheme) checkVoidPreconditions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*lifecyclePreconditions, error) {
	p, err := authcapture.VoidPayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	payer := p.PaymentInfo.Payer
	if p.VoidAuthorizerSignature != "" {
		return nil, x402.NewVerifyError(ErrVoidAuthorizerSignature, payer, "voidAuthorizerSignature must not appear on a void payload")
	}

	lc, err := f.checkLifecycleCommon(payload, requirements, p.PaymentInfo, p.SaltNonce)
	if err != nil {
		return nil, err
	}
	if err := f.checkVoidSignature(ctx, lc, p.AuthorizerSignature, ErrAuthorizerSignature); err != nil {
		return nil, err
	}

	if err := f.loadCollectedState(ctx, lc); err != nil {
		return nil, err
	}
	if lc.capturableAmount.Sign() <= 0 {
		return nil, x402.NewVerifyError(ErrUnexpectedPaymentState, payer, "no capturable balance to void")
	}
	return lc, nil
}

// verifyVoid validates a void payload and simulates it.
func (f *AuthCaptureEvmScheme) verifyVoid(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.VerifyResponse, error) {
	lc, err := f.checkVoidPreconditions(ctx, payload, requirements)
	if err != nil {
		return nil, err
	}
	if err := f.simulateLifecycle(ctx, lc, "void"); err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: lc.paymentInfo.Payer}, nil
}

// settleVoid submits the void call for a void payload.
func (f *AuthCaptureEvmScheme) settleVoid(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	if resp, err := f.resumePending(ctx, payload, requirements); resp != nil || err != nil {
		return resp, err
	}

	lc, err := f.checkVoidPreconditions(ctx, payload, requirements)
	if err != nil {
		return nil, toSettleError(err, network, "")
	}
	payer := lc.paymentInfo.Payer
	if f.config.SimulateInSettle {
		if err := f.simulateLifecycle(ctx, lc, "void"); err != nil {
			return nil, toSettleError(err, network, payer)
		}
	}

	txHash, err := f.writeLifecycle(ctx, fctx, payload, requirements, lc, "void")
	if err != nil {
		return nil, err
	}
	return f.awaitSettlement(ctx, payload, requirements, payer, txHash)
}
