package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// ExecuteRefundWithSignature executes a cooperative refund using receiverAuthorizer signature.
// If RefundAuthorizerSignature or ClaimAuthorizerSignature are absent, the
// authorizerSigner auto-signs them.
func ExecuteRefundWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedRefundWithSignaturePayload,
	requirements types.PaymentRequirements,
	authorizerSigner batched.AuthorizerSigner,
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

	// Resolve refund authorizer signature — auto-sign if absent
	var refundSig []byte
	if payload.RefundAuthorizerSignature != "" {
		var err error
		refundSig, err = evm.HexToBytes(payload.RefundAuthorizerSignature)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("invalid refund authorizer signature: %s", err))
		}
	} else {
		// Verify authorizer address matches config's receiverAuthorizer
		if !strings.EqualFold(payload.Config.ReceiverAuthorizer, authorizerSigner.Address()) {
			return nil, x402.NewSettleError(ErrAuthorizerAddressMismatch, "", network, "",
				fmt.Sprintf("config receiverAuthorizer %s does not match authorizerSigner %s",
					payload.Config.ReceiverAuthorizer, authorizerSigner.Address()))
		}
		channelId, err := batched.ComputeChannelId(payload.Config)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to compute channel id: %s", err))
		}
		refundSig, err = authorizerSigner.SignRefund(ctx, channelId, payload.Amount, payload.Nonce, string(network))
		if err != nil {
			return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
				fmt.Sprintf("failed to sign refund: %s", err))
		}
	}

	configTuple := buildChannelConfigTuple(payload.Config)

	// Handle claims + refund atomically if claims are present
	if len(payload.Claims) > 0 {
		// Resolve claim authorizer signature — auto-sign if absent
		var claimSig []byte
		if payload.ClaimAuthorizerSignature != "" {
			var err error
			claimSig, err = evm.HexToBytes(payload.ClaimAuthorizerSignature)
			if err != nil {
				return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
					fmt.Sprintf("invalid claim authorizer signature: %s", err))
			}
		} else {
			var err error
			claimSig, err = authorizerSigner.SignClaimBatch(ctx, payload.Claims, string(network))
			if err != nil {
				return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
					fmt.Sprintf("failed to sign claim batch for refund: %s", err))
			}
		}

		claimArgs := buildVoucherClaimArgs(payload.Claims)

		// Encode both calls for multicall
		claimCalldata, err := encodeClaimWithSignatureCalldata(claimArgs, claimSig)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to encode claim calldata: %s", err))
		}

		refundCalldata, err := encodeRefundWithSignatureCalldata(configTuple, refundAmount, nonce, refundSig)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to encode refund calldata: %s", err))
		}

		// Simulate via readContract
		_, simErr := signer.ReadContract(
			ctx,
			batched.BatchSettlementAddress,
			batched.BatchSettlementMulticallABI,
			"multicall",
			[][]byte{claimCalldata, refundCalldata},
		)
		if simErr != nil {
			return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
				Success:     false,
				ErrorReason: ErrRefundSimulationFailed,
				Transaction: "",
				Network:     network,
			}, nil
		}

		txHash, err := signer.WriteContract(
			ctx,
			batched.BatchSettlementAddress,
			batched.BatchSettlementMulticallABI,
			"multicall",
			[][]byte{claimCalldata, refundCalldata},
		)
		if err != nil {
			return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
				fmt.Sprintf("multicall (claim+refund) transaction failed: %s", err))
		}

		receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
		if err != nil {
			return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
				fmt.Sprintf("failed waiting for multicall receipt: %s", err))
		}
		if receipt.Status != evm.TxStatusSuccess {
			return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
				"multicall (claim+refund) transaction reverted")
		}

		return buildRefundResponse(txHash, network, payload.ResponseExtra), nil
	}

	// No claims — direct refundWithSignature

	// Simulate
	_, simErr := signer.ReadContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementRefundWithSignatureABI,
		"refundWithSignature",
		configTuple,
		refundAmount,
		nonce,
		refundSig,
	)
	if simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:     false,
			ErrorReason: ErrRefundSimulationFailed,
			Transaction: "",
			Network:     network,
		}, nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementRefundWithSignatureABI,
		"refundWithSignature",
		configTuple,
		refundAmount,
		nonce,
		refundSig,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
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

// encodeClaimWithSignatureCalldata ABI-encodes claimWithSignature calldata for multicall.
func encodeClaimWithSignatureCalldata(claimArgs interface{}, sig []byte) ([]byte, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(batched.BatchSettlementClaimWithSignatureABI)))
	if err != nil {
		return nil, err
	}
	return contractABI.Pack("claimWithSignature", claimArgs, sig)
}

// encodeRefundWithSignatureCalldata ABI-encodes refundWithSignature calldata for multicall.
func encodeRefundWithSignatureCalldata(configTuple interface{}, amount, nonce *big.Int, sig []byte) ([]byte, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(batched.BatchSettlementRefundWithSignatureABI)))
	if err != nil {
		return nil, err
	}
	return contractABI.Pack("refundWithSignature", configTuple, amount, nonce, sig)
}
