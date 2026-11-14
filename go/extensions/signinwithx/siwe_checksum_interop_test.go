package signinwithx

import (
	"strings"
	"testing"
)

// TestSIWEMessageChecksumsAddress asserts that the SIWE message built from a
// payload carrying a non-EIP-55 (lowercase) address renders the EIP-55
// checksummed address on the account line, matching the TypeScript
// implementation (@signinwithethereum/siwe) and the EIP-4361 requirement that
// the address be "conformant to capitalization encoded checksum specified in
// EIP-55". Without this, a signature produced by a TS client (whose library
// always checksums) is rebuilt by this Go facilitator with a lowercase address
// line and rejected, breaking cross-implementation SIWX interop.
func TestSIWEMessageChecksumsAddress(t *testing.T) {
	const checksummed = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
	payload := Payload{
		Domain:   "api.example.com",
		Address:  strings.ToLower(checksummed), // schema accepts non-checksummed
		URI:      "https://api.example.com/data",
		Version:  "1",
		ChainID:  "eip155:8453",
		Nonce:    "abcdef12345678",
		IssuedAt: "2024-01-01T00:00:00.000Z",
	}
	msg, err := FormatSIWEMessage(payload)
	if err != nil {
		t.Fatalf("FormatSIWEMessage error: %v", err)
	}
	addrLine := strings.Split(msg, "\n")[1]
	if addrLine != checksummed {
		t.Fatalf("address line = %q, want EIP-55 checksummed %q", addrLine, checksummed)
	}
}
