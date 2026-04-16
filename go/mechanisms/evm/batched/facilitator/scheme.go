package facilitator

import (
	"context"
	"fmt"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// BatchedEvmScheme implements SchemeNetworkFacilitator for batched settlement on EVM.
type BatchedEvmScheme struct {
	signer evm.FacilitatorEvmSigner
}

// NewBatchedEvmScheme creates a new batched settlement facilitator scheme.
func NewBatchedEvmScheme(signer evm.FacilitatorEvmSigner) *BatchedEvmScheme {
	return &BatchedEvmScheme{signer: signer}
}

// Scheme returns the scheme identifier.
func (f *BatchedEvmScheme) Scheme() string {
	return batched.SchemeBatched
}

// CaipFamily returns the CAIP family pattern this facilitator supports.
func (f *BatchedEvmScheme) CaipFamily() string {
	return "eip155:*"
}

// GetExtra returns mechanism-specific extra data for the supported kinds endpoint.
func (f *BatchedEvmScheme) GetExtra(_ x402.Network) map[string]interface{} {
	return nil
}

// GetSigners returns signer addresses used by this facilitator.
func (f *BatchedEvmScheme) GetSigners(_ x402.Network) []string {
	return f.signer.GetAddresses()
}

// Verify verifies a batched payment payload.
// Routes to deposit or voucher verification based on payload type.
func (f *BatchedEvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	data := payload.Payload

	if batched.IsDepositPayload(data) {
		depositPayload, err := batched.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidDepositPayload, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		return VerifyDeposit(ctx, f.signer, depositPayload, requirements)
	}

	if batched.IsVoucherPayload(data) {
		voucherPayload, err := batched.VoucherPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidVoucherPayload, "",
				fmt.Sprintf("failed to parse voucher payload: %s", err))
		}
		return VerifyVoucher(ctx, f.signer, voucherPayload, requirements, voucherPayload.ChannelConfig)
	}

	return nil, x402.NewVerifyError(ErrInvalidPayload, "",
		"payload is neither a deposit nor a voucher")
}

// Settle settles a batched payment on-chain.
// Routes based on payload type or settleAction field.
func (f *BatchedEvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	data := payload.Payload
	network := x402.Network(requirements.Network)

	// Check for deposit payload (type="deposit")
	if batched.IsDepositPayload(data) {
		depositPayload, err := batched.DepositPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, "",
				fmt.Sprintf("failed to parse deposit payload: %s", err))
		}
		return SettleDeposit(ctx, f.signer, depositPayload, requirements)
	}

	// Check for deposit settle action (settleAction="deposit")
	if batched.IsDepositSettlePayload(data) {
		depositSettlePayload, err := batched.DepositSettlePayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidDepositPayload, "", network, "",
				fmt.Sprintf("failed to parse deposit settle payload: %s", err))
		}
		// Convert to full deposit payload for settlement
		fullPayload := &batched.BatchedDepositPayload{
			Type:    "deposit",
			Deposit: depositSettlePayload.Deposit,
		}
		return SettleDeposit(ctx, f.signer, fullPayload, requirements)
	}

	// Route settle actions
	if batched.IsClaimPayload(data) {
		claimPayload, err := batched.ClaimPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
				fmt.Sprintf("failed to parse claim payload: %s", err))
		}
		return ExecuteClaim(ctx, f.signer, claimPayload, requirements)
	}

	if batched.IsClaimWithSignaturePayload(data) {
		claimPayload, err := batched.ClaimWithSignaturePayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
				fmt.Sprintf("failed to parse claim with signature payload: %s", err))
		}
		return ExecuteClaimWithSignature(ctx, f.signer, claimPayload, requirements)
	}

	if batched.IsSettleActionPayload(data) {
		settlePayload, err := batched.SettleActionPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidSettlePayload, "", network, "",
				fmt.Sprintf("failed to parse settle payload: %s", err))
		}
		return ExecuteSettle(ctx, f.signer, settlePayload, requirements)
	}

	if batched.IsRefundWithSignaturePayload(data) {
		refundPayload, err := batched.RefundWithSignaturePayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to parse refund with signature payload: %s", err))
		}
		return ExecuteRefundWithSignature(ctx, f.signer, refundPayload, requirements)
	}

	if batched.IsRefundPayload(data) {
		refundPayload, err := batched.RefundPayloadFromMap(data)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to parse refund payload: %s", err))
		}
		return ExecuteRefund(ctx, f.signer, refundPayload, requirements)
	}

	return nil, x402.NewSettleError(ErrUnknownSettleAction, "", network, "",
		"unrecognized batched settle action or payload type")
}
