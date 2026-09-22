package client

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/types"
)

func exactPermit2Requirements() types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            "exact",
		Network:           "eip155:8453",
		Asset:             "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
		Amount:            "100",
		PayTo:             "0x3333333333333333333333333333333333333333",
		MaxTimeoutSeconds: 600,
		Extra: map[string]interface{}{
			"assetTransferMethod": "permit2",
			"name":                "USDC",
			"version":             "2",
		},
	}
}

func captureExactLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previous) })
	return &logs
}

func TestCreatePaymentPayloadWarnsOnceWhenEip2612CapabilityIsMissing(t *testing.T) {
	logs := captureExactLogs(t)
	scheme := NewExactEvmScheme(&mockMinimalClientSigner{}, nil)
	ctx := x402.PaymentPayloadContext{Extensions: map[string]interface{}{
		eip2612gassponsor.EIP2612GasSponsoring.Key(): map[string]interface{}{},
	}}

	for range 2 {
		payload, err := scheme.CreatePaymentPayload(context.Background(), exactPermit2Requirements(), ctx)
		if err != nil {
			t.Fatalf("CreatePaymentPayload failed: %v", err)
		}
		if payload.Extensions != nil {
			t.Fatalf("expected no extension without read capability, got %+v", payload.Extensions)
		}
	}

	output := logs.String()
	if count := strings.Count(output, "[x402 exact] eip2612GasSponsoring"); count != 1 {
		t.Fatalf("expected one warning, got %d: %q", count, output)
	}
	if !strings.Contains(output, "RPCURL") || !strings.Contains(output, "RPCByChainID") {
		t.Fatalf("expected actionable RPC guidance, got %q", output)
	}
}

func TestCreatePaymentPayloadDoesNotWarnWhenExtensionIsNotAdvertised(t *testing.T) {
	logs := captureExactLogs(t)
	scheme := NewExactEvmScheme(&mockMinimalClientSigner{}, nil)

	if _, err := scheme.CreatePaymentPayload(context.Background(), exactPermit2Requirements(), x402.PaymentPayloadContext{}); err != nil {
		t.Fatalf("CreatePaymentPayload failed: %v", err)
	}
	if logs.Len() != 0 {
		t.Fatalf("expected no warning without an advertised extension, got %q", logs.String())
	}
}

func TestCreatePaymentPayloadWarnsWhenErc20ApprovalCapabilityIsMissing(t *testing.T) {
	logs := captureExactLogs(t)
	scheme := NewExactEvmScheme(&mockMinimalClientSigner{}, nil)
	ctx := x402.PaymentPayloadContext{Extensions: map[string]interface{}{
		erc20approvalgassponsor.ERC20ApprovalGasSponsoring.Key(): map[string]interface{}{},
	}}

	payload, err := scheme.CreatePaymentPayload(context.Background(), exactPermit2Requirements(), ctx)
	if err != nil {
		t.Fatalf("CreatePaymentPayload failed: %v", err)
	}
	if payload.Extensions != nil {
		t.Fatalf("expected no extension without transaction-signing capability, got %+v", payload.Extensions)
	}
	output := logs.String()
	if !strings.Contains(output, "[x402 exact] erc20ApprovalGasSponsoring") ||
		!strings.Contains(output, "ClientEvmSignerWithSignTransaction") {
		t.Fatalf("expected actionable transaction-signing warning, got %q", output)
	}
}
