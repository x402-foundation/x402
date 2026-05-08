package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// ExecuteClaimWithSignature executes a batch claim with receiverAuthorizer signature.
// If ClaimAuthorizerSignature is absent from the payload, the authorizerSigner
// auto-signs the ClaimBatch digest.
func ExecuteClaimWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementClaimPayload,
	requirements types.PaymentRequirements,
	authorizerSigner batchsettlement.AuthorizerSigner,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	if len(payload.Claims) == 0 {
		return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
			"no claims provided")
	}

	// Resolve signature — auto-sign if absent
	var sigBytes []byte
	if payload.ClaimAuthorizerSignature != "" {
		var err error
		sigBytes, err = evm.HexToBytes(payload.ClaimAuthorizerSignature)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidClaimPayload, "", network, "",
				fmt.Sprintf("invalid claim authorizer signature: %s", err))
		}
	} else {
		// Verify authorizer address matches all claims' receiverAuthorizer
		for _, claim := range payload.Claims {
			if !strings.EqualFold(claim.Voucher.Channel.ReceiverAuthorizer, authorizerSigner.Address()) {
				return nil, x402.NewSettleError(ErrAuthorizerAddressMismatch, "", network, "",
					fmt.Sprintf("claim receiverAuthorizer %s does not match authorizerSigner %s",
						claim.Voucher.Channel.ReceiverAuthorizer, authorizerSigner.Address()))
			}
		}
		// Auto-sign
		var err error
		sigBytes, err = authorizerSigner.SignClaimBatch(ctx, payload.Claims, string(network))
		if err != nil {
			return nil, x402.NewSettleError(ErrClaimTransactionFailed, "", network, "",
				fmt.Sprintf("failed to sign claim batch: %s", err))
		}
	}

	claimArgs := buildVoucherClaimArgs(payload.Claims)

	// Simulate the transaction before submitting
	if _, simErr := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementClaimWithSignatureABI,
		"claimWithSignature",
		claimArgs,
		sigBytes,
	); simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:      false,
			ErrorReason:  ErrClaimSimulationFailed,
			ErrorMessage: simErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementClaimWithSignatureABI,
		"claimWithSignature",
		claimArgs,
		sigBytes,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrClaimTransactionFailed, "", network, "",
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
func buildVoucherClaimArgs(claims []batchsettlement.BatchSettlementVoucherClaim) interface{} {
	type VoucherStruct struct {
		Channel            ContractChannelConfigTuple
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

		channelTuple := ToContractChannelConfig(claim.Voucher.Channel)

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
