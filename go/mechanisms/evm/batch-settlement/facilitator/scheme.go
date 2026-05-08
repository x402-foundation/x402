package facilitator

import (
	"context"
	"fmt"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// BatchSettlementEvmScheme implements SchemeNetworkFacilitator for batch settlement on EVM.
type BatchSettlementEvmScheme struct {
	signer           evm.FacilitatorEvmSigner
	authorizerSigner batchsettlement.AuthorizerSigner
}

// NewBatchSettlementEvmScheme creates a new batch settlement facilitator scheme.
// The authorizerSigner is a dedicated key that provides EIP-712 signatures for
// claimWithSignature / refundWithSignature. The facilitator auto-signs when the
// server omits signatures from the payload.
func NewBatchSettlementEvmScheme(signer evm.FacilitatorEvmSigner, authorizerSigner batchsettlement.AuthorizerSigner) *BatchSettlementEvmScheme {
	return &BatchSettlementEvmScheme{signer: signer, authorizerSigner: authorizerSigner}
}

// Scheme returns the scheme identifier.
func (f *BatchSettlementEvmScheme) Scheme() string {
	return batchsettlement.SchemeBatched
}

// CaipFamily returns the CAIP family pattern this facilitator supports.
func (f *BatchSettlementEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
// Exposes the receiverAuthorizer address so server and client can embed it in ChannelConfig.
func (f *BatchSettlementEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	return map[string]interface{}{
		"receiverAuthorizer": f.authorizerSigner.Address(),
	}
}

// GetSigners returns signer addresses used by this facilitator.
func (f *BatchSettlementEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a batched payment payload.
// Routes to deposit or voucher verification based on payload type.
func (f *BatchSettlementEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	// Defensive scheme and network validation.
	if payload.Accepted.Scheme != batchsettlement.SchemeBatched || requirements.Scheme != batchsettlement.SchemeBatched {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidScheme}, nil
	}
	if payload.Accepted.Network != requirements.Network {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrNetworkMismatch}, nil
	}

	data := payload.Payload

	if batchsettlement.IsDepositPayload(data) {
		depositPayload, err := batchsettlement.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidDepositPayload, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		return VerifyDeposit(ctx, f.signer, depositPayload, requirements, payload.Extensions, fctx)
	}

	if batchsettlement.IsVoucherPayload(data) {
		voucherPayload, err := batchsettlement.VoucherPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidVoucherPayload, "",
				fmt.Sprintf("failed to parse voucher payload: %s", err))
		}
		return VerifyVoucher(ctx, f.signer, voucherPayload, requirements, voucherPayload.ChannelConfig)
	}

	// Cooperative refund: client sends a zero-charge voucher with type="refund".
	// Refund and voucher payloads share the same voucher-verification path with
	// a refund-aware cumulative check.
	if batchsettlement.IsRefundPayload(data) {
		refundPayload, err := batchsettlement.RefundPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidRefundPayload, "",
				fmt.Sprintf("failed to parse refund payload: %s", err))
		}
		return VerifyRefundVoucher(ctx, f.signer, refundPayload, requirements, refundPayload.ChannelConfig)
	}

	return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidPayload}, nil
}

// Settle settles a batched payment onchain.
// Routes based on payload type or settleAction field.
func (f *BatchSettlementEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	data := payload.Payload
	network := x402.Network(requirements.Network)

	// Check for deposit payload (type="deposit")
	if batchsettlement.IsDepositPayload(data) {
		depositPayload, err := batchsettlement.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		return SettleDeposit(ctx, f.signer, depositPayload, requirements, payload.Extensions, fctx)
	}

	// Enriched refund settle-action (must be checked BEFORE plain claim, since both
	// have type="refund" but enriched also has claims+amount+refundNonce).
	if batchsettlement.IsEnrichedRefundPayload(data) {
		refundPayload, err := batchsettlement.EnrichedRefundPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to parse refund payload: %s", err))
		}
		return ExecuteRefundWithSignature(ctx, f.signer, refundPayload, requirements, f.authorizerSigner)
	}

	if batchsettlement.IsClaimPayload(data) {
		claimPayload, err := batchsettlement.ClaimPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
				fmt.Sprintf("failed to parse claim payload: %s", err))
		}
		return ExecuteClaimWithSignature(ctx, f.signer, claimPayload, requirements, f.authorizerSigner)
	}

	if batchsettlement.IsSettlePayload(data) {
		settlePayload, err := batchsettlement.SettlePayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidSettlePayload, "", network, "",
				fmt.Sprintf("failed to parse settle payload: %s", err))
		}
		return ExecuteSettle(ctx, f.signer, settlePayload, requirements)
	}

	return nil, x402.NewSettleError(ErrUnknownSettleAction, "", network, "",
		"unrecognized batch-settlement settle action or payload type")
}
