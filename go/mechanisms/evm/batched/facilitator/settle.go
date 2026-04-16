package facilitator

import (
	"context"
	"fmt"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// ExecuteSettle executes a settle action, transferring claimed funds to the receiver.
// Calls settle(receiver, token) on the BatchSettlement contract.
func ExecuteSettle(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batched.BatchedSettleActionPayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	txHash, err := signer.WriteContract(
		ctx,
		batched.BatchSettlementAddress,
		batched.BatchSettlementSettleABI,
		"settle",
		common.HexToAddress(payload.Receiver),
		common.HexToAddress(payload.Token),
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrTransactionFailed, "", network, "",
			fmt.Sprintf("settle transaction failed: %s", err))
	}

	receipt, err := signer.WaitForTransactionReceipt(ctx, txHash)
	if err != nil {
		return nil, x402.NewSettleError(ErrWaitForReceipt, txHash, network, "",
			fmt.Sprintf("failed waiting for settle receipt: %s", err))
	}
	if receipt.Status != evm.TxStatusSuccess {
		return nil, x402.NewSettleError(ErrTransactionReverted, txHash, network, "",
			"settle transaction reverted")
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
	}, nil
}
