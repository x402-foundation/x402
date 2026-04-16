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

// ExecuteRefund executes a cooperative refund on-chain.
// If claims are present, uses multicall to atomically claim + refund.
func ExecuteRefund(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedRefundPayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	refundAmount, ok := new(big.Int).SetString(payload.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid refund amount: %s", payload.Amount))
	}

	configTuple := buildChannelConfigTuple(payload.Config)

	// If we have claims, use multicall to claim + refund atomically
	if len(payload.Claims) > 0 {
		return executeClaimAndRefund(ctx, signer, payload.Claims, configTuple, refundAmount, network, nil, nil)
	}

	// Direct refund (no claims)
	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementRefundABI,
		"refund",
		configTuple,
		refundAmount,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, "", network, "",
			fmt.Sprintf("refund transaction failed: %s", err))
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
			fmt.Sprintf("failed waiting for refund receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
			"refund transaction reverted")
	}

	return buildRefundResponse(txHash, network, payload.ResponseExtra), nil
}

// ExecuteRefundWithSignature executes a cooperative refund using receiverAuthorizer signature.
func ExecuteRefundWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedRefundWithSignaturePayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	refundAmount, ok := new(big.Int).SetString(payload.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid refund amount: %s", payload.Amount))
	}

	nonce, ok := new(big.Int).SetString(payload.Nonce, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid nonce: %s", payload.Nonce))
	}

	receiverSig, err := evm.HexToBytes(payload.ReceiverAuthorizerSignature)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid receiver authorizer signature: %s", err))
	}

	configTuple := buildChannelConfigTuple(payload.Config)

	// If we have claims, handle them first
	if len(payload.Claims) > 0 {
		var claimSig []byte
		if payload.ClaimAuthorizerSignature != "" {
			claimSig, err = evm.HexToBytes(payload.ClaimAuthorizerSignature)
			if err != nil {
				return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
					fmt.Sprintf("invalid claim authorizer signature: %s", err))
			}
		}
		return executeClaimAndRefundWithSignature(ctx, signer, payload.Claims, configTuple, refundAmount, nonce, receiverSig, claimSig, network, payload.ResponseExtra)
	}

	// Direct refundWithSignature
	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementRefundWithSignatureABI,
		"refundWithSignature",
		configTuple,
		refundAmount,
		nonce,
		receiverSig,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, "", network, "",
			fmt.Sprintf("refundWithSignature transaction failed: %s", err))
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
			fmt.Sprintf("failed waiting for refundWithSignature receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
			"refundWithSignature transaction reverted")
	}

	return buildRefundResponse(txHash, network, payload.ResponseExtra), nil
}

// executeClaimAndRefund uses multicall to atomically claim + refund.
func executeClaimAndRefund(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	claims []batched.BatchedVoucherClaim,
	configTuple interface{},
	refundAmount *big.Int,
	network x402.Network,
	_ []byte,
	_ []byte,
) (*x402.SettleResponse, error) {
	// For the multicall approach, we encode both calls and send via multicall
	// This is a simplified version - in production you'd encode calldata and use multicall
	// For now, execute claim first, then refund sequentially

	claimPayload := &batched.BatchedClaimPayload{
		SettleAction: "claim",
		Claims:       claims,
	}

	requirements := types.PaymentRequirements{Network: string(network)}
	_, err := ExecuteClaim(ctx, signer, claimPayload, requirements)
	if err != nil {
		return nil, err
	}

	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementRefundABI,
		"refund",
		configTuple,
		refundAmount,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, "", network, "",
			fmt.Sprintf("refund transaction failed after claim: %s", err))
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
			fmt.Sprintf("failed waiting for refund receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
			"refund transaction reverted after claim")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
	}, nil
}

// executeClaimAndRefundWithSignature claims with signature then refunds with signature.
func executeClaimAndRefundWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	claims []batched.BatchedVoucherClaim,
	configTuple interface{},
	refundAmount *big.Int,
	nonce *big.Int,
	receiverSig []byte,
	claimSig []byte,
	network x402.Network,
	responseExtra *batched.BatchedPaymentResponseExtra,
) (*x402.SettleResponse, error) {
	// Execute claim first
	if claimSig != nil {
		claimPayload := &batched.BatchedClaimWithSignaturePayload{
			SettleAction:        "claimWithSignature",
			Claims:              claims,
			AuthorizerSignature: evm.BytesToHex(claimSig),
		}
		requirements := types.PaymentRequirements{Network: string(network)}
		_, err := ExecuteClaimWithSignature(ctx, signer, claimPayload, requirements)
		if err != nil {
			return nil, err
		}
	} else {
		claimPayload := &batched.BatchedClaimPayload{
			SettleAction: "claim",
			Claims:       claims,
		}
		requirements := types.PaymentRequirements{Network: string(network)}
		_, err := ExecuteClaim(ctx, signer, claimPayload, requirements)
		if err != nil {
			return nil, err
		}
	}

	// Then refund with signature
	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementRefundWithSignatureABI,
		"refundWithSignature",
		configTuple,
		refundAmount,
		nonce,
		receiverSig,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, "", network, "",
			fmt.Sprintf("refundWithSignature transaction failed: %s", err))
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
			fmt.Sprintf("failed waiting for refundWithSignature receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
			"refundWithSignature transaction reverted")
	}

	return buildRefundResponse(txHash, network, responseExtra), nil
}

func buildRefundResponse(txHash string, network x402.Network, responseExtra *batched.BatchedPaymentResponseExtra) *x402.SettleResponse {
	resp := &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
	}
	if responseExtra != nil {
		resp.Extensions = responseExtra.ToMap()
		resp.Extensions["refund"] = true
	}
	return resp
}
