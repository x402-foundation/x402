package facilitator

import (
	"context"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// RefundConsentDeps is the caller-identity wiring that CheckDelegatedRefundConsent needs
// (facilitator-managed mode only).
type RefundConsentDeps struct {
	ResolveCallerIdentity ResolveCallerIdentity
	DelegatedAuthStore    storage.DelegatedAuthStore
}

// RefundConsentAmounts is the refund amount and onchain nonce the Refund digest is signed over.
type RefundConsentAmounts struct {
	Amount string
	Nonce  string
}

// StripAuthorizerSignatures returns a copy of payload without the client-supplied
// refundAuthorizerSignature / claimAuthorizerSignature so the facilitator signs the onchain
// Refund and ClaimBatch digests itself. Facilitator-managed mode only: call it after consent
// has been established.
func StripAuthorizerSignatures(payload *batchsettlement.BatchSettlementEnrichedRefundPayload) *batchsettlement.BatchSettlementEnrichedRefundPayload {
	stripped := *payload
	stripped.RefundAuthorizerSignature = ""
	stripped.ClaimAuthorizerSignature = ""
	return &stripped
}

// CheckDelegatedRefundConsent checks the server's consent to a facilitator-managed cooperative
// refund. The facilitator is always the channel's receiverAuthorizer in that mode; self-managed
// refunds do not use it. It returns an error code, or "" when consent is valid.
//
// Consent is selected by the 402's extra.refundAuthorizer:
//   - Absent: the server relies on the facilitator's delegatedRefund. The /settle caller must
//     resolve to the identity bound to the channel at deposit. No signature is expected.
//   - Present: let R be the refund authorizer unpacked from channelConfig.salt. R must equal
//     extra.refundAuthorizer (ErrRefundAuthorizerMismatch), and refundAuthorizerSignature must
//     recover to R over the EIP-712 Refund digest.
func CheckDelegatedRefundConsent(
	ctx context.Context,
	deps RefundConsentDeps,
	payment types.PaymentPayload,
	raw *batchsettlement.BatchSettlementEnrichedRefundPayload,
	refund RefundConsentAmounts,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) string {
	announced, _ := requirements.Extra["refundAuthorizer"].(string)
	if announced == "" {
		return checkRefundCallerIdentity(ctx, deps, payment, raw, refund.Amount, requirements, fctx)
	}
	channelRefundAuthorizer := batchsettlement.UnpackRefundAuthorizer(raw.ChannelConfig.Salt)
	if !common.IsHexAddress(announced) || !sameAddress(channelRefundAuthorizer, announced) {
		return ErrRefundAuthorizerMismatch
	}
	return checkRefundSignature(raw, refund, channelRefundAuthorizer, requirements)
}

// checkRefundSignature requires refundAuthorizerSignature to recover to the channel's refund authorizer.
func checkRefundSignature(
	raw *batchsettlement.BatchSettlementEnrichedRefundPayload,
	refund RefundConsentAmounts,
	refundAuthorizer string,
	requirements types.PaymentRequirements,
) string {
	if raw.RefundAuthorizerSignature == "" {
		return ErrRefundAuthorizerSignature
	}
	if !verifyRefundAuthorizerSignature(
		raw.RefundAuthorizerSignature,
		refundAuthorizer,
		raw.Voucher.ChannelId,
		refund.Amount,
		refund.Nonce,
		requirements.Network,
	) {
		return ErrRefundAuthorizerSignature
	}
	return ""
}

// checkRefundCallerIdentity requires the /settle caller to resolve to the identity bound to the
// channel at deposit. Missing hooks, bindings, store errors and identity mismatches all fail closed.
func checkRefundCallerIdentity(
	ctx context.Context,
	deps RefundConsentDeps,
	payment types.PaymentPayload,
	raw *batchsettlement.BatchSettlementEnrichedRefundPayload,
	amount string,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) string {
	if deps.ResolveCallerIdentity == nil || deps.DelegatedAuthStore == nil {
		return ErrRefundAuthorizerSignature
	}
	identity, err := deps.ResolveCallerIdentity(DelegatedSettleContext{
		Ctx:                ctx,
		Step:               DelegatedSettleStepRefund,
		ChannelId:          raw.Voucher.ChannelId,
		Network:            requirements.Network,
		Payer:              raw.ChannelConfig.Payer,
		Amount:             amount,
		Payload:            payment,
		Requirements:       requirements,
		FacilitatorContext: fctx,
	})
	if err != nil || identity == "" {
		return ErrRefundAuthorizerSignature
	}
	binding, err := deps.DelegatedAuthStore.Get(ctx, raw.Voucher.ChannelId, requirements.Network)
	if err != nil || binding == nil || binding.CallerIdentity != identity {
		return ErrRefundAuthorizerSignature
	}
	return ""
}
