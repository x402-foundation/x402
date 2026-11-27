package signinwithx

import (
	"strings"
	"testing"
)

func TestSIWEMessageChecksumsAddress(t *testing.T) {
	const checksummed = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
	payload := Payload{
		Domain:   "api.example.com",
		Address:  strings.ToLower(checksummed),
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
