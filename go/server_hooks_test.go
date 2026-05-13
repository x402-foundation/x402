package x402

import (
	"context"
	"errors"
	"testing"

	"github.com/x402-foundation/x402/go/types"
)

// Mock facilitator client for testing
type mockFacilitatorClient struct {
	verify func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error)
	settle func(ctx context.Context, payload []byte, reqs []byte) (*SettleResponse, error)
	kinds  []SupportedKind // Configurable supported kinds
}

func (m *mockFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*VerifyResponse, error) {
	if m.verify != nil {
		return m.verify(ctx, payloadBytes, requirementsBytes)
	}
	return &VerifyResponse{IsValid: true, Payer: "0xmock"}, nil // Default to success
}

func (m *mockFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
	if m.settle != nil {
		return m.settle(ctx, payloadBytes, requirementsBytes)
	}
	return &SettleResponse{Success: true, Transaction: "0xmock", Network: "eip155:1", Payer: "0xmock"}, nil // Default to success
}

func (m *mockFacilitatorClient) GetSupported(ctx context.Context) (SupportedResponse, error) {
	if m.kinds != nil {
		return SupportedResponse{
			Kinds:      m.kinds,
			Extensions: []string{},
			Signers:    make(map[string][]string),
		}, nil
	}
	// Default kinds for backward compatibility with server_hooks tests
	return SupportedResponse{
		Kinds: []SupportedKind{
			{X402Version: 2, Scheme: "exact", Network: "eip155:8453"},
		},
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}, nil
}

// Test BeforeVerify hook - abort verification
func TestBeforeVerifyHook_Abort(t *testing.T) {
	server := Newx402ResourceServer()

	// Register hook that aborts verification
	server.OnBeforeVerify(func(ctx VerifyContext) (*BeforeHookResult, error) {
		return &BeforeHookResult{
			Abort:  true,
			Reason: "Security check failed",
		}, nil
	})

	// Try to verify (should be aborted by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	result, err := server.VerifyPayment(
		context.Background(),
		payload,
		requirements,
	)

	if err == nil {
		t.Error("Expected error when hook aborts")
	}

	if result != nil {
		t.Error("Expected nil result when hook aborts")
	}

	// Check that it's a VerifyError with the correct reason
	ve := &VerifyError{}
	if errors.As(err, &ve) {
		if ve.InvalidReason != "Security check failed" {
			t.Errorf("Expected reason='Security check failed', got '%s'", ve.InvalidReason)
		}
	} else {
		t.Errorf("Expected *VerifyError, got %T", err)
	}
}

// Test BeforeVerify hook - continue verification
func TestBeforeVerifyHook_Continue(t *testing.T) {
	called := false

	server := Newx402ResourceServer()

	// Register hook that allows verification to continue
	server.OnBeforeVerify(func(ctx VerifyContext) (*BeforeHookResult, error) {
		called = true
		// Return nil to continue
		return nil, nil
	})

	// Try to verify (will fail due to no facilitators, but hook should be called)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	_, _ = server.VerifyPayment(
		context.Background(),
		payload,
		requirements,
	)

	if !called {
		t.Error("Expected beforeVerify hook to be called")
	}
}

// Test AfterVerify hook
func TestAfterVerifyHook(t *testing.T) {
	var capturedResult *VerifyResponse

	server := Newx402ResourceServer()

	// Register hook to capture result
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		capturedResult = ctx.Result
		return nil, nil
	})

	// Mock facilitator that returns success
	mockFacilitator := &mockFacilitatorClient{
		verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
			return &VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
	}

	// Setup facilitator in the map
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": mockFacilitator,
	}

	// Verify payment (typed)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	result, err := server.VerifyPayment(
		context.Background(),
		payload,
		requirements,
	)

	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}

	if !result.IsValid {
		t.Error("Expected verification to succeed")
	}

	// Check hook was called with correct result
	if !capturedResult.IsValid {
		t.Error("Expected afterVerify hook to capture valid result")
	}
}

// Test OnVerifyFailure hook - recovery
func TestOnVerifyFailureHook_Recover(t *testing.T) {
	server := Newx402ResourceServer()

	// Register hook that recovers from failure
	server.OnVerifyFailure(func(ctx VerifyFailureContext) (*VerifyFailureHookResult, error) {
		return &VerifyFailureHookResult{
			Recovered: true,
			Result: &VerifyResponse{
				IsValid: true,
				// Hook recovered the payment
			},
		}, nil
	})

	// Mock facilitator that returns error
	mockFacilitator := &mockFacilitatorClient{
		verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
			return nil, errors.New("facilitator error")
		},
	}

	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": mockFacilitator,
	}

	// Verify payment (should be recovered by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	result, err := server.VerifyPayment(
		context.Background(),
		payload,
		requirements,
	)

	if err != nil {
		t.Errorf("Expected hook to recover, got error: %v", err)
	}

	if !result.IsValid {
		t.Error("Expected hook to recover verification")
	}
}

// Test OnVerifyFailure hook - no recovery
func TestOnVerifyFailureHook_NoRecover(t *testing.T) {
	hookCalled := false

	server := Newx402ResourceServer()

	// Register hook that doesn't recover
	server.OnVerifyFailure(func(ctx VerifyFailureContext) (*VerifyFailureHookResult, error) {
		hookCalled = true
		// Return nil to not recover
		return nil, nil
	})

	// Mock facilitator that returns error
	mockFacilitator := &mockFacilitatorClient{
		verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
			return nil, errors.New("facilitator error")
		},
	}

	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": mockFacilitator,
	}

	// Verify payment (should fail)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	_, err := server.VerifyPayment(
		context.Background(),
		payload,
		requirements,
	)

	if err == nil {
		t.Error("Expected error to be returned when hook doesn't recover")
	}

	if !hookCalled {
		t.Error("Expected failure hook to be called")
	}
}

// Test BeforeSettle hook - abort settlement
func TestBeforeSettleHook_Abort(t *testing.T) {
	server := Newx402ResourceServer()

	// Register hook that aborts settlement
	server.OnBeforeSettle(func(ctx SettleContext) (*BeforeHookResult, error) {
		return &BeforeHookResult{
			Abort:  true,
			Reason: "Insufficient funds",
		}, nil
	})

	// Try to settle (should be aborted by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	result, err := server.SettlePayment(
		context.Background(),
		payload,
		requirements,
		nil,
	)

	if err == nil {
		t.Error("Expected error when settlement is aborted")
	}

	if result != nil {
		t.Error("Expected nil result when settlement is aborted")
	}

	// Check that it's a SettleError with the correct reason
	se := &SettleError{}
	if errors.As(err, &se) {
		if se.ErrorReason != "Insufficient funds" {
			t.Errorf("Expected reason='Insufficient funds', got '%s'", se.ErrorReason)
		}
	} else {
		t.Errorf("Expected *SettleError, got %T", err)
	}
}

// Test AfterSettle hook
func TestAfterSettleHook(t *testing.T) {
	var capturedTxHash string

	server := Newx402ResourceServer()

	// Register hook to capture settlement result
	server.OnAfterSettle(func(ctx SettleResultContext) error {
		capturedTxHash = ctx.Result.Transaction
		return nil
	})

	// Mock facilitator that returns successful settlement
	mockFacilitator := &mockFacilitatorClient{
		settle: func(ctx context.Context, payload []byte, reqs []byte) (*SettleResponse, error) {
			return &SettleResponse{
				Success:     true,
				Transaction: "0xabc123",
				Network:     "eip155:8453",
				Payer:       "0xpayer",
			}, nil
		},
	}

	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": mockFacilitator,
	}

	// Settle payment
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	result, err := server.SettlePayment(
		context.Background(),
		payload,
		requirements,
		nil,
	)

	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}

	if !result.Success {
		t.Error("Expected settlement to succeed")
	}

	// Check hook captured the transaction hash
	if capturedTxHash != "0xabc123" {
		t.Errorf("Expected hook to capture tx hash '0xabc123', got '%s'", capturedTxHash)
	}
}

// Test OnSettleFailure hook - recovery
func TestOnSettleFailureHook_Recover(t *testing.T) {
	server := Newx402ResourceServer()

	// Register hook that recovers from failure
	server.OnSettleFailure(func(ctx SettleFailureContext) (*SettleFailureHookResult, error) {
		return &SettleFailureHookResult{
			Recovered: true,
			Result: &SettleResponse{
				Success:     true,
				Transaction: "0xrecovered",
				Network:     "eip155:8453",
				Payer:       "0xpayer",
			},
		}, nil
	})

	// Mock facilitator that returns error
	mockFacilitator := &mockFacilitatorClient{
		settle: func(ctx context.Context, payload []byte, reqs []byte) (*SettleResponse, error) {
			return nil, errors.New("settlement failed")
		},
	}

	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": mockFacilitator,
	}

	// Settle payment (should be recovered by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	result, err := server.SettlePayment(
		context.Background(),
		payload,
		requirements,
		nil,
	)

	if err != nil {
		t.Errorf("Expected hook to recover, got error: %v", err)
	}

	if !result.Success {
		t.Error("Expected hook to recover settlement")
	}

	if result.Transaction != "0xrecovered" {
		t.Errorf("Expected recovered transaction, got '%s'", result.Transaction)
	}
}

// Test multiple hooks execution order
func TestMultipleHooks_ExecutionOrder(t *testing.T) {
	executionOrder := []string{}

	server := Newx402ResourceServer()

	// Register multiple hooks in order
	server.OnBeforeVerify(func(ctx VerifyContext) (*BeforeHookResult, error) {
		executionOrder = append(executionOrder, "before1")
		return nil, nil
	})

	server.OnBeforeVerify(func(ctx VerifyContext) (*BeforeHookResult, error) {
		executionOrder = append(executionOrder, "before2")
		return nil, nil
	})

	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		executionOrder = append(executionOrder, "after1")
		return nil, nil
	})

	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		executionOrder = append(executionOrder, "after2")
		return nil, nil
	})

	// Mock facilitator
	mockFacilitator := &mockFacilitatorClient{
		verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
			return &VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
	}

	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": mockFacilitator,
	}

	// Verify payment
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	_, _ = server.VerifyPayment(
		context.Background(),
		payload,
		requirements,
	)

	// Check execution order
	expected := []string{"before1", "before2", "after1", "after2"}
	if len(executionOrder) != len(expected) {
		t.Errorf("Expected %d hooks to execute, got %d", len(expected), len(executionOrder))
	}

	for i, v := range expected {
		if i >= len(executionOrder) || executionOrder[i] != v {
			t.Errorf("Expected execution order %v, got %v", expected, executionOrder)
			break
		}
	}
}

// Test using functional options to register hooks at construction
func TestHooks_FunctionalOptions(t *testing.T) {
	hookCalled := false

	// Create service with hooks registered via options
	server := Newx402ResourceServer(
		WithBeforeVerifyHook(func(ctx VerifyContext) (*BeforeHookResult, error) {
			hookCalled = true
			return nil, nil
		}),
	)

	// Verify
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	_, _ = server.VerifyPayment(
		context.Background(),
		payload,
		requirements,
	)

	if !hookCalled {
		t.Error("Expected hook registered via option to be called")
	}
}

// Note: mockFacilitatorClient is defined in service_test.go
