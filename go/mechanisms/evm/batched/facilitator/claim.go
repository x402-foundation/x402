package facilitator

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// ExecuteClaim executes a batch claim on-chain (msg.sender must be receiver or receiverAuthorizer).
func ExecuteClaim(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedClaimPayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	if len(payload.Claims) == 0 {
		return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
			"no claims provided")
	}

	claimArgs := buildVoucherClaimArgs(payload.Claims)

	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementClaimABI,
		"claim",
		claimArgs,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, "", network, "",
			fmt.Sprintf("claim transaction failed: %s", err))
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
			fmt.Sprintf("failed waiting for claim receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
			"claim transaction reverted")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
	}, nil
}

// ExecuteClaimWithSignature executes a batch claim with receiverAuthorizer signature.
func ExecuteClaimWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedClaimWithSignaturePayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	if len(payload.Claims) == 0 {
		return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
			"no claims provided")
	}

	sigBytes, err := evm.HexToBytes(payload.AuthorizerSignature)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
			fmt.Sprintf("invalid authorizer signature: %s", err))
	}

	claimArgs := buildVoucherClaimArgs(payload.Claims)

	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementClaimWithSignatureABI,
		"claimWithSignature",
		claimArgs,
		sigBytes,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, "", network, "",
			fmt.Sprintf("claimWithSignature transaction failed: %s", err))
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
			fmt.Sprintf("failed waiting for claimWithSignature receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
			"claimWithSignature transaction reverted")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
	}, nil
}

// buildVoucherClaimArgs builds the Solidity-compatible VoucherClaim[] argument for claim calls.
func buildVoucherClaimArgs(claims []batched.BatchedVoucherClaim) interface{} {
	type VoucherStruct struct {
		Channel            interface{}
		MaxClaimableAmount *big.Int
	}
	type VoucherClaimStruct struct {
		Voucher      VoucherStruct
		Signature    []byte
		TotalClaimed *big.Int
	}

	result := make([]VoucherClaimStruct, len(claims))
	for i, claim := range claims {
		maxClaimable, _ := new(big.Int).SetString(claim.Voucher.MaxClaimableAmount, 10)
		totalClaimed, _ := new(big.Int).SetString(claim.TotalClaimed, 10)
		sigBytes, _ := evm.HexToBytes(claim.Signature)

		withdrawDelay := new(big.Int).SetInt64(int64(claim.Voucher.Channel.WithdrawDelay))
		saltBytes := common.FromHex(claim.Voucher.Channel.Salt)
		var salt [32]byte
		copy(salt[:], saltBytes)

		channelTuple := struct {
			Payer              common.Address
			PayerAuthorizer    common.Address
			Receiver           common.Address
			ReceiverAuthorizer common.Address
			Token              common.Address
			WithdrawDelay      *big.Int
			Salt               [32]byte
		}{
			Payer:              common.HexToAddress(claim.Voucher.Channel.Payer),
			PayerAuthorizer:    common.HexToAddress(claim.Voucher.Channel.PayerAuthorizer),
			Receiver:           common.HexToAddress(claim.Voucher.Channel.Receiver),
			ReceiverAuthorizer: common.HexToAddress(claim.Voucher.Channel.ReceiverAuthorizer),
			Token:              common.HexToAddress(claim.Voucher.Channel.Token),
			WithdrawDelay:      withdrawDelay,
			Salt:               salt,
		}

		result[i] = VoucherClaimStruct{
			Voucher: VoucherStruct{
				Channel:            channelTuple,
				MaxClaimableAmount: maxClaimable,
			},
			Signature:    sigBytes,
			TotalClaimed: totalClaimed,
		}
	}
	return result
}
