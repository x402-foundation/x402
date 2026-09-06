package x402

import (
	"context"
	"errors"
	"testing"

	"github.com/x402-foundation/x402/go/v2/types"
)

// Unit tests for the resource server's single automatic settle retry on
// settlement_pending (isRetryableSettlementPending / settleWithPendingRetry,
// server.go), and for the success:false -> onSettleFailure routing fix.
// Mirrors TS's x402ResourceServer.settlementPending.test.ts and Python's
// test_settle_pending_retry.py.

func pendingSettleResponse(transaction string) *SettleResponse {
	return &SettleResponse{
		Success:     false,
		ErrorReason: ErrSettlementPending,
		Transaction: transaction,
		Network:     "eip155:8453",
	}
}

func successSettleResponse(transaction string) *SettleResponse {
	return &SettleResponse{Success: true, Transaction: transaction, Network: "eip155:8453"}
}

func terminalFailureSettleResponse(reason string) *SettleResponse {
	return &SettleResponse{Success: false, ErrorReason: reason, Transaction: "", Network: "eip155:8453"}
}

func TestIsRetryableSettlementPending_ReturnedResult(t *testing.T) {
	tests := []struct {
		name   string
		result *SettleResponse
		want   bool
	}{
		{"pending with transaction is retryable", pendingSettleResponse("0xabc"), true},
		{"success is not retryable", successSettleResponse("0xabc"), false},
		{"other failure reason is not retryable", terminalFailureSettleResponse("invalid_signature"), false},
		{"pending without transaction is not retryable", pendingSettleResponse(""), false},
		{"nil result is not retryable", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRetryableSettlementPending(tt.result, nil); got != tt.want {
				t.Errorf("isRetryableSettlementPending(%+v, nil) = %v, want %v", tt.result, got, tt.want)
			}
		})
	}
}

func TestIsRetryableSettlementPending_ThrownError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{
			"thrown SettleError with pending reason and transaction is retryable",
			NewSettleError(ErrSettlementPending, "0xpayer", "eip155:8453", "0xabc", ""),
			true,
		},
		{
			"thrown SettleError with pending reason but no transaction is not retryable",
			NewSettleError(ErrSettlementPending, "0xpayer", "eip155:8453", "", ""),
			false,
		},
		{
			"thrown SettleError with a different reason is not retryable",
			NewSettleError("invalid_signature", "0xpayer", "eip155:8453", "0xabc", ""),
			false,
		},
		{
			"a non-SettleError is not retryable",
			errors.New("boom"),
			false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// A thrown error always wins over any returned result, so the result
			// argument is irrelevant here; pass nil to isolate the error path.
			if got := isRetryableSettlementPending(nil, tt.err); got != tt.want {
				t.Errorf("isRetryableSettlementPending(nil, %v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// queueFacilitatorClient serves canned (response, error) pairs from settleResponses/
// settleErrors in order and records every call's raw bytes, so tests can assert
// both the call count and that a retry resends byte-identical payload/requirements.
type queueFacilitatorClient struct {
	settleResponses []*SettleResponse
	settleErrors    []error
	settleCalls     [][2][]byte
}

func (c *queueFacilitatorClient) Settle(_ context.Context, payloadBytes []byte, requirementsBytes []byte) (*SettleResponse, error) {
	c.settleCalls = append(c.settleCalls, [2][]byte{payloadBytes, requirementsBytes})
	i := len(c.settleCalls) - 1
	var err error
	if i < len(c.settleErrors) {
		err = c.settleErrors[i]
	}
	var resp *SettleResponse
	if i < len(c.settleResponses) {
		resp = c.settleResponses[i]
	}
	return resp, err
}

func (c *queueFacilitatorClient) Verify(_ context.Context, _ []byte, _ []byte) (*VerifyResponse, error) {
	return &VerifyResponse{IsValid: true}, nil
}

func (c *queueFacilitatorClient) GetSupported(_ context.Context) (SupportedResponse, error) {
	return SupportedResponse{Kinds: []SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:8453"}}}, nil
}

func TestSettleWithPendingRetry_NoRetryOnSuccess(t *testing.T) {
	client := &queueFacilitatorClient{settleResponses: []*SettleResponse{successSettleResponse("0x1")}}

	result, err := settleWithPendingRetry(context.Background(), client, []byte("payload"), []byte("reqs"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success {
		t.Fatal("expected success")
	}
	if len(client.settleCalls) != 1 {
		t.Fatalf("expected 1 settle call, got %d", len(client.settleCalls))
	}
}

func TestSettleWithPendingRetry_NoRetryOnTerminalFailure(t *testing.T) {
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{terminalFailureSettleResponse("invalid_signature")},
	}

	result, err := settleWithPendingRetry(context.Background(), client, []byte("payload"), []byte("reqs"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Success || result.ErrorReason != "invalid_signature" {
		t.Fatalf("expected terminal failure to pass through unchanged, got %+v", result)
	}
	if len(client.settleCalls) != 1 {
		t.Fatalf("expected 1 settle call, got %d", len(client.settleCalls))
	}
}

func TestSettleWithPendingRetry_SingleRetryOnPendingThenSuccess(t *testing.T) {
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{pendingSettleResponse("0xpending"), successSettleResponse("0xconfirmed")},
	}

	result, err := settleWithPendingRetry(context.Background(), client, []byte("payload"), []byte("reqs"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success || result.Transaction != "0xconfirmed" {
		t.Fatalf("expected retried success, got %+v", result)
	}
	if len(client.settleCalls) != 2 {
		t.Fatalf("expected 2 settle calls, got %d", len(client.settleCalls))
	}
}

func TestSettleWithPendingRetry_RetriesOnThrownSettlementPendingError(t *testing.T) {
	client := &queueFacilitatorClient{
		settleErrors:    []error{NewSettleError(ErrSettlementPending, "0xpayer", "eip155:8453", "0xpending", "")},
		settleResponses: []*SettleResponse{nil, successSettleResponse("0xpending")},
	}

	result, err := settleWithPendingRetry(context.Background(), client, []byte("payload"), []byte("reqs"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected retried success, got %+v", result)
	}
	if len(client.settleCalls) != 2 {
		t.Fatalf("expected 2 settle calls, got %d", len(client.settleCalls))
	}
}

func TestSettleWithPendingRetry_CappedAtOneRetryWhenSecondAttemptAlsoPending(t *testing.T) {
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{pendingSettleResponse("0xfirst"), pendingSettleResponse("0xsecond")},
	}

	result, err := settleWithPendingRetry(context.Background(), client, []byte("payload"), []byte("reqs"))

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Success || result.Transaction != "0xsecond" {
		t.Fatalf("expected the second (still-pending) response returned as-is, got %+v", result)
	}
	if len(client.settleCalls) != 2 {
		t.Fatalf("expected exactly 2 settle calls (no third attempt), got %d", len(client.settleCalls))
	}
}

func TestSettleWithPendingRetry_RetriesWithByteIdenticalPayloadAndRequirements(t *testing.T) {
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{pendingSettleResponse("0xpending"), successSettleResponse("0x1")},
	}
	payloadBytes := []byte(`{"a":1}`)
	requirementsBytes := []byte(`{"b":2}`)

	_, err := settleWithPendingRetry(context.Background(), client, payloadBytes, requirementsBytes)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(client.settleCalls) != 2 {
		t.Fatalf("expected 2 settle calls, got %d", len(client.settleCalls))
	}
	if string(client.settleCalls[0][0]) != string(client.settleCalls[1][0]) {
		t.Error("expected identical payload bytes on both attempts")
	}
	if string(client.settleCalls[0][1]) != string(client.settleCalls[1][1]) {
		t.Error("expected identical requirements bytes on both attempts")
	}
}

// ============================================================================
// End-to-end x402ResourceServer.SettlePayment retry routing
// ============================================================================

func settlementPendingTestFixture() (types.PaymentRequirements, types.PaymentPayload) {
	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:8453",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xrecipient",
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}
	return requirements, payload
}

func TestSettlePayment_RetriesOnceOnReturnedSettlementPendingThenSucceeds(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{pendingSettleResponse("0xpending"), successSettleResponse("0xconfirmed")},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	requirements, payload := settlementPendingTestFixture()

	result, err := server.SettlePayment(ctx, payload, requirements, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success || result.Transaction != "0xconfirmed" {
		t.Fatalf("expected retried success, got %+v", result)
	}
	if len(client.settleCalls) != 2 {
		t.Fatalf("expected 2 settle calls, got %d", len(client.settleCalls))
	}
}

func TestSettlePayment_DoesNotRetryOnNonPendingFailure(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{terminalFailureSettleResponse("invalid_signature")},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	requirements, payload := settlementPendingTestFixture()

	result, err := server.SettlePayment(ctx, payload, requirements, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Success || result.ErrorReason != "invalid_signature" {
		t.Fatalf("expected non-pending failure to pass through unchanged, got %+v", result)
	}
	if len(client.settleCalls) != 1 {
		t.Fatalf("expected 1 settle call, got %d", len(client.settleCalls))
	}
}

func TestSettlePayment_DoesNotRetryOnPendingWithEmptyTransaction(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{settleResponses: []*SettleResponse{pendingSettleResponse("")}}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	requirements, payload := settlementPendingTestFixture()

	result, err := server.SettlePayment(ctx, payload, requirements, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Success {
		t.Fatalf("expected failure, got %+v", result)
	}
	if len(client.settleCalls) != 1 {
		t.Fatalf("expected 1 settle call, got %d", len(client.settleCalls))
	}
}

func TestSettlePayment_CappedRetryStillPendingRoutesThroughOnSettleFailure(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{pendingSettleResponse("0xfirst"), pendingSettleResponse("0xsecond")},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	hookCalls := 0
	server.OnSettleFailure(func(ctx SettleFailureContext) (*SettleFailureHookResult, error) {
		hookCalls++
		return nil, nil
	})
	requirements, payload := settlementPendingTestFixture()

	result, err := server.SettlePayment(ctx, payload, requirements, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Success || result.Transaction != "0xsecond" {
		t.Fatalf("expected the still-pending retry result, got %+v", result)
	}
	if hookCalls != 1 {
		t.Fatalf("expected onSettleFailure to run exactly once, got %d", hookCalls)
	}
	if len(client.settleCalls) != 2 {
		t.Fatalf("expected exactly 2 settle calls (no third attempt), got %d", len(client.settleCalls))
	}
}

func TestSettlePayment_SuccessFalseRoutesThroughOnSettleFailureAndRecovers(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{terminalFailureSettleResponse("invalid_signature")},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	recovered := successSettleResponse("0xrecovered")
	var capturedErr error
	server.OnSettleFailure(func(ctx SettleFailureContext) (*SettleFailureHookResult, error) {
		capturedErr = ctx.Error
		return &SettleFailureHookResult{Recovered: true, Result: recovered}, nil
	})
	requirements, payload := settlementPendingTestFixture()

	result, err := server.SettlePayment(ctx, payload, requirements, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != recovered {
		t.Fatalf("expected the recovered result, got %+v", result)
	}
	if capturedErr == nil || capturedErr.Error() == "" {
		t.Fatal("expected onSettleFailure to receive a non-empty synthesized error")
	}
}

func TestSettlePayment_SuccessFalseReturnedAsIsWhenNoHookRecovers(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{terminalFailureSettleResponse("invalid_signature")},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	hookCalls := 0
	server.OnSettleFailure(func(ctx SettleFailureContext) (*SettleFailureHookResult, error) {
		hookCalls++
		return nil, nil
	})
	requirements, payload := settlementPendingTestFixture()

	result, err := server.SettlePayment(ctx, payload, requirements, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hookCalls != 1 {
		t.Fatalf("expected onSettleFailure to run exactly once, got %d", hookCalls)
	}
	if result.Success || result.ErrorReason != "invalid_signature" {
		t.Fatalf("expected the original failure returned unchanged, got %+v", result)
	}
}

func TestSettlePayment_DoesNotRunAfterSettleHooksOnFinalFailure(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{
		settleResponses: []*SettleResponse{terminalFailureSettleResponse("invalid_signature")},
	}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	afterSettleCalls := 0
	server.OnAfterSettle(func(ctx SettleResultContext) error {
		afterSettleCalls++
		return nil
	})
	requirements, payload := settlementPendingTestFixture()

	if _, err := server.SettlePayment(ctx, payload, requirements, nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if afterSettleCalls != 0 {
		t.Fatalf("expected afterSettle not to run on a success:false result, got %d calls", afterSettleCalls)
	}
}

func TestSettlePayment_SuccessTrueRunsAfterSettleNotOnSettleFailure(t *testing.T) {
	ctx := context.Background()
	client := &queueFacilitatorClient{settleResponses: []*SettleResponse{successSettleResponse("0x1")}}
	server := Newx402ResourceServer(WithFacilitatorClient(client))
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("failed to initialize server: %v", err)
	}
	afterSettleCalls, onSettleFailureCalls := 0, 0
	server.OnAfterSettle(func(ctx SettleResultContext) error {
		afterSettleCalls++
		return nil
	})
	server.OnSettleFailure(func(ctx SettleFailureContext) (*SettleFailureHookResult, error) {
		onSettleFailureCalls++
		return nil, nil
	})
	requirements, payload := settlementPendingTestFixture()

	result, err := server.SettlePayment(ctx, payload, requirements, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got %+v", result)
	}
	if afterSettleCalls != 1 {
		t.Fatalf("expected afterSettle to run once, got %d", afterSettleCalls)
	}
	if onSettleFailureCalls != 0 {
		t.Fatalf("expected onSettleFailure not to run, got %d", onSettleFailureCalls)
	}
}
