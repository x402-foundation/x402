package x402

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/coinbase/x402/go/types"
)

// Test Facilitator BeforeVerify hook - abort verification
func TestFacilitatorBeforeVerifyHook_Abort(t *testing.T) {
	facilitator := Newx402Facilitator()

	// Register hook that aborts verification
	facilitator.OnBeforeVerify(func(ctx FacilitatorVerifyContext) (*FacilitatorBeforeHookResult, error) {
		return &FacilitatorBeforeHookResult{
			Abort:  true,
			Reason: "Facilitator security check failed",
		}, nil
	})

	// Try to verify (should be aborted by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	result, err := facilitator.Verify(
		context.Background(),
		payloadBytes,
		requirementsBytes,
	)

	if err == nil {
		t.Error("Expected error from aborted verification")
	}

	if result != nil {
		t.Error("Expected nil result when verification is aborted")
	}

	// Check error is VerifyError with correct reason
	ve := &VerifyError{}
	if errors.As(err, &ve) {
		if ve.InvalidReason != "Facilitator security check failed" {
			t.Errorf("Expected specific reason, got '%s'", ve.InvalidReason)
		}
	} else {
		t.Errorf("Expected *VerifyError, got %T", err)
	}
}

// Test Facilitator AfterVerify hook
func TestFacilitatorAfterVerifyHook(t *testing.T) {
	var capturedPayer string

	facilitator := Newx402Facilitator()

	// Register mock scheme facilitator
	mockScheme := &mockSchemeFacilitator{
		scheme: "exact",
		verifyFunc: func(ctx context.Context, payload types.PaymentPayload, reqs types.PaymentRequirements) (*VerifyResponse, error) {
			return &VerifyResponse{IsValid: true, Payer: "0xTestPayer"}, nil
		},
	}
	facilitator.Register([]Network{"eip155:8453"}, mockScheme)

	// Register hook to capture result
	facilitator.OnAfterVerify(func(ctx FacilitatorVerifyResultContext) error {
		capturedPayer = ctx.Result.Payer
		return nil
	})

	// Verify payment (marshal to bytes for facilitator API)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	result, err := facilitator.Verify(
		context.Background(),
		payloadBytes,
		requirementsBytes,
	)

	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}

	if !result.IsValid {
		t.Error("Expected verification to succeed")
	}

	// Check hook captured the result
	if capturedPayer != "0xTestPayer" {
		t.Errorf("Expected hook to capture payer '0xTestPayer', got '%s'", capturedPayer)
	}
}

// Test Facilitator OnVerifyFailure hook - recovery
func TestFacilitatorOnVerifyFailureHook_Recover(t *testing.T) {
	facilitator := Newx402Facilitator()

	// Register mock scheme facilitator that fails
	mockScheme := &mockSchemeFacilitator{
		scheme: "exact",
		verifyFunc: func(ctx context.Context, payload types.PaymentPayload, reqs types.PaymentRequirements) (*VerifyResponse, error) {
			return nil, NewVerifyError("verification_failed", "", fmt.Sprintf("verification failed: %s", payload.Payload["signature"]))
		},
	}
	facilitator.Register([]Network{"eip155:8453"}, mockScheme)

	// Register hook that recovers from failure
	facilitator.OnVerifyFailure(func(ctx FacilitatorVerifyFailureContext) (*FacilitatorVerifyFailureHookResult, error) {
		return &FacilitatorVerifyFailureHookResult{
			Recovered: true,
			Result: &VerifyResponse{
				IsValid: true,
				Payer:   "0xRecovered",
			},
		}, nil
	})

	// Verify payment (should be recovered by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	result, err := facilitator.Verify(
		context.Background(),
		payloadBytes,
		requirementsBytes,
	)

	if err != nil {
		t.Errorf("Expected hook to recover, got error: %v", err)
	}

	if !result.IsValid {
		t.Error("Expected hook to recover verification")
	}

	if result.Payer != "0xRecovered" {
		t.Errorf("Expected recovered payer, got '%s'", result.Payer)
	}
}

// Test Facilitator BeforeSettle hook - abort
func TestFacilitatorBeforeSettleHook_Abort(t *testing.T) {
	facilitator := Newx402Facilitator()

	// Register hook that aborts settlement
	facilitator.OnBeforeSettle(func(ctx FacilitatorSettleContext) (*FacilitatorBeforeHookResult, error) {
		return &FacilitatorBeforeHookResult{
			Abort:  true,
			Reason: "Gas price too high",
		}, nil
	})

	// Try to settle (should be aborted by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	result, err := facilitator.Settle(
		context.Background(),
		payloadBytes,
		requirementsBytes,
	)

	if err == nil {
		t.Error("Expected error when settlement is aborted")
	}

	if result != nil {
		t.Error("Expected nil result when settlement is aborted")
	}
}

// Test Facilitator AfterSettle hook
func TestFacilitatorAfterSettleHook(t *testing.T) {
	var capturedTx string

	facilitator := Newx402Facilitator()

	// Register mock scheme facilitator
	mockScheme := &mockSchemeFacilitator{
		scheme: "exact",
		settleFunc: func(ctx context.Context, payload types.PaymentPayload, reqs types.PaymentRequirements) (*SettleResponse, error) {
			return &SettleResponse{Success: true, Transaction: "0xFacilitatorTx", Network: Network(reqs.Network), Payer: "0xPayer"}, nil
		},
	}
	facilitator.Register([]Network{"eip155:8453"}, mockScheme)

	// Register hook to capture settlement result
	facilitator.OnAfterSettle(func(ctx FacilitatorSettleResultContext) error {
		capturedTx = ctx.Result.Transaction
		return nil
	})

	// Settle payment
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	result, err := facilitator.Settle(
		context.Background(),
		payloadBytes,
		requirementsBytes,
	)

	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}

	if !result.Success {
		t.Error("Expected settlement to succeed")
	}

	// Check hook captured the transaction
	if capturedTx != "0xFacilitatorTx" {
		t.Errorf("Expected hook to capture tx '0xFacilitatorTx', got '%s'", capturedTx)
	}
}

// Test Facilitator OnSettleFailure hook - recovery
func TestFacilitatorOnSettleFailureHook_Recover(t *testing.T) {
	facilitator := Newx402Facilitator()

	// Register mock scheme facilitator that fails
	mockScheme := &mockSchemeFacilitator{
		scheme: "exact",
		settleFunc: func(ctx context.Context, payload types.PaymentPayload, reqs types.PaymentRequirements) (*SettleResponse, error) {
			return nil, NewSettleError("settlement_failed", "", Network(reqs.Network), "", "settlement failed")
		},
	}
	facilitator.Register([]Network{"eip155:8453"}, mockScheme)

	// Register hook that recovers from failure
	facilitator.OnSettleFailure(func(ctx FacilitatorSettleFailureContext) (*FacilitatorSettleFailureHookResult, error) {
		return &FacilitatorSettleFailureHookResult{
			Recovered: true,
			Result: &SettleResponse{
				Success:     true,
				Transaction: "0xFacilitatorRecovered",
				Network:     Network(ctx.Requirements.GetNetwork()),
				Payer:       "0xRecoveredPayer",
			},
		}, nil
	})

	// Settle payment (should be recovered by hook)
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	result, err := facilitator.Settle(
		context.Background(),
		payloadBytes,
		requirementsBytes,
	)

	if err != nil {
		t.Errorf("Expected hook to recover, got error: %v", err)
	}

	if !result.Success {
		t.Error("Expected hook to recover settlement")
	}

	if result.Transaction != "0xFacilitatorRecovered" {
		t.Errorf("Expected recovered transaction, got '%s'", result.Transaction)
	}
}

// Test Facilitator multiple hooks execution order
func TestFacilitatorMultipleHooks_ExecutionOrder(t *testing.T) {
	executionOrder := []string{}

	facilitator := Newx402Facilitator()

	// Register mock scheme facilitator
	mockScheme := &mockSchemeFacilitator{
		scheme: "exact",
		verifyFunc: func(ctx context.Context, payload types.PaymentPayload, reqs types.PaymentRequirements) (*VerifyResponse, error) {
			return &VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
	}
	facilitator.Register([]Network{"eip155:8453"}, mockScheme)

	// Register multiple hooks in order
	facilitator.OnBeforeVerify(func(ctx FacilitatorVerifyContext) (*FacilitatorBeforeHookResult, error) {
		executionOrder = append(executionOrder, "before1")
		return nil, nil
	})

	facilitator.OnBeforeVerify(func(ctx FacilitatorVerifyContext) (*FacilitatorBeforeHookResult, error) {
		executionOrder = append(executionOrder, "before2")
		return nil, nil
	})

	facilitator.OnAfterVerify(func(ctx FacilitatorVerifyResultContext) error {
		executionOrder = append(executionOrder, "after1")
		return nil
	})

	facilitator.OnAfterVerify(func(ctx FacilitatorVerifyResultContext) error {
		executionOrder = append(executionOrder, "after2")
		return nil
	})

	// Verify payment
	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}

	payloadBytes, _ := json.Marshal(payload)
	requirementsBytes, _ := json.Marshal(requirements)

	_, _ = facilitator.Verify(
		context.Background(),
		payloadBytes,
		requirementsBytes,
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

// Mock scheme facilitator for testing
type mockSchemeFacilitator struct {
	scheme     string
	verifyFunc func(ctx context.Context, payload types.PaymentPayload, reqs types.PaymentRequirements) (*VerifyResponse, error)
	settleFunc func(ctx context.Context, payload types.PaymentPayload, reqs types.PaymentRequirements) (*SettleResponse, error)
}

func (m *mockSchemeFacilitator) Scheme() string {
	return m.scheme
}

func (m *mockSchemeFacilitator) CaipFamily() string {
	return "test:*"
}

func (m *mockSchemeFacilitator) GetExtra(_ Network) map[string]interface{} {
	return nil
}

func (m *mockSchemeFacilitator) GetSigners(_ Network) []string {
	return []string{}
}

func (m *mockSchemeFacilitator) Verify(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, _ *FacilitatorContext) (*VerifyResponse, error) {
	if m.verifyFunc != nil {
		return m.verifyFunc(ctx, payload, requirements)
	}
	return nil, errors.New("not implemented")
}

func (m *mockSchemeFacilitator) Settle(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, _ *FacilitatorContext) (*SettleResponse, error) {
	if m.settleFunc != nil {
		return m.settleFunc(ctx, payload, requirements)
	}
	return nil, errors.New("not implemented")
}
