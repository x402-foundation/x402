package facilitator

import (
	"context"
	"errors"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// The x402 v2 specification lists invalid_exact_evm_payload_recipient_mismatch for an
// authorization whose recipient differs from payTo, and the Python facilitator reports it.
func TestVerifyEIP3009_RecipientMismatchUsesSpecReason(t *testing.T) {
	payload, requirements := contractPayerPayload(t)
	requirements.PayTo = "0x0000000000000000000000000000000000000001"
	payload.Accepted = requirements
	scheme := NewExactEvmScheme(&contractPayerMockSigner{}, &ExactEvmSchemeConfig{})

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)

	ve := &x402.VerifyError{}
	if !errors.As(err, &ve) {
		t.Fatalf("expected *x402.VerifyError, got %T: %v", err, err)
	}
	if ve.InvalidReason != "invalid_exact_evm_payload_recipient_mismatch" {
		t.Fatalf("expected invalid_exact_evm_payload_recipient_mismatch, got %q", ve.InvalidReason)
	}
}
