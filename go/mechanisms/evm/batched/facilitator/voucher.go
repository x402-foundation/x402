package facilitator

import (
	"context"
	"fmt"
	"math/big"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// VerifyVoucher verifies a batched voucher-only payload.
// Checks voucher signature, reads on-chain channel state, validates cumulative ceiling.
func VerifyVoucher(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedVoucherPayload,
	requirements types.PaymentRequirements,
	channelConfig batched.ChannelConfig,
) (*x402.VerifyResponse, error) {
	// Validate channel config
	if err := ValidateChannelConfig(channelConfig, payload.ChannelId, requirements); err != nil {
		return nil, err
	}

	// Get chain ID
	chainId, err := signer.GetChainID(ctx)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, "", fmt.Sprintf("failed to get chain ID: %s", err))
	}

	// Verify voucher signature
	valid, err := VerifyBatchedVoucherTypedData(
		ctx, signer,
		payload.ChannelId,
		payload.MaxClaimableAmount,
		channelConfig.PayerAuthorizer,
		channelConfig.Payer,
		payload.Signature,
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

	// Read on-chain channel state
	state, err := ReadChannelState(ctx, signer, payload.ChannelId)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelStateReadFailed, channelConfig.Payer,
			fmt.Sprintf("failed to read channel state: %s", err))
	}

	// Check maxClaimableAmount >= totalClaimed (monotonic increase)
	maxClaimable, ok := new(big.Int).SetString(payload.MaxClaimableAmount, 10)
	if !ok {
		return nil, x402.NewVerifyError(ErrInvalidVoucherPayload, channelConfig.Payer,
			"invalid maxClaimableAmount")
	}
	if maxClaimable.Cmp(state.TotalClaimed) < 0 {
		return nil, x402.NewVerifyError(ErrMaxClaimableTooLow, channelConfig.Payer,
			fmt.Sprintf("maxClaimableAmount %s is below totalClaimed %s", maxClaimable.String(), state.TotalClaimed.String()))
	}

	// Check maxClaimableAmount <= balance
	if maxClaimable.Cmp(state.Balance) > 0 {
		return nil, x402.NewVerifyError(ErrMaxClaimableExceedsBal, channelConfig.Payer,
			fmt.Sprintf("maxClaimableAmount %s exceeds balance %s", maxClaimable.String(), state.Balance.String()))
	}

	return &x402.VerifyResponse{
		IsValid:    true,
		Payer:      channelConfig.Payer,
		Extensions: BuildChannelStateExtra(payload.ChannelId, payload.MaxClaimableAmount, state),
	}, nil
}
