package facilitator

import (
	"errors"
	"testing"
)

// The x402 v2 specification lists invalid_exact_evm_payload_signature for an invalid
// authorization signature, and the Python facilitator reports it.
func TestVerifyEIP3009_InvalidSignatureUsesSpecReason(t *testing.T) {
	reason, _ := verifyReasonFor(t, errors.New("execution reverted: EIP3009: invalid signature"))

	if reason != "invalid_exact_evm_payload_signature" {
		t.Fatalf("expected invalid_exact_evm_payload_signature, got %q", reason)
	}
}
