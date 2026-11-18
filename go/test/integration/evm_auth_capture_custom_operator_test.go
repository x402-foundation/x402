// Custom-operator auth-capture against the operators deployed for the TypeScript
// integration tests (typescript/packages/mechanisms/evm/test/contracts/auth-capture).
// Addresses are fixed; this file does not deploy.
//
// Required env vars match the other EVM integration tests:
//   - EVM_CLIENT_PRIVATE_KEY, EVM_FACILITATOR_PRIVATE_KEY, EVM_RESOURCE_SERVER_ADDRESS
//
// Optional: EVM_RPC_URL (defaults to https://sepolia.base.org).
package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	gethtypes "github.com/ethereum/go-ethereum/core/types"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	authcaptureclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/client"
	authcapturefacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
	authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	authCaptureForwardingOperator = "0x8FE415CdB559fBF5B235B81CC4F7a69684A274bb"
	authCaptureNoopOperator       = "0x00Cc67f415Fec4ddAFB4F4a36F324AbBfdddFf27"
	authCaptureGasWastingOperator = "0x637233E61c1cCC12f2Aa5e83524d976be5E2dE04"
)

type writeCountingSigner struct {
	*realFacilitatorEvmSigner
	writes atomic.Int32
}

func (s *writeCountingSigner) WriteContractWithGas(
	ctx context.Context,
	address string,
	abiJSON []byte,
	functionName string,
	dataSuffix []byte,
	gas uint64,
	args ...interface{},
) (string, error) {
	s.writes.Add(1)
	return s.realFacilitatorEvmSigner.WriteContractWithGas(ctx, address, abiJSON, functionName, dataSuffix, gas, args...)
}

func (s *realFacilitatorEvmSigner) WriteContractWithGas(
	ctx context.Context,
	contractAddress string,
	abiBytes []byte,
	functionName string,
	dataSuffix []byte,
	gas uint64,
	args ...interface{},
) (string, error) {
	contractABI, err := abi.JSON(strings.NewReader(string(abiBytes)))
	if err != nil {
		return "", fmt.Errorf("failed to parse ABI: %w", err)
	}
	data, err := contractABI.Pack(functionName, args...)
	if err != nil {
		return "", fmt.Errorf("failed to pack method call: %w", err)
	}
	data = evm.AppendDataSuffix(data, dataSuffix)
	if gas == 0 {
		gas = 300000
	}
	return s.sendTxWithRetry(ctx, common.HexToAddress(contractAddress), data, gas)
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

	var blocks []rpcSimulatedBlock
	err := s.ethClient.Client().CallContext(ctx, &blocks, "eth_simulateV1", []interface{}{
		map[string]interface{}{
			"blockStateCalls": []map[string]interface{}{
				{"calls": rpcCalls},
			},
		},
		"latest",
	}...)
	if err != nil {
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
		if returnData == "" {
			returnData = "0x"
		}
		data, err := hexutil.Decode(returnData)
		if err != nil {
			return nil, fmt.Errorf("invalid simulate return data: %w", err)
		}
		var gasUsed uint64
		if outcome.GasUsed != "" {
			gasUsed, err = hexutil.DecodeUint64(outcome.GasUsed)
			if err != nil {
				return nil, fmt.Errorf("invalid simulate gasUsed: %w", err)
			}
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

type customOperatorPipeline struct {
	keys        *batchedTestKeys
	signer      *writeCountingSigner
	payer       string
	client      *x402.X402Client
	server      *x402.X402ResourceServer
	facilitator *x402.X402Facilitator
}

func buildCustomOperatorPipeline(t *testing.T, keys *batchedTestKeys) *customOperatorPipeline {
	t.Helper()

	clientSigner, err := evmsigners.NewClientSignerFromPrivateKey(keys.clientPK)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	facilitatorSigner, err := newRealFacilitatorEvmSigner(keys.facilitatorPK, keys.rpcURL)
	if err != nil {
		t.Fatalf("facilitator signer: %v", err)
	}
	signer := &writeCountingSigner{realFacilitatorEvmSigner: facilitatorSigner}

	operators := []authcapturefacilitator.OperatorAllowlistEntry{
		{Address: authCaptureForwardingOperator, OperatorType: authcapture.OperatorTypeCustom},
		{Address: authCaptureNoopOperator, OperatorType: authcapture.OperatorTypeCustom},
		{Address: authCaptureGasWastingOperator, OperatorType: authcapture.OperatorTypeCustom},
	}

	x402Client := x402.Newx402Client()
	x402Client.Register(batchedTestNetwork, authcaptureclient.NewAuthCaptureEvmScheme(clientSigner))

	x402Facilitator := x402.Newx402Facilitator()
	x402Facilitator.Register([]x402.Network{batchedTestNetwork}, authcapturefacilitator.NewAuthCaptureEvmScheme(
		signer,
		authcapturefacilitator.AuthCaptureEvmSchemeConfig{
			Operators:              operators,
			CustomOperatorGasLimit: authcapture.DefaultCustomOperatorGasLimit,
		},
	))

	x402Server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(&localEvmFacilitatorClient{facilitator: x402Facilitator}))
	x402Server.Register(batchedTestNetwork, authcaptureserver.NewAuthCaptureEvmScheme(&authcaptureserver.Config{
		CollectOnlyRoutes: true,
	}))
	if err := x402Server.Initialize(context.Background()); err != nil {
		t.Fatalf("server initialize: %v", err)
	}

	return &customOperatorPipeline{
		keys:        keys,
		signer:      signer,
		payer:       clientSigner.Address(),
		client:      x402Client,
		server:      x402Server,
		facilitator: x402Facilitator,
	}
}

func (p *customOperatorPipeline) collect(t *testing.T, operator string) (types.PaymentPayload, types.PaymentRequirements) {
	t.Helper()
	ctx := context.Background()
	zero := uint16(0)
	captureSeconds := uint64(7200)
	refundSeconds := uint64(14400)
	config := x402.ResourceConfig{
		Scheme:            authcapture.SchemeAuthCapture,
		Network:           batchedTestNetwork,
		PayTo:             p.keys.receiver,
		Price:             "$0.001",
		MaxTimeoutSeconds: 300,
		Extra: authcaptureserver.AuthCaptureRouteExtra{
			PaymentFlow:            authcapture.PaymentFlowEscrow,
			CaptureMode:            authcapture.CaptureModeDeferred,
			OperatorType:           authcapture.OperatorTypeCustom,
			CaptureAuthorizer:      operator,
			ReceiverAuthorizer:     authcapture.ZeroAddress,
			FeeRecipient:           authcapture.ZeroAddress,
			MinFeeBps:              &zero,
			MaxFeeBps:              &zero,
			AssetTransferMethod:    string(evm.AssetTransferMethodEIP3009),
			CaptureDeadlineSeconds: &captureSeconds,
			RefundDeadlineSeconds:  &refundSeconds,
		}.Map(),
	}

	var supported types.SupportedKind
	for _, kind := range p.facilitator.GetSupported().Kinds {
		if kind.X402Version == 2 && kind.Scheme == authcapture.SchemeAuthCapture && kind.Network == string(batchedTestNetwork) {
			supported = kind
			break
		}
	}
	requirements, err := p.server.BuildPaymentRequirements(ctx, config, supported, nil)
	if err != nil {
		t.Fatalf("build requirements: %v", err)
	}
	accepts := []types.PaymentRequirements{requirements}

	selected, err := p.client.SelectPaymentRequirements(accepts)
	if err != nil {
		t.Fatalf("select requirements: %v", err)
	}
	resource := &types.ResourceInfo{
		URL:         "https://example.com/api",
		Description: "auth-capture custom-operator test",
		MimeType:    "application/json",
	}
	payload, err := p.client.CreatePaymentPayload(ctx, selected, resource, nil)
	if err != nil {
		t.Fatalf("create payload: %v", err)
	}
	accepted := p.server.FindMatchingRequirements(accepts, payload)
	if accepted == nil {
		t.Fatal("no matching payment requirements")
	}
	return payload, *accepted
}

func (p *customOperatorPipeline) verify(t *testing.T, payload types.PaymentPayload, requirements types.PaymentRequirements) (*x402.VerifyResponse, error) {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	requirementsBytes, err := json.Marshal(requirements)
	if err != nil {
		t.Fatalf("marshal requirements: %v", err)
	}
	return p.facilitator.Verify(context.Background(), payloadBytes, requirementsBytes)
}

func TestAuthCaptureIntegration_CustomOperators(t *testing.T) {
	keys := loadBatchedTestKeys(t)
	pipe := buildCustomOperatorPipeline(t, keys)

	t.Run("forwarding operator authorizes through escrow", func(t *testing.T) {
		pipe.signer.writes.Store(0)
		payload, requirements := pipe.collect(t, authCaptureForwardingOperator)

		verified, err := pipe.verify(t, payload, requirements)
		if err != nil {
			t.Fatalf("verify: %v", err)
		}
		if !verified.IsValid {
			t.Fatalf("verify invalid: %s", verified.InvalidReason)
		}
		if !strings.EqualFold(verified.Payer, pipe.payer) {
			t.Fatalf("verify payer %s, want %s", verified.Payer, pipe.payer)
		}

		settle, err := pipe.server.SettlePaymentWithExtensions(
			context.Background(),
			payload,
			requirements,
			nil,
			nil,
			x402.SettlePhaseBeforeHandler,
		)
		if err != nil {
			t.Fatalf("settle: %v", err)
		}
		if !settle.Success {
			t.Fatalf("settle failed: %s %s", settle.ErrorReason, settle.ErrorMessage)
		}
		if settle.Transaction == "" {
			t.Fatal("expected a transaction hash")
		}
		if settle.Network != batchedTestNetwork {
			t.Fatalf("network %s", settle.Network)
		}
		if pipe.signer.writes.Load() == 0 {
			t.Fatal("expected a broadcast")
		}

		receipt, err := pipe.signer.WaitForTransactionReceipt(context.Background(), settle.Transaction)
		if err != nil {
			t.Fatalf("receipt: %v", err)
		}
		if !receiptAuthorizesOperator(t, receipt.Logs, authCaptureForwardingOperator) {
			t.Fatalf("escrow PaymentAuthorized for %s not found", authCaptureForwardingOperator)
		}
	})

	t.Run("noop operator rejects with no broadcast", func(t *testing.T) {
		expectSimulationRejection(t, pipe, authCaptureNoopOperator)
	})

	t.Run("gas-wasting operator rejects with no broadcast", func(t *testing.T) {
		expectSimulationRejection(t, pipe, authCaptureGasWastingOperator)
	})
}

func expectSimulationRejection(t *testing.T, pipe *customOperatorPipeline, operator string) {
	t.Helper()
	pipe.signer.writes.Store(0)
	payload, requirements := pipe.collect(t, operator)
	_, err := pipe.verify(t, payload, requirements)
	var verifyErr *x402.VerifyError
	if err == nil || !errors.As(err, &verifyErr) || verifyErr.InvalidReason != authcapturefacilitator.ErrSimulationFailed {
		t.Fatalf("verify error = %v, want %s", err, authcapturefacilitator.ErrSimulationFailed)
	}
	if pipe.signer.writes.Load() != 0 {
		t.Fatalf("broadcasts = %d, want 0", pipe.signer.writes.Load())
	}
}

func receiptAuthorizesOperator(t *testing.T, logs []*gethtypes.Log, operator string) bool {
	t.Helper()
	parsed, err := abi.JSON(bytes.NewReader(authcapture.AuthCaptureEscrowABIV1_1))
	if err != nil {
		t.Fatalf("escrow ABI: %v", err)
	}
	event, ok := parsed.Events["PaymentAuthorized"]
	if !ok {
		t.Fatal("PaymentAuthorized missing from escrow ABI")
	}
	want := common.HexToAddress(operator)
	escrow := common.HexToAddress(authcapture.AuthCaptureEscrowAddress)
	for _, log := range logs {
		if log.Address != escrow || len(log.Topics) == 0 || log.Topics[0] != event.ID {
			continue
		}
		fields, err := event.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil || len(fields) == 0 {
			continue
		}
		operator, ok := structAddressField(fields[0], "Operator")
		if ok && operator == want {
			return true
		}
	}
	return false
}

func structAddressField(value interface{}, name string) (common.Address, bool) {
	field := reflect.ValueOf(value)
	if field.Kind() == reflect.Pointer {
		if field.IsNil() {
			return common.Address{}, false
		}
		field = field.Elem()
	}
	if field.Kind() != reflect.Struct {
		return common.Address{}, false
	}
	operator := field.FieldByName(name)
	if !operator.IsValid() || !operator.CanInterface() {
		return common.Address{}, false
	}
	address, ok := operator.Interface().(common.Address)
	return address, ok
}
