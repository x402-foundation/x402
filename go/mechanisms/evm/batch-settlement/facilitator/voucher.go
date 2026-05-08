package facilitator

import (
	"context"
	"fmt"
	"math/big"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
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
	return verifyVoucherFields(ctx, signer, &payload.Voucher, channelConfig, requirements, false)
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
	return verifyVoucherFields(ctx, signer, &payload.Voucher, channelConfig, requirements, true)
}

func verifyVoucherFields(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	voucher *batchsettlement.BatchSettlementVoucherFields,
	channelConfig batchsettlement.ChannelConfig,
	requirements types.PaymentRequirements,
	isRefund bool,
) (*x402.VerifyResponse, error) {
	if err := ValidateChannelConfig(channelConfig, voucher.ChannelId, requirements); err != nil {
		return nil, err
	}

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
	// vouchers must strictly increase claimable above totalClaimed.
	belowClaimed := false
	if isRefund {
		belowClaimed = maxClaimable.Cmp(state.TotalClaimed) < 0
	} else {
		belowClaimed = maxClaimable.Cmp(state.TotalClaimed) <= 0
	}
	if belowClaimed {
		return nil, x402.NewVerifyError(ErrMaxClaimableTooLow, channelConfig.Payer,
			fmt.Sprintf("maxClaimableAmount %s is below totalClaimed %s", maxClaimable.String(), state.TotalClaimed.String()))
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
