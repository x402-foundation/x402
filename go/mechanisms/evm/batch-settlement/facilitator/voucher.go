package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// VerifyVoucher verifies a batched voucher-only payload.
// Checks voucher signature, reads onchain channel state, validates cumulative ceiling.
func VerifyVoucher(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementVoucherPayload,
	requirements types.PaymentRequirements,
	channelConfig batchsettlement.ChannelConfig,
) (*x402.VerifyResponse, error) {
	return verifyVoucherFields(ctx, signer, &payload.Voucher, channelConfig, requirements, false, eoaSignatureClearance{})
}

// VerifyRefundVoucher verifies a cooperative-refund payload's voucher.
// The voucher is zero-charge: maxClaimableAmount == chargedCumulativeAmount,
// which on a fresh channel may equal totalClaimed exactly.
func VerifyRefundVoucher(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementRefundPayload,
	requirements types.PaymentRequirements,
	channelConfig batchsettlement.ChannelConfig,
) (*x402.VerifyResponse, error) {
	return verifyVoucherFields(ctx, signer, &payload.Voucher, channelConfig, requirements, true, eoaSignatureClearance{})
}

// eoaSignatureClearance is a voucher whose payerAuthorizer ECDSA signature already passed.
// The zero value allows nothing.
type eoaSignatureClearance struct {
	channelId    string
	maxClaimable string
	signature    string
}

func (c eoaSignatureClearance) allows(voucher *batchsettlement.BatchSettlementVoucherFields) bool {
	return c.signature != "" &&
		c.channelId == voucher.ChannelId &&
		c.maxClaimable == voucher.MaxClaimableAmount &&
		c.signature == voucher.Signature
}

// parseVoucherOrRefund returns the voucher and channel config of a voucher or refund payload,
// or nil for a deposit.
func parseVoucherOrRefund(raw map[string]interface{}) (*batchsettlement.BatchSettlementVoucherPayload, error) {
	switch {
	case batchsettlement.IsVoucherPayload(raw):
		return batchsettlement.VoucherPayloadFromMap(raw)
	case batchsettlement.IsRefundPayload(raw):
		refund, err := batchsettlement.RefundPayloadFromMap(raw)
		if err != nil {
			return nil, err
		}
		return &batchsettlement.BatchSettlementVoucherPayload{ChannelConfig: refund.ChannelConfig, Voucher: refund.Voucher}, nil
	default:
		return nil, nil
	}
}

// eoaClearance verifies a voucher's EOA signature without state. A nil payload (deposit) or a
// zero-address authorizer returns the zero clearance; a bad signature returns a reason.
func eoaClearance(vp *batchsettlement.BatchSettlementVoucherPayload, network string) (eoaSignatureClearance, string) {
	if vp == nil || strings.EqualFold(vp.ChannelConfig.PayerAuthorizer, zeroAddress) {
		return eoaSignatureClearance{}, ""
	}
	if !batchsettlement.VerifyEoaVoucherSignature(vp, network) {
		return eoaSignatureClearance{}, ErrVoucherSignatureInvalid
	}
	return eoaSignatureClearance{
		channelId:    vp.Voucher.ChannelId,
		maxClaimable: vp.Voucher.MaxClaimableAmount,
		signature:    vp.Voucher.Signature,
	}, ""
}

func verifyVoucherFields(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	voucher *batchsettlement.BatchSettlementVoucherFields,
	channelConfig batchsettlement.ChannelConfig,
	requirements types.PaymentRequirements,
	isRefund bool,
	clearance eoaSignatureClearance,
) (*x402.VerifyResponse, error) {
	if err := ValidateChannelConfig(channelConfig, voucher.ChannelId, requirements); err != nil {
		return nil, err
	}

	// Refunds are zero-charge and never consult the price; every other payload is floored by it.
	price := new(big.Int)
	if !isRefund {
		var ok bool
		price, ok = parseRequirementsAmount(requirements.Amount)
		if !ok {
			return nil, x402.NewVerifyError(ErrInvalidVoucherPayload, channelConfig.Payer,
				"invalid requirements amount")
		}
	}

	if !clearance.allows(voucher) {
		chainId, err := signer.GetChainID(ctx)
		if err != nil {
			return nil, x402.NewVerifyError(ErrChannelStateReadFailed, "", fmt.Sprintf("failed to get chain ID: %s", err))
		}

		valid, err := VerifyBatchedVoucherTypedData(
			ctx, signer,
			voucher.ChannelId,
			voucher.MaxClaimableAmount,
			channelConfig.PayerAuthorizer,
			channelConfig.Payer,
			voucher.Signature,
			chainId,
		)
		if err != nil {
			return nil, x402.NewVerifyError(ErrVoucherSignatureInvalid, channelConfig.Payer,
				fmt.Sprintf("voucher signature verification failed: %s", err))
		}
		if !valid {
			return nil, x402.NewVerifyError(ErrVoucherSignatureInvalid, channelConfig.Payer,
				"voucher signature is invalid")
		}
	}

	state, err := ReadChannelState(ctx, signer, voucher.ChannelId)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, channelConfig.Payer,
			fmt.Sprintf("failed to read channel state: %s", err))
	}

	// A non-existent or fully-drained channel reports balance==0 onchain
	if state.Balance.Sign() == 0 {
		return nil, x402.NewVerifyError(ErrChannelNotFound, channelConfig.Payer,
			fmt.Sprintf("channel %s not found or fully drained (balance=0)", voucher.ChannelId))
	}

	maxClaimable, ok := new(big.Int).SetString(voucher.MaxClaimableAmount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidVoucherPayload, channelConfig.Payer,
			"invalid maxClaimableAmount")
	}

	// Refund vouchers are zero-charge and may equal totalClaimed; non-refund
	// vouchers must advance claimable by at least the route price above totalClaimed,
	// and always strictly above it (even when the price is zero).
	minMaxClaimable := new(big.Int).Set(state.TotalClaimed)
	if !isRefund {
		minMaxClaimable.Add(minMaxClaimable, price)
	}
	if maxClaimable.Cmp(minMaxClaimable) < 0 || (!isRefund && maxClaimable.Cmp(state.TotalClaimed) <= 0) {
		return nil, x402.NewVerifyError(ErrMaxClaimableTooLow, channelConfig.Payer,
			fmt.Sprintf("maxClaimableAmount %s is below the required minimum %s (totalClaimed %s)",
				maxClaimable.String(), minMaxClaimable.String(), state.TotalClaimed.String()))
	}

	if maxClaimable.Cmp(state.Balance) > 0 {
		return nil, x402.NewVerifyError(ErrMaxClaimableExceedsBal, channelConfig.Payer,
			fmt.Sprintf("maxClaimableAmount %s exceeds balance %s", maxClaimable.String(), state.Balance.String()))
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   channelConfig.Payer,
		Extra:   BuildVerifyExtra(voucher.ChannelId, state),
	}, nil
}
