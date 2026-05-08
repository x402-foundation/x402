package facilitator

import (
	"context"
	"fmt"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// ExecuteSettle executes a settle action, transferring claimed funds to the receiver.
// Calls settle(receiver, token) on the BatchSettlement contract.
func ExecuteSettle(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementSettlePayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)

	// Simulate before submitting
	_, simErr := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementSettleABI,
		"settle",
		common.HexToAddress(payload.Receiver),
		common.HexToAddress(payload.Token),
	)
	if simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:     false,
			ErrorReason: ErrSettleSimulationFailed,
			Transaction: "",
			Network:     network,
		}, nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementSettleABI,
		"settle",
		common.HexToAddress(payload.Receiver),
		common.HexToAddress(payload.Token),
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrSettleTransactionFailed, "", network, "",
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
