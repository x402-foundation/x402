package facilitator

import (
	"context"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// refundPreconditions is the verified state verifyRefund derives and settleRefund reuses.
type refundPreconditions struct {
	lifecycle *lifecyclePreconditions
	amount    *big.Int
}

// refundArgs are the AuthCaptureEscrow.refund arguments after the paymentInfo: the refund
// collector pulls the refunded tokens from the operator, so it takes no collector data.
func (pre *refundPreconditions) refundArgs() []interface{} {
	return []interface{}{pre.amount, common.HexToAddress(pre.lifecycle.deployment.OperatorRefundCollector), []byte{}}
}

// checkRefundPreconditions validates a refund payload per the spec's Lifecycle payloads checklist.
// The authorizer signature and deadline are checked before the payment state is read.
func (f *AuthCaptureEvmScheme) checkRefundPreconditions(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*refundPreconditions, error) {
	p, err := authcapture.RefundPayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, "", err.Error())
	}
	payer := p.PaymentInfo.Payer

	lc, err := f.checkLifecycleCommon(payload, requirements, p.PaymentInfo, p.SaltNonce, opRefund)
	if err != nil {
		return nil, err
	}
	signed, err := f.signedLifecyclePayload(ctx, fctx, payload, requirements, lc)
	if err != nil {
		return nil, err
	}
	if p, err = authcapture.RefundPayloadFromMap(signed.Payload); err != nil {
		return nil, x402.NewVerifyError(ErrPayloadFormat, payer, err.Error())
	}

	amount, amountOK := parseUint(p.Amount)
	expectedCapturable, capturableOK := parseUint(p.ExpectedCapturableAmount)
	expectedRefundable, refundableOK := parseUint(p.ExpectedRefundableAmount)
	if !amountOK || !capturableOK || !refundableOK {
		return nil, x402.NewVerifyError(ErrPayloadFormat, payer, "amount, expectedCapturableAmount and expectedRefundableAmount must be unsigned integers")
	}

	signature, err := evm.HexToBytes(p.AuthorizerSignature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrAuthorizerSignature, payer, err.Error())
	}
	valid, err := authcapture.VerifyRefund(ctx, f.signer, lc.extra.ReceiverAuthorizer, lc.extra.CaptureAuthorizer, lc.chainID,
		authcapture.RefundParams{
			PaymentInfoHash:    lc.paymentInfoHash,
			Amount:             amount,
			TokenCollector:     lc.deployment.OperatorRefundCollector,
			ExpectedCapturable: expectedCapturable,
			ExpectedRefundable: expectedRefundable,
		}, signature)
	if err != nil {
		return nil, x402.NewVerifyError(ErrAuthorizerSignature, payer, err.Error())
	}
	if !valid {
		return nil, x402.NewVerifyError(ErrAuthorizerSignature, payer, "authorizer signature invalid")
	}
	if uint64(time.Now().Unix()) >= p.PaymentInfo.RefundExpiry {
		return nil, x402.NewVerifyError(ErrRefundDeadlineExpired, payer, "refundExpiry has passed")
	}

	if err := f.loadCollectedState(ctx, lc); err != nil {
		return nil, err
	}
	if !lc.balancesMatch(expectedCapturable, expectedRefundable) {
		return nil, x402.NewVerifyError(ErrUnexpectedPaymentState, payer, "expected capturable/refundable amount is stale")
	}
	if amount.Sign() <= 0 || amount.Cmp(lc.refundableAmount) > 0 {
		return nil, x402.NewVerifyError(ErrRefundExceedsCapture, payer, "amount must be > 0 and <= refundableAmount")
	}
	return &refundPreconditions{lifecycle: lc, amount: amount}, nil
}

// verifyRefund validates a refund payload and simulates it.
func (f *AuthCaptureEvmScheme) verifyRefund(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	pre, err := f.checkRefundPreconditions(ctx, payload, requirements, fctx)
	if err != nil {
		return nil, err
	}
	if err := f.simulateLifecycle(ctx, pre.lifecycle, opRefund, pre.refundArgs()...); err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: pre.lifecycle.paymentInfo.Payer}, nil
}

// settleRefund submits the refund call for a refund payload.
func (f *AuthCaptureEvmScheme) settleRefund(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)
	if resp, err := f.resumePending(ctx, payload, requirements, nil); resp != nil || err != nil {
		return resp, err
	}

	pre, err := f.checkRefundPreconditions(ctx, payload, requirements, fctx)
	if err != nil {
		return nil, toSettleError(err, network, "")
	}
	payer := pre.lifecycle.paymentInfo.Payer
	if f.config.SimulateInSettle {
		if err := f.simulateLifecycle(ctx, pre.lifecycle, opRefund, pre.refundArgs()...); err != nil {
			return nil, toSettleError(err, network, payer)
		}
	}

	txHash, err := f.writeLifecycle(ctx, fctx, payload, requirements, pre.lifecycle, opRefund, pre.refundArgs()...)
	if err != nil {
		return nil, err
	}
	return f.awaitSettlement(ctx, payload, requirements, payer, txHash, nil)
}
