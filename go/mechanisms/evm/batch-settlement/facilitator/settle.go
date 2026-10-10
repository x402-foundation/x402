package facilitator

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// SettleGasLimit is the per-settle gas budget used to estimate multicall limits.
const SettleGasLimit uint64 = 120_000

// SettleMulticallGasLimit estimates gas for a multicall of n settle() calls.
func SettleMulticallGasLimit(settleCount int) uint64 {
	if settleCount <= 0 {
		return SettleGasLimit
	}
	return uint64(settleCount) * SettleGasLimit
}

// ExecuteSettle executes a settle action, transferring claimed funds to the receiver.
// Calls settle(receiver, token) on the BatchSettlement contract.
func ExecuteSettle(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementSettlePayload,
	requirements types.PaymentRequirements,
	dataSuffix []byte,
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
			Success:      false,
			ErrorReason:  ErrSettleSimulationFailed,
			ErrorMessage: simErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementSettleABI,
		"settle",
		dataSuffix,
		receiver,
		token,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrSettleTransactionFailed, "", network, "",
			fmt.Sprintf("settle transaction failed: %s", evm.TruncateErrorMessage(err.Error())))
	}
	receipt, err := evm.WaitForSettleReceipt(ctx, signer, txHash, "", network,
		ErrSettleTransactionFailed, ErrTransactionReverted)
	if err != nil {
		return nil, err
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Amount:      settledAmountFromReceipt(receipt, receiver, token),
	}, nil
}

func settledAmountFromReceipt(receipt *evm.TransactionReceipt, receiver, token common.Address) string {
	if receipt == nil || receipt.Logs == nil {
		return ""
	}
	parsed, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementSettledEventABI)))
	if err != nil {
		return "0"
	}
	event, ok := parsed.Events["Settled"]
	if !ok {
		return "0"
	}
	contractAddr := common.HexToAddress(batchsettlement.BatchSettlementAddress)
	for _, log := range receipt.Logs {
		if log == nil || log.Address != contractAddr {
			continue
		}
		if len(log.Topics) < 4 || log.Topics[0] != event.ID {
			continue
		}
		logReceiver := common.BytesToAddress(log.Topics[1].Bytes())
		logToken := common.BytesToAddress(log.Topics[2].Bytes())
		if logReceiver != receiver || logToken != token {
			continue
		}
		unpacked, err := event.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil || len(unpacked) == 0 {
			continue
		}
		amount, ok := unpacked[0].(*big.Int)
		if !ok {
			continue
		}
		return amount.String()
	}
	return "0"
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
	return parseReceiversMulticallResult(raw)
}

// ExecuteSettleBatch submits up to len(targets) settle(receiver, token) calls in one
// multicall. On simulation revert with multiple targets, the batch is split recursively.
func ExecuteSettleBatch(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	network x402.Network,
	targets []storage.SettleTarget,
	dataSuffix []byte,
) ([]FacilitatorSettleResult, error) {
	submissions, _, err := submitSettleMulticall(ctx, slog.Default(), signer, network, targets, dataSuffix)
	results := settleResultsFromSubmissions(string(network), submissions)
	return results, err
}

type settleMulticallSubmission struct {
	txHash  string
	targets []storage.SettleTarget
}

type skippedSettleTarget struct {
	target storage.SettleTarget
	err    error
}

func settleResultsFromSubmissions(network string, submissions []settleMulticallSubmission) []FacilitatorSettleResult {
	results := make([]FacilitatorSettleResult, 0)
	for _, sub := range submissions {
		for _, target := range sub.targets {
			results = append(results, FacilitatorSettleResult{
				Network:     network,
				Receiver:    target.Receiver,
				Token:       target.Token,
				Transaction: sub.txHash,
			})
		}
	}
	return results
}

func submitSettleMulticall(
	ctx context.Context,
	logger *slog.Logger,
	signer evm.FacilitatorEvmSigner,
	network x402.Network,
	targets []storage.SettleTarget,
	dataSuffix []byte,
) ([]settleMulticallSubmission, []skippedSettleTarget, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	if len(targets) == 0 {
		return nil, nil, nil
	}
	calls, err := encodeSettleMulticallCalls(targets)
	if err != nil {
		return nil, nil, err
	}
	_, simErr := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementMulticallABI,
		"multicall",
		calls,
	)
	if simErr != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		if len(targets) == 1 {
			skipErr := x402.NewSettleError(ErrSettleSimulationFailed, "", network, "",
				fmt.Sprintf("settle simulation failed: %s", evm.TruncateErrorMessage(simErr.Error())))
			logger.Warn("batch-settlement: skipping settle after simulation failure",
				"receiver", targets[0].Receiver,
				"token", targets[0].Token,
				"network", string(network),
				"error", skipErr,
			)
			return nil, []skippedSettleTarget{{target: targets[0], err: skipErr}}, nil
		}
		mid := len(targets) / 2
		left, leftSkipped, err := submitSettleMulticall(ctx, logger, signer, network, targets[:mid], dataSuffix)
		if err != nil {
			return left, leftSkipped, err
		}
		right, rightSkipped, err := submitSettleMulticall(ctx, logger, signer, network, targets[mid:], dataSuffix)
		if err != nil {
			return append(left, right...), append(leftSkipped, rightSkipped...), err
		}
		return append(left, right...), append(leftSkipped, rightSkipped...), nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementMulticallABI,
		"multicall",
		dataSuffix,
		calls,
	)
	if err != nil {
		return nil, nil, x402.NewSettleError(ErrSettleTransactionFailed, "", network, "",
			fmt.Sprintf("settle multicall transaction failed: %s", evm.TruncateErrorMessage(err.Error())))
	}
	if _, err := evm.WaitForSettleReceipt(ctx, signer, txHash, "", network,
		ErrSettleTransactionFailed, ErrTransactionReverted); err != nil {
		return nil, nil, err
	}
	return []settleMulticallSubmission{{txHash: txHash, targets: targets}}, nil, nil
}

func encodeSettleMulticallCalls(targets []storage.SettleTarget) ([][]byte, error) {
	settleAbi, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementSettleABI)))
	if err != nil {
		return nil, fmt.Errorf("load settle ABI: %w", err)
	}
	calls := make([][]byte, 0, len(targets))
	for _, target := range targets {
		receiver := common.HexToAddress(target.Receiver)
		token := common.HexToAddress(target.Token)
		call, err := settleAbi.Pack("settle", receiver, token)
		if err != nil {
			return nil, fmt.Errorf("encode settle calldata: %w", err)
		}
		calls = append(calls, call)
	}
	return calls, nil
}
