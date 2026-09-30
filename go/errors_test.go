package x402

import "testing"

func TestVerifyErrorMessageFormatting(t *testing.T) {
	withMessage := NewVerifyError("invalid_signature", "0xabc", "signature did not match")
	expected := "invalid_signature: signature did not match"
	if withMessage.Error() != expected {
		t.Fatalf("expected %q, got %q", expected, withMessage.Error())
	}

	withoutMessage := NewVerifyError("missing_signature", "0xabc", "")
	expected = "missing_signature"
	if withoutMessage.Error() != expected {
		t.Fatalf("expected %q, got %q", expected, withoutMessage.Error())
	}
}

func TestSettleErrorMessageFormatting(t *testing.T) {
	withMessage := NewSettleError("transaction_failed", "0xabc", "eip155:1", "0xtx", "execution reverted")
	expected := "transaction_failed: execution reverted"
	if withMessage.Error() != expected {
		t.Fatalf("expected %q, got %q", expected, withMessage.Error())
	}

	withoutMessage := NewSettleError("insufficient_funds", "0xabc", "eip155:1", "0xtx", "")
	expected = "insufficient_funds"
	if withoutMessage.Error() != expected {
		t.Fatalf("expected %q, got %q", expected, withoutMessage.Error())
	}
}
