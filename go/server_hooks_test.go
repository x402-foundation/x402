package x402

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"
	"testing"

	"github.com/x402-foundation/x402/go/v2/types"
)

func registerExactEvmScheme(s *x402ResourceServer) {
	s.Register("eip155:8453", &mockSchemeNetworkServer{scheme: "exact"})
}

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

func TestBeforeVerifyHook_ThrowFailsClosed(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	verifyCalls := 0
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
				verifyCalls++
				return &VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
			},
		},
	}
	server.OnBeforeVerify(func(ctx VerifyContext) (*BeforeHookResult, error) {
		return nil, errors.New("Hook boom")
	})

	result, err := server.VerifyPayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
	)
	if result != nil {
		t.Fatalf("result = %+v, want nil", result)
	}
	ve := &VerifyError{}
	if !errors.As(err, &ve) {
		t.Fatalf("got %T (%v), want *VerifyError", err, err)
	}
	if ve.InvalidReason != "before_verify_hook_error" || ve.InvalidMessage != "before verify hook failed" {
		t.Fatalf("reason=%q message=%q", ve.InvalidReason, ve.InvalidMessage)
	}
	if verifyCalls != 0 {
		t.Fatalf("facilitator verify calls = %d", verifyCalls)
	}
	if !strings.Contains(logs.String(), "[x402] Resource server beforeVerify hook threw (manual beforeVerify hook #0): Hook boom") {
		t.Fatalf("log = %q", logs.String())
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
	registerExactEvmScheme(server)

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
	registerExactEvmScheme(server)

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
	registerExactEvmScheme(server)

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

func TestAfterVerifyHook_Abort(t *testing.T) {
	laterCalled := false
	cancelReason := VerifiedPaymentCancellationReason("")
	var cancelVerifyResult *VerifyResponse

	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		return &AfterVerifyResult{
			Abort:   true,
			Reason:  "extension_rejected",
			Message: "policy denied",
		}, nil
	})
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		laterCalled = true
		return nil, nil
	})
	server.OnVerifiedPaymentCanceled(func(ctx VerifiedPaymentCanceledContext) error {
		cancelReason = ctx.Reason
		cancelVerifyResult = ctx.VerifyResult
		return nil
	})

	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
				return &VerifyResponse{IsValid: true, Payer: "0xpayer", Extra: map[string]interface{}{"pendingId": "0xpending"}}, nil
			},
		},
	}

	payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
	requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}
	result, err := server.VerifyPayment(context.Background(), payload, requirements)

	if err == nil {
		t.Fatal("expected abort error")
	}
	ve := &VerifyError{}
	if !errors.As(err, &ve) || ve.InvalidReason != "extension_rejected" {
		t.Fatalf("got err=%v", err)
	}
	if result == nil || result.IsValid || result.InvalidReason != "extension_rejected" {
		t.Fatalf("got result=%+v", result)
	}
	if laterCalled {
		t.Fatal("later afterVerify hook should not run after abort")
	}
	if cancelReason != CancellationReasonAfterVerifyAborted {
		t.Fatalf("cancel reason = %q", cancelReason)
	}
	if cancelVerifyResult == nil || !cancelVerifyResult.IsValid || cancelVerifyResult.Extra["pendingId"] != "0xpending" {
		t.Fatalf("cancel must carry the trusted verify result, got %+v", cancelVerifyResult)
	}
}

type settleFailureScheme struct {
	mockSchemeNetworkServer
	flow      PaymentFlowName
	enrichErr error
}

func (m *settleFailureScheme) PaymentFlows() map[string]PaymentFlowConfig {
	return map[string]PaymentFlowConfig{
		SDKDefaultAssetTransferMethod: {Supported: []PaymentFlowName{m.flow}, Default: m.flow},
	}
}

func (m *settleFailureScheme) EnrichSettlementPayload(SettleContext) (map[string]interface{}, error) {
	return nil, m.enrichErr
}

func TestSettlePayment_SettlementFailedCancelOnlyBeforeFacilitator(t *testing.T) {
	abort := func(SettleContext) (*BeforeHookResult, error) {
		return &BeforeHookResult{Abort: true, Reason: "settle_denied"}, nil
	}
	hookErr := func(SettleContext) (*BeforeHookResult, error) {
		return nil, errors.New("hook failed")
	}
	facilitatorErr := func(context.Context, []byte, []byte) (*SettleResponse, error) {
		return nil, errors.New("rpc down")
	}
	facilitatorFailure := func(context.Context, []byte, []byte) (*SettleResponse, error) {
		return &SettleResponse{Success: false, ErrorReason: "insufficient_funds", Network: "eip155:8453"}, nil
	}
	cases := []struct {
		name         string
		flow         PaymentFlowName
		phase        SettlePhase
		beforeSettle BeforeSettleHook
		enrichErr    error
		settle       func(context.Context, []byte, []byte) (*SettleResponse, error)
		wantCancel   bool
	}{
		{name: "before-handler beforeSettle abort", flow: PaymentFlowUpfront, phase: SettlePhaseBeforeHandler, beforeSettle: abort, wantCancel: true},
		{name: "after-handler beforeSettle abort in authorization flow", flow: PaymentFlowAuthorization, phase: SettlePhaseAfterHandler, beforeSettle: abort, wantCancel: true},
		{name: "after-handler beforeSettle error", flow: PaymentFlowAuthorization, phase: SettlePhaseAfterHandler, beforeSettle: hookErr, wantCancel: true},
		{name: "after-handler enrichment error", flow: PaymentFlowAuthorization, phase: SettlePhaseAfterHandler, enrichErr: errors.New("signer down"), wantCancel: true},
		{name: "after-handler abort in escrow flow", flow: PaymentFlowEscrow, phase: SettlePhaseAfterHandler, beforeSettle: abort},
		{name: "cancel phase abort", flow: PaymentFlowAuthorization, phase: SettlePhaseCancel, beforeSettle: abort},
		{name: "facilitator error", flow: PaymentFlowAuthorization, phase: SettlePhaseAfterHandler, settle: facilitatorErr},
		{name: "facilitator failure response", flow: PaymentFlowAuthorization, phase: SettlePhaseAfterHandler, settle: facilitatorFailure},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := Newx402ResourceServer()
			server.Register("eip155:8453", &settleFailureScheme{
				mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "exact"},
				flow:                    tc.flow,
				enrichErr:               tc.enrichErr,
			})
			settleCalls := 0
			server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
				"exact": &mockFacilitatorClient{
					settle: func(ctx context.Context, payload []byte, reqs []byte) (*SettleResponse, error) {
						settleCalls++
						return tc.settle(ctx, payload, reqs)
					},
				},
			}
			if tc.beforeSettle != nil {
				server.OnBeforeSettle(tc.beforeSettle)
			}
			var canceled []VerifiedPaymentCanceledContext
			server.OnVerifiedPaymentCanceled(func(ctx VerifiedPaymentCanceledContext) error {
				canceled = append(canceled, ctx)
				return nil
			})

			payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
			requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"}
			result, err := server.SettlePaymentWithExtensions(context.Background(), payload, requirements, nil, nil, tc.phase)
			if err == nil && (result == nil || result.Success) {
				t.Fatalf("expected settle failure, got %+v", result)
			}

			if !tc.wantCancel {
				if len(canceled) != 0 {
					t.Fatalf("expected no cancellation, got %+v", canceled)
				}
				return
			}
			if err == nil {
				t.Fatal("expected settle error")
			}
			if settleCalls != 0 {
				t.Fatalf("facilitator settle calls = %d", settleCalls)
			}
			if len(canceled) != 1 {
				t.Fatalf("expected one cancellation, got %d", len(canceled))
			}
			got := canceled[0]
			if got.Reason != CancellationReasonSettlementPreflightFailed || len(got.SettledPhases) != 0 || got.VerifyResult != nil {
				t.Fatalf("got reason=%q settledPhases=%v verifyResult=%+v", got.Reason, got.SettledPhases, got.VerifyResult)
			}
			if !errors.Is(got.Err, err) {
				t.Fatalf("cancel Err = %v, want %v", got.Err, err)
			}
		})
	}
}

// preflightCancelScheme fails enrichment before the facilitator and records settleOnCancel calls.
type preflightCancelScheme struct {
	settleFailureScheme
	failCancelEnrich bool
	cancelReasons    []VerifiedPaymentCancellationReason
	cancelPhases     [][]SettlePhase
}

func (m *preflightCancelScheme) EnrichSettlementPayload(ctx SettleContext) (map[string]interface{}, error) {
	if ctx.Phase == SettlePhaseCancel && !m.failCancelEnrich {
		return nil, nil
	}
	return nil, m.enrichErr
}

func (m *preflightCancelScheme) SettleOnCancel(ctx VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	m.cancelReasons = append(m.cancelReasons, ctx.Reason)
	m.cancelPhases = append(m.cancelPhases, ctx.SettledPhases)
	reqs := ctx.Requirements.(types.PaymentRequirements)
	reqs.Amount = "0"
	return &reqs, nil
}

func TestSettlePayment_PreflightFailureRunsSettleOnCancel(t *testing.T) {
	cases := []struct {
		name             string
		failCancelEnrich bool
		wantSettleCalls  int
	}{
		{name: "cancel settle reaches the facilitator", wantSettleCalls: 1},
		{name: "cancel settle also fails before the facilitator without recursing", failCancelEnrich: true, wantSettleCalls: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scheme := &preflightCancelScheme{
				settleFailureScheme: settleFailureScheme{
					mockSchemeNetworkServer: mockSchemeNetworkServer{scheme: "exact"},
					flow:                    PaymentFlowAuthorization,
					enrichErr:               errors.New("signer down"),
				},
				failCancelEnrich: tc.failCancelEnrich,
			}
			server := Newx402ResourceServer()
			server.Register("eip155:8453", scheme)

			var settledAmounts []string
			server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
				"exact": &mockFacilitatorClient{
					settle: func(ctx context.Context, payload []byte, reqs []byte) (*SettleResponse, error) {
						var parsed types.PaymentRequirements
						if err := json.Unmarshal(reqs, &parsed); err != nil {
							t.Fatalf("unmarshal requirements: %v", err)
						}
						settledAmounts = append(settledAmounts, parsed.Amount)
						return &SettleResponse{Success: true, Amount: parsed.Amount, Network: "eip155:8453"}, nil
					},
				},
			}
			cancelHooks := 0
			server.OnVerifiedPaymentCanceled(func(VerifiedPaymentCanceledContext) error {
				cancelHooks++
				return nil
			})
			settleFailureHooks := 0
			server.OnSettleFailure(func(SettleFailureContext) (*SettleFailureHookResult, error) {
				settleFailureHooks++
				return nil, nil
			})

			payload := types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}}
			requirements := types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453", Amount: "1000"}
			_, err := server.SettlePaymentWithExtensions(context.Background(), payload, requirements, nil, nil, SettlePhaseAfterHandler)
			if err == nil || !strings.Contains(err.Error(), "signer down") {
				t.Fatalf("expected the original enrichment error, got %v", err)
			}

			if len(scheme.cancelReasons) != 1 || scheme.cancelReasons[0] != CancellationReasonSettlementPreflightFailed {
				t.Fatalf("settleOnCancel reasons = %v", scheme.cancelReasons)
			}
			if len(scheme.cancelPhases[0]) != 0 {
				t.Fatalf("settleOnCancel settledPhases = %v", scheme.cancelPhases[0])
			}
			if cancelHooks != 1 {
				t.Fatalf("cancel hooks = %d, want 1", cancelHooks)
			}
			if len(settledAmounts) != tc.wantSettleCalls {
				t.Fatalf("settle amounts = %v, want %d calls", settledAmounts, tc.wantSettleCalls)
			}
			if tc.wantSettleCalls == 1 && settledAmounts[0] != "0" {
				t.Fatalf("cancel settle amount = %q, want 0", settledAmounts[0])
			}
			if settleFailureHooks != 0 {
				t.Fatalf("OnSettleFailure must not run before the facilitator, ran %d times", settleFailureHooks)
			}
		})
	}
}

func TestAfterVerifyHook_AbortKeepsResponseWhenCancelThrows(t *testing.T) {
	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		return &AfterVerifyResult{Abort: true, Reason: "aborted"}, nil
	})
	server.OnVerifiedPaymentCanceled(func(ctx VerifiedPaymentCanceledContext) error {
		return errors.New("cleanup failed")
	})
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
				return &VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
			},
		},
	}

	result, err := server.VerifyPayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
	)
	if err == nil {
		t.Fatal("expected abort error")
	}
	if result == nil || result.IsValid || result.InvalidReason != "aborted" {
		t.Fatalf("got result=%+v", result)
	}
}

func TestAfterVerifyHook_SkipHandlerStillWorks(t *testing.T) {
	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		return &AfterVerifyResult{
			SkipHandler: true,
			Response:    &SkipHandlerDirective{ContentType: "application/json", Body: map[string]string{"ok": "1"}},
		}, nil
	})
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
				return &VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
			},
		},
	}

	result, err := server.VerifyPayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if result.SkipHandler == nil || result.SkipHandler.ContentType != "application/json" {
		t.Fatalf("skipHandler = %+v", result.SkipHandler)
	}
}

func TestOnVerifyFailureHook_RecoverRunsAfterVerify(t *testing.T) {
	afterCalled := false
	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	server.OnVerifyFailure(func(ctx VerifyFailureContext) (*VerifyFailureHookResult, error) {
		return &VerifyFailureHookResult{
			Recovered: true,
			Result:    &VerifyResponse{IsValid: true, Payer: "0xrecovered"},
		}, nil
	})
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		afterCalled = true
		if ctx.Result == nil || ctx.Result.Payer != "0xrecovered" {
			t.Fatalf("unexpected result: %+v", ctx.Result)
		}
		return nil, nil
	})
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
				return nil, errors.New("facilitator error")
			},
		},
	}

	result, err := server.VerifyPayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !result.IsValid || !afterCalled {
		t.Fatalf("result=%+v afterCalled=%v", result, afterCalled)
	}
}

func TestOnVerifyFailureHook_RecoverThenAfterVerifyAbort(t *testing.T) {
	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	server.OnVerifyFailure(func(ctx VerifyFailureContext) (*VerifyFailureHookResult, error) {
		return &VerifyFailureHookResult{
			Recovered: true,
			Result:    &VerifyResponse{IsValid: true, Payer: "0xrecovered"},
		}, nil
	})
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		return &AfterVerifyResult{Abort: true, Reason: "post_recover_abort"}, nil
	})
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
				return nil, errors.New("facilitator error")
			},
		},
	}

	result, err := server.VerifyPayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
	)
	if err == nil {
		t.Fatal("expected abort after recovery")
	}
	if result == nil || result.IsValid || result.InvalidReason != "post_recover_abort" {
		t.Fatalf("got result=%+v", result)
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

func TestBeforeSettleHook_ThrowFailsClosed(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	settleCalls := 0
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			settle: func(ctx context.Context, payload []byte, reqs []byte) (*SettleResponse, error) {
				settleCalls++
				return &SettleResponse{Success: true, Transaction: "0xabc", Network: "eip155:8453", Payer: "0xpayer"}, nil
			},
		},
	}
	server.OnBeforeSettle(func(ctx SettleContext) (*BeforeHookResult, error) {
		return nil, errors.New("Unexpected failure")
	})
	var canceled *VerifiedPaymentCanceledContext
	server.OnVerifiedPaymentCanceled(func(ctx VerifiedPaymentCanceledContext) error {
		copied := ctx
		canceled = &copied
		return nil
	})

	result, err := server.SettlePayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
		nil,
	)
	if result != nil {
		t.Fatalf("result = %+v, want nil", result)
	}
	se := &SettleError{}
	if !errors.As(err, &se) {
		t.Fatalf("got %T (%v), want *SettleError", err, err)
	}
	if se.ErrorReason != "before_settle_hook_error" || se.ErrorMessage != "before settle hook failed" {
		t.Fatalf("reason=%q message=%q", se.ErrorReason, se.ErrorMessage)
	}
	if settleCalls != 0 {
		t.Fatalf("facilitator settle calls = %d", settleCalls)
	}
	if !strings.Contains(logs.String(), "[x402] Resource server beforeSettle hook threw (manual beforeSettle hook #0): Unexpected failure") {
		t.Fatalf("log = %q", logs.String())
	}
	if canceled == nil {
		t.Fatal("expected settlement_preflight_failed cancellation")
	}
	if canceled.Reason != CancellationReasonSettlementPreflightFailed || len(canceled.SettledPhases) != 0 {
		t.Fatalf("reason=%q phases=%v", canceled.Reason, canceled.SettledPhases)
	}
	cancelErr := &SettleError{}
	if !errors.As(canceled.Err, &cancelErr) || cancelErr.ErrorReason != "before_settle_hook_error" {
		t.Fatalf("cancel err = %v", canceled.Err)
	}
}

func TestBeforeSettleHook_TypedErrorFailsClosed(t *testing.T) {
	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	server.OnBeforeSettle(func(ctx SettleContext) (*BeforeHookResult, error) {
		return nil, NewSettleError("insufficient_balance", "0xpayer", "eip155:8453", "", "Not enough funds")
	})

	_, err := server.SettlePayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
		nil,
	)
	se := &SettleError{}
	if !errors.As(err, &se) {
		t.Fatalf("got %T (%v), want *SettleError", err, err)
	}
	if se.ErrorReason != "before_settle_hook_error" || se.ErrorMessage != "before settle hook failed" {
		t.Fatalf("reason=%q message=%q", se.ErrorReason, se.ErrorMessage)
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
	registerExactEvmScheme(server)

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

type mockFailingResponseEnricherScheme struct {
	mockSchemeNetworkServer
}

func (m *mockFailingResponseEnricherScheme) EnrichSettlementResponse(SettleResultContext) (map[string]interface{}, error) {
	return nil, errors.New("enrich failed")
}

func settleWithAfterSettleHook(
	t *testing.T,
	scheme SchemeNetworkServer,
	facilitatorResult *SettleResponse,
	hook AfterSettleHook,
) (*SettleResponse, error) {
	t.Helper()
	server := Newx402ResourceServer()
	server.Register("eip155:8453", scheme)
	server.OnAfterSettle(hook)
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			settle: func(context.Context, []byte, []byte) (*SettleResponse, error) {
				return facilitatorResult, nil
			},
		},
	}
	return server.SettlePayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
		nil,
	)
}

func TestAfterSettleHook_AbortKeepsOnchainReceipt(t *testing.T) {
	onchain := &SettleResponse{
		Success:     true,
		Transaction: "0xdeposit",
		Network:     "eip155:8453",
		Payer:       "0xpayer",
		Amount:      "1000",
		Extra:       map[string]interface{}{"channelState": "kept"},
	}
	result, err := settleWithAfterSettleHook(t, &mockSchemeNetworkServer{scheme: "exact"}, onchain,
		func(SettleResultContext) error { return NewAfterSettleAbort("voucher_store_unavailable", "store down") })
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if result.Success || result.ErrorReason != "voucher_store_unavailable" || result.ErrorMessage != "store down" {
		t.Fatalf("expected failed receipt with abort reason, got %+v", result)
	}
	if result.Transaction != "0xdeposit" || result.Amount != "1000" || result.Payer != "0xpayer" || result.Extra["channelState"] != "kept" {
		t.Fatalf("expected onchain receipt fields kept, got %+v", result)
	}
	if !result.AfterSettleAborted {
		t.Fatal("expected AfterSettleAborted marker")
	}
}

func TestAfterSettleHook_PlainErrorStaysNonFatal(t *testing.T) {
	onchain := &SettleResponse{Success: true, Transaction: "0xdeposit", Network: "eip155:8453"}
	result, err := settleWithAfterSettleHook(t, &mockSchemeNetworkServer{scheme: "exact"}, onchain,
		func(SettleResultContext) error { return errors.New("log only") })
	if err != nil || !result.Success || result.AfterSettleAborted {
		t.Fatalf("expected successful settle, got result=%+v err=%v", result, err)
	}
}

func TestAfterSettleHook_AbortSkipsResponseEnrichment(t *testing.T) {
	onchain := &SettleResponse{Success: true, Transaction: "0xdeposit", Network: "eip155:8453"}
	result, err := settleWithAfterSettleHook(t,
		&mockFailingResponseEnricherScheme{mockSchemeNetworkServer{scheme: "exact"}}, onchain,
		func(SettleResultContext) error { return NewAfterSettleAbort("channel_busy", "") })
	if err != nil {
		t.Fatalf("expected enrichment to be skipped, got %v", err)
	}
	if result.Success || result.Transaction != "0xdeposit" {
		t.Fatalf("expected aborted receipt with transaction, got %+v", result)
	}
}

func TestAfterSettleHook_AbortWithNilSettleResultReturnsError(t *testing.T) {
	_, err := settleWithAfterSettleHook(t, &mockSchemeNetworkServer{scheme: "exact"}, nil,
		func(SettleResultContext) error { return NewAfterSettleAbort("channel_busy", "") })
	var settleErr *SettleError
	if !errors.As(err, &settleErr) || settleErr.ErrorReason != "channel_busy" {
		t.Fatalf("expected SettleError channel_busy, got %v", err)
	}
}

// Note: mockFacilitatorClient is defined in service_test.go

func TestAfterVerifyHook_RunsOnFacilitatorRejection(t *testing.T) {
	afterCalled := false
	server := Newx402ResourceServer()
	registerExactEvmScheme(server)
	server.OnAfterVerify(func(ctx VerifyResultContext) (*AfterVerifyResult, error) {
		afterCalled = true
		if ctx.Result == nil || ctx.Result.IsValid {
			t.Fatalf("expected invalid result, got %+v", ctx.Result)
		}
		return nil, nil
	})
	server.facilitatorClients[Network("eip155:8453")] = map[string]FacilitatorClient{
		"exact": &mockFacilitatorClient{
			verify: func(ctx context.Context, payload []byte, reqs []byte) (*VerifyResponse, error) {
				return &VerifyResponse{IsValid: false, InvalidReason: "mismatch"}, nil
			},
		},
	}

	_, err := server.VerifyPayment(
		context.Background(),
		types.PaymentPayload{X402Version: 2, Payload: map[string]interface{}{}},
		types.PaymentRequirements{Scheme: "exact", Network: "eip155:8453"},
	)
	if err == nil {
		t.Fatal("expected error for invalid facilitator response")
	}
	if !afterCalled {
		t.Fatal("expected afterVerify to run on facilitator rejection")
	}
}
