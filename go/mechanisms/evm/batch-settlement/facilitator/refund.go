package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// The post-refund state is only polled when the channel was in
// pending-withdrawal at refund time, since withdraw cancellation makes a simple
// `preBalance - actualRefund` formula inaccurate; otherwise the formula is
// exact and a re-read is unnecessary.
const (
	refundStatePollDeadline = 2 * time.Second
	refundStatePollInterval = 150 * time.Millisecond
)

// ExecuteRefundWithSignature executes a cooperative refund using receiverAuthorizer signature.
// If RefundAuthorizerSignature or ClaimAuthorizerSignature are absent, the
// authorizerSigner auto-signs them.
func ExecuteRefundWithSignature(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	requirements types.PaymentRequirements,
	authorizerSigner batchsettlement.AuthorizerSigner,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	refundAmount, ok := new(big.Int).SetString(payload.Amount, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid refund amount: %s", payload.Amount))
	}

	nonce, ok := new(big.Int).SetString(payload.RefundNonce, 10)
	if !ok {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
			fmt.Sprintf("invalid nonce: %s", payload.RefundNonce))
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
		if !strings.EqualFold(payload.ChannelConfig.ReceiverAuthorizer, authorizerSigner.Address()) {
			return nil, x402.NewSettleError(ErrAuthorizerAddressMismatch, "", network, "",
				fmt.Sprintf("config receiverAuthorizer %s does not match authorizerSigner %s",
					payload.ChannelConfig.ReceiverAuthorizer, authorizerSigner.Address()))
		}
		channelId, err := batchsettlement.ComputeChannelId(payload.ChannelConfig, string(network))
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to compute channel id: %s", err))
		}
		refundSig, err = authorizerSigner.SignRefund(ctx, channelId, payload.Amount, payload.RefundNonce, string(network))
		if err != nil {
			return nil, x402.NewSettleError(ErrRefundTransactionFailed, "", network, "",
				fmt.Sprintf("failed to sign refund: %s", err))
		}
	}

	configTuple := ToContractChannelConfig(payload.ChannelConfig)

	// Compute the canonical channel id once — used for ABI encoding,
	// pre/post-state reads, and the response Extra.channelState.
	channelId, err := batchsettlement.ComputeChannelId(payload.ChannelConfig, string(network))
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, payload.ChannelConfig.Payer,
			fmt.Sprintf("failed to compute channel id: %s", err))
	}

	// Read pre-refund onchain state. Errors are non-fatal — without a
	// pre-state we still execute the refund and synthesize an extra from
	// the payload alone, which the resource server's afterSettle hook can
	// still parse.
	preState, _ := ReadChannelState(ctx, signer, channelId)

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

		// ABI-encode both calls for multicall.
		claimAbi, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementClaimWithSignatureABI)))
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to load claim ABI: %s", err))
		}
		claimCalldata, err := claimAbi.Pack("claimWithSignature", claimArgs, claimSig)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to encode claim calldata: %s", err))
		}

		refundAbi, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementRefundWithSignatureABI)))
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to load refund ABI: %s", err))
		}
		refundCalldata, err := refundAbi.Pack("refundWithSignature", configTuple, refundAmount, nonce, refundSig)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidRefundPayload, "", network, "",
				fmt.Sprintf("failed to encode refund calldata: %s", err))
		}

		// Simulate via readContract
		_, simErr := signer.ReadContract(
			ctx,
			batchsettlement.BatchSettlementAddress,
			batchsettlement.BatchSettlementMulticallABI,
			"multicall",
			[][]byte{claimCalldata, refundCalldata},
		)
		if simErr != nil {
			return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
				Success:      false,
				ErrorReason:  ErrRefundSimulationFailed,
				ErrorMessage: simErr.Error(),
				Transaction:  "",
				Network:      network,
			}, nil
		}

		txHash, err := signer.WriteContract(
			ctx,
			batchsettlement.BatchSettlementAddress,
			batchsettlement.BatchSettlementMulticallABI,
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

		details := computeRefundSettlementDetails(ctx, signer, payload, channelId, preState, refundAmount)
		return buildRefundResponse(txHash, network, payload.ChannelConfig.Payer, details), nil
	}

	// No claims — direct refundWithSignature

	// Simulate
	_, simErr := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementRefundWithSignatureABI,
		"refundWithSignature",
		configTuple,
		refundAmount,
		nonce,
		refundSig,
	)
	if simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:      false,
			ErrorReason:  ErrRefundSimulationFailed,
			ErrorMessage: simErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementRefundWithSignatureABI,
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

	details := computeRefundSettlementDetails(ctx, signer, payload, channelId, preState, refundAmount)
	return buildRefundResponse(txHash, network, payload.ChannelConfig.Payer, details), nil
}

// refundSettlementDetails captures the per-refund response fields the
// facilitator computes from pre/post onchain state and the enriched payload.
type refundSettlementDetails struct {
	// amount is the actual refund amount in token base units (decimal string).
	// May differ from `payload.amount` when the requested amount exceeds the
	// channel's available balance after preceding claims; in that case
	// available is used.
	amount string
	// channelState is the post-refund snapshot. balance reflects
	// `preBalance - actualRefund`; totalClaimed reflects the last claim's
	// totalClaimed (or preTotalClaimed if no claims); refundNonce is
	// `preRefundNonce + 1`; withdrawRequestedAt is 0 because a successful
	// `refundWithSignature` clears the pending withdrawal.
	channelState batchsettlement.BatchSettlementChannelStateExtra
}

// computeRefundSettlementDetails builds the response fields after a successful
// refund onchain. When the pre-state shows an active pending withdrawal, the
// facilitator polls for confirmation that the refund nonce advanced before
// computing the snapshot from chain; in the common case the snapshot is
// computed analytically from preState + payload.
func computeRefundSettlementDetails(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementEnrichedRefundPayload,
	channelId string,
	preState *batchsettlement.ChannelState,
	requestedAmount *big.Int,
) refundSettlementDetails {
	// Default zero values when preState is unavailable; skip pre-balance-based
	// capping in that case.
	preBalance := big.NewInt(0)
	preTotalClaimed := big.NewInt(0)
	preRefundNonce := big.NewInt(0)
	preWithdrawRequestedAt := 0
	if preState != nil {
		if preState.Balance != nil {
			preBalance = preState.Balance
		}
		if preState.TotalClaimed != nil {
			preTotalClaimed = preState.TotalClaimed
		}
		if preState.RefundNonce != nil {
			preRefundNonce = preState.RefundNonce
		}
		preWithdrawRequestedAt = preState.WithdrawRequestedAt
	}

	// If the channel was in pending withdrawal, polling the post-state is
	// the only way to know the final balance because `refundWithSignature`
	// also cancels the withdrawal in a single transaction. On RPC lag (deadline
	// elapsed without nonce advancement) we fall through to the analytic path
	// below.
	if preState != nil && preWithdrawRequestedAt != 0 {
		expectedNonce := new(big.Int).Add(preRefundNonce, big.NewInt(1))
		var postState *batchsettlement.ChannelState
		deadline := time.Now().Add(refundStatePollDeadline)
		for {
			s, err := ReadChannelState(ctx, signer, channelId)
			if err == nil && s != nil && s.RefundNonce != nil && s.RefundNonce.Cmp(expectedNonce) >= 0 {
				postState = s
				break
			}
			if !time.Now().Before(deadline) {
				break
			}
			time.Sleep(refundStatePollInterval)
		}
		if postState != nil {
			actualRefund := big.NewInt(0)
			if preBalance.Cmp(postState.Balance) > 0 {
				actualRefund = new(big.Int).Sub(preBalance, postState.Balance)
			}
			return refundSettlementDetails{
				amount: actualRefund.String(),
				channelState: batchsettlement.BatchSettlementChannelStateExtra{
					ChannelId:           channelId,
					Balance:             postState.Balance.String(),
					TotalClaimed:        postState.TotalClaimed.String(),
					WithdrawRequestedAt: postState.WithdrawRequestedAt,
					RefundNonce:         postState.RefundNonce.String(),
				},
			}
		}
	}

	// Analytic path: compute the post-refund snapshot from preState + payload.
	// totalClaimed advances to the last claim's totalClaimed (or stays at
	// preTotalClaimed if no claims accompany the refund).
	postClaimTotalClaimed := new(big.Int).Set(preTotalClaimed)
	if n := len(payload.Claims); n > 0 {
		if v, ok := new(big.Int).SetString(payload.Claims[n-1].TotalClaimed, 10); ok && v.Cmp(postClaimTotalClaimed) > 0 {
			postClaimTotalClaimed = v
		}
	}
	available := new(big.Int).Sub(preBalance, postClaimTotalClaimed)
	if available.Sign() < 0 {
		available = big.NewInt(0)
	}
	actualRefund := new(big.Int).Set(requestedAmount)
	if actualRefund.Cmp(available) > 0 {
		actualRefund = available
	}

	postBalance := new(big.Int).Sub(preBalance, actualRefund)
	if postBalance.Sign() < 0 {
		postBalance = big.NewInt(0)
	}
	postRefundNonce := new(big.Int).Add(preRefundNonce, big.NewInt(1))

	return refundSettlementDetails{
		amount: actualRefund.String(),
		channelState: batchsettlement.BatchSettlementChannelStateExtra{
			ChannelId:           channelId,
			Balance:             postBalance.String(),
			TotalClaimed:        postClaimTotalClaimed.String(),
			WithdrawRequestedAt: 0, // refundWithSignature clears any pending withdrawal
			RefundNonce:         postRefundNonce.String(),
		},
	}
}

// buildRefundResponse assembles a SettleResponse for a refund: success + tx +
// payer + amount + extra.channelState. The resource server's
// `enrichSettlementResponse` hook adds `chargedCumulativeAmount` on top via
// additive merge.
func buildRefundResponse(
	txHash string,
	network x402.Network,
	payer string,
	details refundSettlementDetails,
) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Payer:       payer,
		Amount:      details.amount,
		Extra: map[string]interface{}{
			"channelState": map[string]interface{}{
				"channelId":           details.channelState.ChannelId,
				"balance":             details.channelState.Balance,
				"totalClaimed":        details.channelState.TotalClaimed,
				"withdrawRequestedAt": details.channelState.WithdrawRequestedAt,
				"refundNonce":         details.channelState.RefundNonce,
			},
		},
	}
}
