package evm

import (
	"context"
	"fmt"
	"reflect"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// MulticallCall describes one batched call.
// Use CallData for pre-encoded raw calls, or ABI/FunctionName/Args for typed calls.
type MulticallCall struct {
	Address      string
	ABI          []byte
	FunctionName string
	Args         []interface{}
	CallData     []byte
}

// MulticallResult is the decoded outcome of one batched call.
type MulticallResult struct {
	Status string
	Result interface{}
	Error  error
}

type multicallTryAggregateCall struct {
	Target   common.Address
	CallData []byte
}

type multicallTryAggregateResult struct {
	Success    bool
	ReturnData []byte
}

// Success reports whether the call completed successfully.
func (r MulticallResult) Success() bool {
	return r.Status == "success"
}

// Multicall batches typed and raw eth_call requests via Multicall3.
func Multicall(
	ctx context.Context,
	signer FacilitatorEvmSigner,
	calls []MulticallCall,
) ([]MulticallResult, error) {
	if len(calls) == 0 {
		return nil, nil
	}

	aggregateCalls := make([]multicallTryAggregateCall, 0, len(calls))
	for _, call := range calls {
		callData, err := multicallCallData(call)
		if err != nil {
			return nil, err
		}

		aggregateCalls = append(aggregateCalls, multicallTryAggregateCall{
			Target:   common.HexToAddress(call.Address),
			CallData: callData,
		})
	}

	rawResults, err := signer.ReadContract(
		ctx,
		MULTICALL3Address,
		Multicall3TryAggregateABI,
		FunctionTryAggregate,
		false,
		aggregateCalls,
	)
	if err != nil {
		return nil, err
	}

	decodedResults, err := normalizeMulticallResults(rawResults)
	if err != nil {
		return nil, err
	}
	if len(decodedResults) != len(calls) {
		return nil, fmt.Errorf("multicall result length mismatch: got %d, want %d", len(decodedResults), len(calls))
	}

	results := make([]MulticallResult, 0, len(calls))
	for i, raw := range decodedResults {
		if !raw.Success {
			results = append(results, MulticallResult{
				Status: "failure",
				Error:  fmt.Errorf("multicall: call reverted"),
			})
			continue
		}

		call := calls[i]
		if len(call.CallData) > 0 {
			results = append(results, MulticallResult{Status: "success"})
			continue
		}

		decoded, err := decodeMulticallResult(call, raw.ReturnData)
		if err != nil {
			results = append(results, MulticallResult{
				Status: "failure",
				Error:  err,
			})
			continue
		}

		results = append(results, MulticallResult{
			Status: "success",
			Result: decoded,
		})
	}

	return results, nil
}

func multicallCallData(call MulticallCall) ([]byte, error) {
	if len(call.CallData) > 0 {
		return call.CallData, nil
	}

	if len(call.ABI) == 0 || call.FunctionName == "" {
		return nil, fmt.Errorf("multicall typed call requires ABI and function name")
	}

	contractABI, err := abi.JSON(strings.NewReader(string(call.ABI)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse ABI for multicall: %w", err)
	}

	data, err := contractABI.Pack(call.FunctionName, call.Args...)
	if err != nil {
		return nil, fmt.Errorf("failed to pack multicall input for %s: %w", call.FunctionName, err)
	}

	return data, nil
}

func decodeMulticallResult(call MulticallCall, returnData []byte) (interface{}, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(call.ABI)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse ABI for multicall decode: %w", err)
	}

	outputs, err := contractABI.Unpack(call.FunctionName, returnData)
	if err != nil {
		return nil, fmt.Errorf("failed to decode multicall result for %s: %w", call.FunctionName, err)
	}

	if len(outputs) == 0 {
		return nil, nil
	}
	if len(outputs) == 1 {
		return outputs[0], nil
	}

	return outputs, nil
}

func normalizeMulticallResults(raw interface{}) ([]multicallTryAggregateResult, error) {
	value := reflect.ValueOf(raw)
	if !value.IsValid() {
		return nil, fmt.Errorf("multicall returned nil results")
	}
	if value.Kind() != reflect.Slice {
		return nil, fmt.Errorf("multicall returned %T, want slice", raw)
	}

	results := make([]multicallTryAggregateResult, 0, value.Len())
	for i := 0; i < value.Len(); i++ {
		entry := value.Index(i)
		if entry.Kind() == reflect.Interface || entry.Kind() == reflect.Pointer {
			entry = entry.Elem()
		}
		if !entry.IsValid() || entry.Kind() != reflect.Struct {
			return nil, fmt.Errorf("multicall entry %d has unexpected type %s", i, entry.Kind())
		}

		successField := entry.FieldByName("Success")
		returnDataField := entry.FieldByName("ReturnData")
		if !successField.IsValid() || !returnDataField.IsValid() {
			return nil, fmt.Errorf("multicall entry %d missing expected fields", i)
		}

		returnData, ok := returnDataField.Interface().([]byte)
		if !ok {
			return nil, fmt.Errorf("multicall entry %d returnData has unexpected type %T", i, returnDataField.Interface())
		}

		results = append(results, multicallTryAggregateResult{
			Success:    successField.Bool(),
			ReturnData: returnData,
		})
	}

	return results, nil
}
