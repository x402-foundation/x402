package facilitator

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
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
	receiver := common.HexToAddress(payload.Receiver)
	token := common.HexToAddress(payload.Token)

	totalClaimed, totalSettled, readErr := readReceiverSettlementTotals(ctx, signer, receiver, token)
	if readErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // RPC read failure -> error encoded in response
			Success:      false,
			ErrorReason:  ErrRpcReadFailed,
			ErrorMessage: readErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}
	if totalClaimed.Cmp(totalSettled) <= 0 {
		return &x402.SettleResponse{ //nolint:nilerr // no-op settle -> error encoded in response
			Success:      false,
			ErrorReason:  ErrNothingToSettle,
			ErrorMessage: "nothing to settle for receiver and token",
			Transaction:  "",
			Network:      network,
		}, nil
	}

	// Simulate before submitting
	_, simErr := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementSettleABI,
		"settle",
		receiver,
		token,
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
		receiver,
		token,
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

func readReceiverSettlementTotals(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	receiver common.Address,
	token common.Address,
) (*big.Int, *big.Int, error) {
	raw, err := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementReceiversABI,
		"receivers",
		receiver,
		token,
	)
	if err != nil {
		return nil, nil, err
	}

	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return nil, nil, fmt.Errorf("receivers returned %T, want two uint128 values", raw)
	}

	totalClaimed, ok := outputs[0].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalClaimed returned %T, want *big.Int", outputs[0])
	}
	totalSettled, ok := outputs[1].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalSettled returned %T, want *big.Int", outputs[1])
	}

	return totalClaimed, totalSettled, nil
}
