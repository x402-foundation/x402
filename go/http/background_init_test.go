package http

import (
	"errors"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
)

func TestIsFatalStartupInitErrorTreatsCapabilityAndRouteErrorsAsFatal(t *testing.T) {
	if !IsFatalStartupInitError(x402.NewFacilitatorCapabilityError([]string{"upto on solana:devnet: missing"})) {
		t.Fatal("expected FacilitatorCapabilityError to be fatal")
	}
	if !IsFatalStartupInitError(&RouteConfigurationError{
		Errors: []RouteValidationError{
			{
				RoutePattern: "GET /api/generate",
				Scheme:       "upto",
				Network:      "solana:devnet",
				Reason:       "missing_facilitator",
				Message:      "missing facilitator",
			},
		},
	}) {
		t.Fatal("expected RouteConfigurationError to be fatal")
	}
}

func TestIsFatalStartupInitErrorTreatsTimeoutsAsRetryable(t *testing.T) {
	if IsFatalStartupInitError(errors.New("facilitator request timed out")) {
		t.Fatal("expected facilitator timeouts to be retryable")
	}
}

func TestHandleBackgroundInitErrorExitsOnCapabilityMismatch(t *testing.T) {
	var exitCode int
	called := false
	orig := processExit
	processExit = func(code int) {
		called = true
		exitCode = code
	}
	t.Cleanup(func() { processExit = orig })

	HandleBackgroundInitError(x402.NewFacilitatorCapabilityError([]string{"upto on solana:devnet: missing"}))

	if !called {
		t.Fatal("expected process exit on capability mismatch")
	}
	if exitCode != 1 {
		t.Fatalf("expected exit code 1, got %d", exitCode)
	}
}

func TestHandleBackgroundInitErrorDoesNotExitOnRetryableTimeout(t *testing.T) {
	called := false
	orig := processExit
	processExit = func(int) { called = true }
	t.Cleanup(func() { processExit = orig })

	HandleBackgroundInitError(errors.New("facilitator request timed out"))

	if called {
		t.Fatal("expected no process exit on retryable facilitator timeout")
	}
}
