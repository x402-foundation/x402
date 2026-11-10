package main

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	authcapturefacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
	evmmech "github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

func (s *realFacilitatorEvmSigner) WriteContractWithGas(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	dataSuffix []byte,
	gas uint64,
	args ...interface{},
) (string, error) {
	return s.writeContract(ctx, contractAddress, abiJSON, method, dataSuffix, gas, args...)
}

func (s *realFacilitatorEvmSigner) writeContract(
	ctx context.Context,
	contractAddress string,
	abiJSON []byte,
	method string,
	dataSuffix []byte,
	gasLimit uint64,
	args ...interface{},
) (string, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		return "", fmt.Errorf("failed to parse ABI: %w", err)
	}

	data, err := contractABI.Pack(method, args...)
	if err != nil {
		return "", fmt.Errorf("failed to pack method call: %w", err)
	}
	data = evmmech.AppendDataSuffix(data, dataSuffix)

	nonce, err := s.reserveNonce(ctx)
	if err != nil {
		return "", err
	}

	gasPrice, err := s.client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to get gas price: %w", err)
	}

	if gasLimit == 0 {
		gasLimit = 300_000
	}

	to := common.HexToAddress(contractAddress)
	tx := gethtypes.NewTransaction(
		nonce,
		to,
		big.NewInt(0),
		gasLimit,
		gasPrice,
		data,
	)

	signedTx, err := gethtypes.SignTx(tx, gethtypes.LatestSignerForChainID(s.chainID), s.privateKey)
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}

	if err := s.client.SendTransaction(ctx, signedTx); err != nil {
		return "", fmt.Errorf("failed to send transaction: %w", err)
	}

	return signedTx.Hash().Hex(), nil
}

type rpcSimulateCall struct {
	From string `json:"from"`
	To   string `json:"to"`
	Data string `json:"data"`
	Gas  string `json:"gas,omitempty"`
}

type rpcSimulateLog struct {
	Address string   `json:"address"`
	Topics  []string `json:"topics"`
	Data    string   `json:"data"`
}

type rpcSimulateCallOutcome struct {
	Status     string           `json:"status"`
	ReturnData string           `json:"returnData"`
	GasUsed    string           `json:"gasUsed"`
	Logs       []rpcSimulateLog `json:"logs"`
	Error      *struct {
		Data string `json:"data"`
	} `json:"error,omitempty"`
}

type rpcSimulatedBlock struct {
	Calls []rpcSimulateCallOutcome `json:"calls"`
}

func (s *realFacilitatorEvmSigner) SimulateCalls(
	ctx context.Context,
	from string,
	calls []authcapturefacilitator.SimulatedCall,
) ([]authcapturefacilitator.SimulatedCallResult, error) {
	rpcCalls := make([]rpcSimulateCall, len(calls))
	for i, call := range calls {
		data := call.Data
		if len(data) == 0 {
			data = []byte{}
		}
		entry := rpcSimulateCall{
			From: common.HexToAddress(from).Hex(),
			To:   common.HexToAddress(call.To).Hex(),
			Data: hexutil.Encode(data),
		}
		if call.Gas > 0 {
			entry.Gas = hexutil.EncodeUint64(call.Gas)
		}
		rpcCalls[i] = entry
	}

	params := []interface{}{
		map[string]interface{}{
			"blockStateCalls": []map[string]interface{}{
				{"calls": rpcCalls},
			},
		},
		"latest",
	}

	var blocks []rpcSimulatedBlock
	if err := s.client.Client().CallContext(ctx, &blocks, "eth_simulateV1", params...); err != nil {
		return nil, fmt.Errorf("eth_simulateV1 failed: %w", err)
	}
	if len(blocks) == 0 || len(blocks[0].Calls) != len(calls) {
		return nil, fmt.Errorf("eth_simulateV1 returned unexpected call count")
	}

	results := make([]authcapturefacilitator.SimulatedCallResult, len(calls))
	for i, outcome := range blocks[0].Calls {
		returnData := outcome.ReturnData
		if outcome.Error != nil && outcome.Error.Data != "" {
			returnData = outcome.Error.Data
		}
		data, err := hexutil.Decode(returnData)
		if err != nil {
			return nil, fmt.Errorf("invalid simulate return data: %w", err)
		}
		gasUsed, err := hexutil.DecodeUint64(outcome.GasUsed)
		if err != nil {
			return nil, fmt.Errorf("invalid simulate gasUsed: %w", err)
		}
		results[i] = authcapturefacilitator.SimulatedCallResult{
			Success:    outcome.Status == "0x1",
			ReturnData: data,
			GasUsed:    gasUsed,
			Logs:       parseSimulateLogs(outcome.Logs),
		}
	}
	return results, nil
}

func parseSimulateLogs(logs []rpcSimulateLog) []*gethtypes.Log {
	parsed := make([]*gethtypes.Log, 0, len(logs))
	for _, log := range logs {
		topics := make([]common.Hash, len(log.Topics))
		for i, topic := range log.Topics {
			topics[i] = common.HexToHash(topic)
		}
		data, err := hexutil.Decode(log.Data)
		if err != nil {
			data = []byte{}
		}
		parsed = append(parsed, &gethtypes.Log{
			Address: common.HexToAddress(log.Address),
			Topics:  topics,
			Data:    data,
		})
	}
	return parsed
}
