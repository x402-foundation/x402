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

// lifecyclePreconditions is the state common to capture, void and refund: the resolved request,
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

// Lifecycle operations a payload.type names.
const (
	opCapture = "capture"
	opVoid    = "void"
	opRefund  = "refund"
)

// checkLifecycleCommon validates what capture, void and refund share without touching the chain:
// the request, the relay gates, the paymentInfo against the originally accepted requirements and
// the salt binding. The on-chain payment state is read separately, after the authorizer
// signature checks, so a forged payload cannot cost any RPC reads.
func (f *AuthCaptureEvmScheme) checkLifecycleCommon(
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	paymentInfo authcapture.PaymentInfoStruct,
	saltNonce string,
	operation string,
) (*lifecyclePreconditions, error) {
	payer := paymentInfo.Payer
	rc, err := checkRequest(payload, requirements, payer)
	if err != nil {
		return nil, err
	}
	extra := rc.extra

	if err := f.checkOperator(extra, payer, true); err != nil {
		return nil, err
	}
	if operation != opRefund && extra.PaymentFlow == authcapture.PaymentFlowAuthorization {
		return nil, x402.NewVerifyError(ErrPayloadType, payer, "capture and void require paymentFlow escrow, got authorization")
	}
	if operation == opRefund && !f.config.RefundFunding {
		return nil, x402.NewVerifyError(ErrRefundFundingUnavailable, payer, "refunds for delegated operators need an out-of-band funding agreement")
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

// balancesMatch reports whether the on-chain balances are what the authorizer signed against.
func (lc *lifecyclePreconditions) balancesMatch(expectedCapturable, expectedRefundable *big.Int) bool {
	return lc.capturableAmount.Cmp(expectedCapturable) == 0 && lc.refundableAmount.Cmp(expectedRefundable) == 0
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
	return f.writeEscrow(ctx, fctx, payload, requirements, &lc.deployment, lc.paymentInfo.Operator, lc.paymentInfo.Payer, function, append([]interface{}{tuple}, args...)...)
}

// capturePreconditions is the verified state verifyCapture derives and settleCapture reuses.
type capturePreconditions struct {
	lifecycle   *lifecyclePreconditions
	amount      *big.Int
	fee         authcapture.CaptureFee
	feeReceiver string
	withVoid    bool
}

// checkCapturePreconditions validates a capture payload per the spec's Lifecycle payloads checklist.
// Every check that needs no chain read, including both authorizer signatures, runs before the
// payment state is read.
func (f *AuthCaptureEvmScheme) checkCapturePreconditions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*capturePreconditions, error) {
	p, err := authcapture.CapturePayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	payer := p.PaymentInfo.Payer

	lc, err := f.checkLifecycleCommon(payload, requirements, p.PaymentInfo, p.SaltNonce, opCapture)
	if err != nil {
		return nil, err
	}
	signed, err := f.signedLifecyclePayload(ctx, fctx, payload, requirements, lc)
	if err != nil {
		return nil, err
	}
	if p, err = authcapture.CapturePayloadFromMap(signed.Payload); err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, payer, err.Error())
	}

	fee, ok := parseSubmittedFee(p.FeeBps, p.FeeAmount, &lc.deployment)
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
	if reason := validateSubmittedFee(lc.extra, amount, fee, p.FeeReceiver); reason != "" {
		return nil, x402.NewVerifyError(reason, payer, "submitted fee or feeReceiver does not satisfy extra")
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
	if !lc.balancesMatch(expectedCapturable, expectedRefundable) {
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
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	pre, err := f.checkCapturePreconditions(ctx, payload, requirements, fctx)
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
	if resp, err := f.resumePending(ctx, payload, requirements, nil); resp != nil || err != nil {
		return resp, err
	}

	pre, err := f.checkCapturePreconditions(ctx, payload, requirements, fctx)
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
	resp, err := f.awaitSettlement(ctx, payload, requirements, payer, txHash, nil)
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
	fctx *x402.FacilitatorContext,
) (*lifecyclePreconditions, error) {
	p, err := authcapture.VoidPayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	payer := p.PaymentInfo.Payer
	if p.VoidAuthorizerSignature != "" {
		return nil, x402.NewVerifyError(ErrVoidAuthorizerSignature, payer, "voidAuthorizerSignature must not appear on a void payload")
	}

	lc, err := f.checkLifecycleCommon(payload, requirements, p.PaymentInfo, p.SaltNonce, opVoid)
	if err != nil {
		return nil, err
	}
	signed, err := f.signedLifecyclePayload(ctx, fctx, payload, requirements, lc)
	if err != nil {
		return nil, err
	}
	if p, err = authcapture.VoidPayloadFromMap(signed.Payload); err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, payer, err.Error())
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
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	lc, err := f.checkVoidPreconditions(ctx, payload, requirements, fctx)
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
	if resp, err := f.resumePending(ctx, payload, requirements, nil); resp != nil || err != nil {
		return resp, err
	}

	lc, err := f.checkVoidPreconditions(ctx, payload, requirements, fctx)
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
	return f.awaitSettlement(ctx, payload, requirements, payer, txHash, nil)
}

// hasAuthorizerSignature reports whether a lifecycle payload carries the authorizer signature.
func hasAuthorizerSignature(payload map[string]interface{}) bool {
	signature, _ := payload["authorizerSignature"].(string)
	return signature != ""
}

// lifecyclePaymentInfo reads the paymentInfo and payer out of a capture, void or refund payload.
func lifecyclePaymentInfo(payload map[string]interface{}) (authcapture.PaymentInfoStruct, error) {
	switch payload["type"] {
	case opCapture:
		p, err := authcapture.CapturePayloadFromMap(payload)
		if err != nil {
			return authcapture.PaymentInfoStruct{}, err
		}
		return p.PaymentInfo, nil
	case opVoid:
		p, err := authcapture.VoidPayloadFromMap(payload)
		if err != nil {
			return authcapture.PaymentInfoStruct{}, err
		}
		return p.PaymentInfo, nil
	case opRefund:
		p, err := authcapture.RefundPayloadFromMap(payload)
		if err != nil {
			return authcapture.PaymentInfoStruct{}, err
		}
		return p.PaymentInfo, nil
	default:
		return authcapture.PaymentInfoStruct{}, fmt.Errorf("unexpected lifecycle payload type %v", payload["type"])
	}
}

// signedLifecyclePayload returns the lifecycle payload with its authorizer signature: as is when
// the server signed it, signed by this facilitator when the authorizer is delegated to it, and a
// verification failure otherwise.
func (f *AuthCaptureEvmScheme) signedLifecyclePayload(
	ctx context.Context,
	fctx *x402.FacilitatorContext,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	lc *lifecyclePreconditions,
) (types.PaymentPayload, error) {
	if hasAuthorizerSignature(payload.Payload) {
		return payload, nil
	}
	delegated := getDelegatedAuthorizer(f.config, lc.extra.ReceiverAuthorizer)
	if delegated == nil {
		return payload, x402.NewVerifyError(ErrAuthorizerSignature, lc.paymentInfo.Payer, "authorizerSignature is required unless the authorizer is delegated to this facilitator")
	}
	return f.signDelegatedLifecycle(ctx, fctx, delegated, payload, requirements, lc)
}

// signDelegatedLifecycle authenticates a lifecycle request whose authorizer is delegated to this
// facilitator and signs it. The caller must resolve to the identity bound to the payment at
// authorize (or charge) time. Nothing is bound here.
func (f *AuthCaptureEvmScheme) signDelegatedLifecycle(
	ctx context.Context,
	fctx *x402.FacilitatorContext,
	delegated *delegatedAuthorizer,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	lc *lifecyclePreconditions,
) (types.PaymentPayload, error) {
	payer := lc.paymentInfo.Payer
	network := x402.Network(requirements.Network)
	operation, _ := payload.Payload["type"].(string)

	identity := resolveDelegatedCallerIdentity(ctx, delegated, DelegatedSettleContext{
		Step:               DelegatedStep(operation),
		PaymentInfoHash:    lc.paymentInfoHash,
		Network:            network,
		Payer:              payer,
		Payload:            payload,
		Requirements:       requirements,
		FacilitatorContext: fctx,
	})
	if identity == "" {
		return payload, x402.NewVerifyError(ErrUnauthenticatedAuthorizerRequest, payer, "")
	}

	binding, err := delegated.storage.Get(ctx, network, lc.paymentInfoHash)
	if err != nil {
		return payload, x402.NewVerifyError(ErrDelegatedAuthUnavailable, payer,
			"failed to read delegated auth binding: "+evm.TruncateErrorMessage(err.Error()))
	}
	if binding == nil || binding.ExpiresAt <= uint64(time.Now().Unix()) || binding.CallerIdentity != identity {
		return payload, x402.NewVerifyError(ErrUnauthenticatedAuthorizerRequest, payer, "")
	}

	signed := make(map[string]interface{}, len(payload.Payload)+2)
	for key, value := range payload.Payload {
		signed[key] = value
	}
	switch operation {
	case opVoid:
		signature, err := authcapture.SignVoid(ctx, delegated.signer, lc.extra.CaptureAuthorizer, lc.chainID, lc.paymentInfoHash)
		if err != nil {
			return payload, x402.NewVerifyError(ErrAuthorizerSignature, payer, err.Error())
		}
		signed["authorizerSignature"] = evm.BytesToHex(signature)
	case opRefund:
		p, err := authcapture.RefundPayloadFromMap(payload.Payload)
		if err != nil {
			return payload, x402.NewVerifyError(ErrPayloadFormat, payer, err.Error())
		}
		amount, amountOK := parseUint(p.Amount)
		expectedCapturable, capturableOK := parseUint(p.ExpectedCapturableAmount)
		expectedRefundable, refundableOK := parseUint(p.ExpectedRefundableAmount)
		if !amountOK || !capturableOK || !refundableOK {
			return payload, x402.NewVerifyError(ErrPayloadFormat, payer, "amount, expectedCapturableAmount and expectedRefundableAmount must be unsigned integers")
		}
		signature, err := authcapture.SignRefund(ctx, delegated.signer, lc.extra.CaptureAuthorizer, lc.chainID,
			authcapture.RefundParams{
				PaymentInfoHash:    lc.paymentInfoHash,
				Amount:             amount,
				TokenCollector:     lc.deployment.OperatorRefundCollector,
				ExpectedCapturable: expectedCapturable,
				ExpectedRefundable: expectedRefundable,
			})
		if err != nil {
			return payload, x402.NewVerifyError(ErrAuthorizerSignature, payer, err.Error())
		}
		signed["authorizerSignature"] = evm.BytesToHex(signature)
	case opCapture:
		p, err := authcapture.CapturePayloadFromMap(payload.Payload)
		if err != nil {
			return payload, x402.NewVerifyError(ErrPayloadFormat, payer, err.Error())
		}
		fee, ok := parseSubmittedFee(p.FeeBps, p.FeeAmount, &lc.deployment)
		if !ok {
			return payload, x402.NewVerifyError(ErrPayloadFormat, payer, "fee field does not match the deployment's fee encoding")
		}
		amount, amountOK := parseUint(p.Amount)
		expectedCapturable, capturableOK := parseUint(p.ExpectedCapturableAmount)
		expectedRefundable, refundableOK := parseUint(p.ExpectedRefundableAmount)
		if !amountOK || !capturableOK || !refundableOK {
			return payload, x402.NewVerifyError(ErrPayloadFormat, payer, "amount, expectedCapturableAmount and expectedRefundableAmount must be unsigned integers")
		}
		signature, err := authcapture.SignCapture(ctx, delegated.signer, &lc.deployment, lc.extra.CaptureAuthorizer, lc.chainID,
			authcapture.CaptureParams{
				PaymentInfoHash:    lc.paymentInfoHash,
				Amount:             amount,
				Fee:                fee,
				FeeReceiver:        p.FeeReceiver,
				ExpectedCapturable: expectedCapturable,
				ExpectedRefundable: expectedRefundable,
			})
		if err != nil {
			return payload, x402.NewVerifyError(ErrAuthorizerSignature, payer, err.Error())
		}
		signed["authorizerSignature"] = evm.BytesToHex(signature)
		delete(signed, "voidRemainder")
		if p.VoidRemainder {
			voidSignature, err := authcapture.SignVoid(ctx, delegated.signer, lc.extra.CaptureAuthorizer, lc.chainID, lc.paymentInfoHash)
			if err != nil {
				return payload, x402.NewVerifyError(ErrAuthorizerSignature, payer, err.Error())
			}
			signed["voidAuthorizerSignature"] = evm.BytesToHex(voidSignature)
		}
	default:
		return payload, x402.NewVerifyError(ErrPayloadType, payer, fmt.Sprintf("unexpected lifecycle payload type: %s", operation))
	}

	payload.Payload = signed
	return payload, nil
}

// delegatedLifecycle resolves the delegated authorizer and the identifiers of an unverified
// lifecycle payload. It returns a nil authorizer when the authorizer is not delegated to this
// facilitator, or when the payload or requirements are unreadable, which verification reports.
func (f *AuthCaptureEvmScheme) delegatedLifecycle(
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*delegatedAuthorizer, *lifecyclePreconditions) {
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	if err != nil {
		return nil, nil
	}
	delegated := getDelegatedAuthorizer(f.config, extra.ReceiverAuthorizer)
	if delegated == nil {
		return nil, nil
	}
	paymentInfo, err := lifecyclePaymentInfo(payload.Payload)
	if err != nil {
		return nil, nil
	}
	chainID, err := evm.GetEvmChainId(requirements.Network)
	if err != nil {
		return nil, nil
	}
	paymentInfoHash, err := authcapture.ComputePaymentInfoHash(chainID, paymentInfo, paymentInfo.Payer, deployment.Escrow)
	if err != nil {
		return nil, nil
	}
	return delegated, &lifecyclePreconditions{
		deployment:      deployment,
		extra:           extra,
		chainID:         chainID,
		paymentInfo:     paymentInfo,
		paymentInfoHash: paymentInfoHash,
	}
}

// lifecycleSettler settles an authorizer-signed lifecycle payload.
type lifecycleSettler func(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error)

// settleLifecycle re-verifies and settles a lifecycle payload. A delegated authorizer's signature
// is produced first, so the pending-settlement key derives from it and a retry reconciles.
func (f *AuthCaptureEvmScheme) settleLifecycle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
	settle lifecycleSettler,
) (*x402.SettleResponse, error) {
	delegated, lc := f.delegatedLifecycle(payload, requirements)

	settleable := payload
	if delegated != nil && !hasAuthorizerSignature(payload.Payload) {
		signed, err := f.signDelegatedLifecycle(ctx, fctx, delegated, payload, requirements, lc)
		if err != nil {
			return nil, toSettleError(err, x402.Network(payload.Accepted.Network), lc.paymentInfo.Payer)
		}
		settleable = signed
	}

	resp, err := settle(ctx, settleable, requirements, fctx)
	if err == nil && resp != nil && resp.Success && delegated != nil {
		f.releaseTerminalBinding(ctx, delegated, lc, requirements, settleable.Payload)
	}
	return resp, err
}

// releaseTerminalBinding deletes the caller binding once the payment has nothing left to relay:
// no capturable hold and nothing refundable. It is best effort, so a storage failure never fails
// a confirmed settle. Balances come from the signed expectations; a void leg is not known
// locally, so those cases read paymentState once, and a stale read just leaves the row to expire.
func (f *AuthCaptureEvmScheme) releaseTerminalBinding(
	ctx context.Context,
	delegated *delegatedAuthorizer,
	lc *lifecyclePreconditions,
	requirements types.PaymentRequirements,
	settled map[string]interface{},
) {
	var capturable, refundable *big.Int
	switch settled["type"] {
	case opRefund:
		p, err := authcapture.RefundPayloadFromMap(settled)
		if err != nil {
			return
		}
		amount, amountOK := parseUint(p.Amount)
		expectedCapturable, capturableOK := parseUint(p.ExpectedCapturableAmount)
		expectedRefundable, refundableOK := parseUint(p.ExpectedRefundableAmount)
		if !amountOK || !capturableOK || !refundableOK {
			return
		}
		capturable = expectedCapturable
		refundable = new(big.Int).Sub(expectedRefundable, amount)
	case opCapture:
		p, err := authcapture.CapturePayloadFromMap(settled)
		if err != nil {
			return
		}
		if p.VoidAuthorizerSignature == "" {
			amount, amountOK := parseUint(p.Amount)
			expectedCapturable, capturableOK := parseUint(p.ExpectedCapturableAmount)
			expectedRefundable, refundableOK := parseUint(p.ExpectedRefundableAmount)
			if !amountOK || !capturableOK || !refundableOK {
				return
			}
			capturable = new(big.Int).Sub(expectedCapturable, amount)
			refundable = new(big.Int).Add(expectedRefundable, amount)
		}
	}
	if capturable == nil {
		_, readCapturable, readRefundable, err := readPaymentState(ctx, f.signer, &lc.deployment, lc.paymentInfoHash)
		if err != nil {
			return
		}
		capturable, refundable = readCapturable, readRefundable
	}
	if capturable.Sign() != 0 || refundable.Sign() != 0 {
		return
	}

	network := x402.Network(requirements.Network)
	cleanupCtx, cancel := detachedCleanupContext(ctx)
	defer cancel()
	if err := delegated.storage.Delete(cleanupCtx, network, lc.paymentInfoHash); err != nil {
		reportDelegatedStorageError(delegated, err, network, lc.paymentInfoHash)
	}
}
