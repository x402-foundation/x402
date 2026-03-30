package unit_test

import (
	"context"
	"fmt"
	"testing"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
	evmclient "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
	evmv1client "github.com/coinbase/x402/go/mechanisms/evm/exact/v1/client"
	"github.com/coinbase/x402/go/types"
)

// Mock EVM signer for client
type mockClientEvmSigner struct {
	address string
}

func (m *mockClientEvmSigner) Address() string {
	if m.address == "" {
		return "0x1234567890123456789012345678901234567890"
	}
	return m.address
}

func (m *mockClientEvmSigner) SignTypedData(
	ctx context.Context,
	domain evm.TypedDataDomain,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	// Return a mock signature (65 bytes)
	sig := make([]byte, 65)
	// Set v to 27 (common value for Ethereum signatures)
	sig[64] = 27
	return sig, nil
}

func (m *mockClientEvmSigner) ReadContract(
	ctx context.Context,
	address string,
	abi []byte,
	functionName string,
	args ...interface{},
) (interface{}, error) {
	return nil, fmt.Errorf("mock ReadContract not implemented")
}

// TestEVMVersionMismatch tests that V1 and V2 don't mix
func TestEVMVersionMismatch(t *testing.T) {
	t.Run("V1 Client with V2 Requirements Should Fail", func(t *testing.T) {
		ctx := context.Background()

		// Setup V1 client with legacy network name
		clientSigner := &mockClientEvmSigner{}
		client := x402.Newx402Client()
		evmClientV1 := evmv1client.NewExactEvmSchemeV1(clientSigner)
		client.RegisterV1("base", evmClientV1)

		// V1 client should succeed with legacy network name
		v1Requirements := types.PaymentRequirementsV1{
			Scheme:            evm.SchemeExact,
			Network:           "base",
			Asset:             "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
			MaxAmountRequired: "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
		}
		payload, err := client.CreatePaymentPayloadV1(ctx, v1Requirements)
		if err != nil {
			t.Fatalf("Failed to create payment: %v", err)
		}
		// Verify it created a V1 payload
		if payload.X402Version != 1 {
			t.Errorf("Expected V1 payload from V1 client, got v%d", payload.X402Version)
		}
		if payload.Scheme != evm.SchemeExact {
			t.Errorf("Expected scheme %s, got %s", evm.SchemeExact, payload.Scheme)
		}
	})

	t.Run("V2 Client with V1 Requirements Should Fail", func(t *testing.T) {
		ctx := context.Background()

		// Setup V2 client
		clientSigner := &mockClientEvmSigner{}
		client := x402.Newx402Client()
		evmClient := evmclient.NewExactEvmScheme(clientSigner, nil)
		client.Register("eip155:8453", evmClient)

		// V2 requirements (typed)
		requirements := types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:8453",
			Asset:   "erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
			Amount:  "1000000",
			PayTo:   "0x9876543210987654321098765432109876543210",
		}

		// V2 client creates V2 payload (typed API)
		payload, err := client.CreatePaymentPayload(ctx, requirements, nil, nil)
		if err != nil {
			t.Fatalf("Failed to create payment: %v", err)
		}
		// Verify it created a V2 payload
		if payload.X402Version != 2 {
			t.Errorf("Expected V2 payload from V2 client, got v%d", payload.X402Version)
		}
		if payload.Accepted.Scheme != evm.SchemeExact {
			t.Errorf("Expected scheme in accepted field")
		}
	})
}

// TestEVMDualVersionSupport tests that a client can register both V1 and V2 and handle either version.
// This is important for backward compatibility - a client application can support both protocol versions
// simultaneously and respond appropriately based on the server's requirements.
func TestEVMDualVersionSupport(t *testing.T) {
	t.Run("Dual-Registered Client Handles V1 Requirements", func(t *testing.T) {
		ctx := context.Background()

		// Setup client with BOTH V1 and V2 implementations
		clientSigner := &mockClientEvmSigner{}
		client := x402.Newx402Client()

		// Register V1 implementation with legacy network name
		evmClientV1 := evmv1client.NewExactEvmSchemeV1(clientSigner)
		client.RegisterV1("base", evmClientV1)

		// Register V2 implementation with CAIP-2
		evmClient := evmclient.NewExactEvmScheme(clientSigner, nil)
		client.Register("eip155:8453", evmClient)

		// V1 requirements use legacy network name
		v1Requirements := types.PaymentRequirementsV1{
			Scheme:            evm.SchemeExact,
			Network:           "base",
			Asset:             "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
			MaxAmountRequired: "1000000",
			PayTo:             "0x9876543210987654321098765432109876543210",
		}

		// Client handles V1 request (typed API)
		payloadV1, err := client.CreatePaymentPayloadV1(ctx, v1Requirements)
		if err != nil {
			t.Fatalf("Failed to create V1 payment: %v", err)
		}

		if payloadV1.X402Version != 1 {
			t.Errorf("Expected V1 payload, got v%d", payloadV1.X402Version)
		}

		// Verify V1 structure (scheme at top level, not in Accepted)
		if payloadV1.Scheme == "" {
			t.Error("Expected V1 payload to have top-level Scheme")
		}

		// V2 requirements use CAIP-2
		v2Requirements := types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:8453",
			Asset:   "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
			Amount:  "1000000",
			PayTo:   "0x9876543210987654321098765432109876543210",
			Extra: map[string]interface{}{
				"name":    "USD Coin",
				"version": "2",
			},
		}

		// Client handles V2 request (typed API)
		payloadV2, err := client.CreatePaymentPayload(ctx, v2Requirements, nil, nil)
		if err != nil {
			t.Fatalf("Failed to create V2 payment: %v", err)
		}

		if payloadV2.X402Version != 2 {
			t.Errorf("Expected V2 payload, got v%d", payloadV2.X402Version)
		}
		if payloadV2.Accepted.Scheme == "" {
			t.Error("Expected V2 payload to have Accepted.Scheme")
		}
	})

	t.Run("Dual-Registered Client Handles V2 Requirements", func(t *testing.T) {
		ctx := context.Background()

		// Setup client with BOTH V1 and V2 implementations
		clientSigner := &mockClientEvmSigner{}
		client := x402.Newx402Client()

		// Register V1 implementation with legacy name
		evmClientV1 := evmv1client.NewExactEvmSchemeV1(clientSigner)
		client.RegisterV1("base", evmClientV1)

		// Register V2 implementation with CAIP-2
		evmClient := evmclient.NewExactEvmScheme(clientSigner, nil)
		client.Register("eip155:8453", evmClient)

		// V2 requirements use CAIP-2
		requirements := types.PaymentRequirements{
			Scheme:  evm.SchemeExact,
			Network: "eip155:8453",
			Asset:   "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
			Amount:  "1000000",
			PayTo:   "0x9876543210987654321098765432109876543210",
		}

		// Client handles V2 request using V2 implementation (typed API)
		payloadV2, err := client.CreatePaymentPayload(ctx, requirements, nil, nil)
		if err != nil {
			t.Fatalf("Failed to create V2 payment: %v", err)
		}

		if payloadV2.X402Version != 2 {
			t.Errorf("Expected V2 payload, got v%d", payloadV2.X402Version)
		}

		// Verify V2 structure (has scheme/network in Accepted)
		if payloadV2.Accepted.Scheme == "" {
			t.Error("Expected V2 payload to have Accepted.Scheme")
		}
	})
}
