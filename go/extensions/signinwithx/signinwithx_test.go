package signinwithx

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
)

// freshInfo returns a complete challenge with a current issuedAt so validation
// passes. chainID selects the chain; statement is included by default.
func freshInfo(chainID string, typ SignatureType) CompleteInfo {
	return CompleteInfo{
		Info: Info{
			Domain:    "api.example.com",
			URI:       "https://api.example.com/data",
			Statement: "Sign in to access your content",
			Version:   "1",
			Nonce:     "abc123def456",
			IssuedAt:  time.Now().UTC().Format(isoMillis),
			Resources: []string{"https://api.example.com/data"},
		},
		ChainID: chainID,
		Type:    typ,
	}
}

// TestFormatSIWE_MatchesSpecExample pins the EIP-4361 message bytes to the
// worked example in specs/extensions/sign-in-with-x.md. The signature is taken
// over these exact bytes, so any drift here breaks interop with other SDKs.
func TestFormatSIWE_MatchesSpecExample(t *testing.T) {
	f := messageFields{
		domain:         "api.example.com",
		address:        "0x857b06519E91e3A54538791bDbb0E22373e36b66",
		uri:            "https://api.example.com/premium-data",
		statement:      "Sign in to access premium data",
		version:        "1",
		chainID:        "eip155:8453",
		nonce:          "a1b2c3d4e5f67890a1b2c3d4e5f67890",
		issuedAt:       "2024-01-15T10:30:00.000Z",
		expirationTime: "2024-01-15T10:35:00.000Z",
		resources:      []string{"https://api.example.com/premium-data"},
	}
	want := strings.Join([]string{
		"api.example.com wants you to sign in with your Ethereum account:",
		"0x857b06519E91e3A54538791bDbb0E22373e36b66",
		"",
		"Sign in to access premium data",
		"",
		"URI: https://api.example.com/premium-data",
		"Version: 1",
		"Chain ID: 8453",
		"Nonce: a1b2c3d4e5f67890a1b2c3d4e5f67890",
		"Issued At: 2024-01-15T10:30:00.000Z",
		"Expiration Time: 2024-01-15T10:35:00.000Z",
		"Resources:",
		"- https://api.example.com/premium-data",
	}, "\n")

	got, err := formatSIWE("eip155:8453", f)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("SIWE message mismatch:\n--- got ---\n%q\n--- want ---\n%q", got, want)
	}
}

// TestFormatSIWE_NoStatement covers the EIP-4361 ABNF edge: with no statement
// the address is followed by two blank lines.
func TestFormatSIWE_NoStatement(t *testing.T) {
	got, err := formatSIWE("eip155:1", messageFields{
		domain: "x.test", address: "0xabc", uri: "https://x.test", version: "1",
		chainID: "eip155:1", nonce: "n", issuedAt: "2024-01-15T10:30:00.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "x.test wants you to sign in with your Ethereum account:\n0xabc\n\n\nURI: https://x.test\nVersion: 1\nChain ID: 1\nNonce: n\nIssued At: 2024-01-15T10:30:00.000Z"
	if got != want {
		t.Fatalf("no-statement SIWE mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestFormatSIWS_MatchesSpecExample(t *testing.T) {
	f := messageFields{
		domain:    "api.example.com",
		address:   "BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW",
		uri:       "https://api.example.com/premium-data",
		statement: "Sign in to access premium data",
		version:   "1",
		chainID:   SolanaMainnet,
		nonce:     "a1b2c3d4e5f67890a1b2c3d4e5f67890",
		issuedAt:  "2024-01-15T10:30:00.000Z",
	}
	want := strings.Join([]string{
		"api.example.com wants you to sign in with your Solana account:",
		"BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW",
		"",
		"Sign in to access premium data",
		"",
		"URI: https://api.example.com/premium-data",
		"Version: 1",
		"Chain ID: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
		"Nonce: a1b2c3d4e5f67890a1b2c3d4e5f67890",
		"Issued At: 2024-01-15T10:30:00.000Z",
	}, "\n")
	if got := formatSIWS(SolanaMainnet, f); got != want {
		t.Fatalf("SIWS message mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestEVM_SignVerifyRoundTrip(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	info := freshInfo("eip155:8453", SignatureTypeEIP191)

	payload, err := BuildPayloadEVM(info, key)
	if err != nil {
		t.Fatal(err)
	}
	want := crypto.PubkeyToAddress(key.PublicKey).Hex()
	if payload.Address != want {
		t.Fatalf("payload address = %s, want %s", payload.Address, want)
	}

	res := Verify(context.Background(), payload, info.URI, ValidationOptions{}, nil)
	if !res.Valid {
		t.Fatalf("verify failed: %s", res.Error)
	}
	if res.Address != want {
		t.Fatalf("verified address = %s, want %s", res.Address, want)
	}
}

func TestEVM_RejectsTamperedMessage(t *testing.T) {
	key, _ := crypto.GenerateKey()
	info := freshInfo("eip155:8453", SignatureTypeEIP191)
	payload, _ := BuildPayloadEVM(info, key)

	payload.Nonce = "tampered" // signature no longer matches the message
	if res := VerifySignature(context.Background(), payload, nil); res.Valid {
		t.Fatal("expected verification to fail for a tampered message")
	}
}

func TestSolana_SignVerifyRoundTrip(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	info := freshInfo(SolanaMainnet, SignatureTypeEd25519)

	payload, err := BuildPayloadSolana(info, priv)
	if err != nil {
		t.Fatal(err)
	}
	res := Verify(context.Background(), payload, info.URI, ValidationOptions{}, nil)
	if !res.Valid {
		t.Fatalf("verify failed: %s", res.Error)
	}
	if res.Address != payload.Address {
		t.Fatalf("verified address = %s, want %s", res.Address, payload.Address)
	}
}

func TestValidateMessage(t *testing.T) {
	key, _ := crypto.GenerateKey()
	const uri = "https://api.example.com/data"

	build := func(mutate func(*CompleteInfo)) Payload {
		info := freshInfo("eip155:8453", SignatureTypeEIP191)
		if mutate != nil {
			mutate(&info)
		}
		p, _ := BuildPayloadEVM(info, key)
		return p
	}

	old := time.Now().UTC().Add(-10 * time.Minute).Format(isoMillis)
	future := time.Now().UTC().Add(10 * time.Minute).Format(isoMillis)

	tests := []struct {
		name    string
		payload Payload
		opts    ValidationOptions
		wantErr bool
	}{
		{"valid", build(nil), ValidationOptions{}, false},
		{"domain mismatch", build(func(i *CompleteInfo) { i.Domain = "evil.test" }), ValidationOptions{}, true},
		{"uri mismatch", build(func(i *CompleteInfo) { i.URI = "https://evil.test/data" }), ValidationOptions{}, true},
		{"issuedAt too old", build(func(i *CompleteInfo) { i.IssuedAt = old }), ValidationOptions{}, true},
		{"notBefore in future", build(func(i *CompleteInfo) { i.NotBefore = future }), ValidationOptions{}, true},
		{"expired", build(func(i *CompleteInfo) { i.ExpirationTime = old }), ValidationOptions{}, true},
		{"nonce replay", build(nil), ValidationOptions{CheckNonce: func(string) bool { return false }}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := ValidateMessage(tc.payload, uri, tc.opts)
			if res.Valid == tc.wantErr {
				t.Fatalf("valid=%v wantErr=%v (error: %s)", res.Valid, tc.wantErr, res.Error)
			}
		})
	}
}

func TestHeaderRoundTrip(t *testing.T) {
	key, _ := crypto.GenerateKey()
	payload, _ := BuildPayloadEVM(freshInfo("eip155:8453", SignatureTypeEIP191), key)

	header, err := EncodeHeader(payload)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if got.Address != payload.Address || got.Signature != payload.Signature || got.Nonce != payload.Nonce {
		t.Fatal("round-tripped payload differs from original")
	}

	if _, err := ParseHeader("not-base64!!!"); err == nil {
		t.Fatal("expected error for invalid base64 header")
	}
	if _, err := ParseHeader(""); err == nil {
		t.Fatal("expected error for empty header")
	}
}

func TestDeclareExtension(t *testing.T) {
	secs := 300
	ext, err := DeclareExtension(DeclareOptions{
		ResourceURI:       "https://api.example.com/data",
		Networks:          []string{"eip155:8453", SolanaMainnet},
		Statement:         "Sign in",
		ExpirationSeconds: &secs,
	})
	if err != nil {
		t.Fatal(err)
	}
	if ext.Info.Domain != "api.example.com" {
		t.Fatalf("domain = %q, want api.example.com", ext.Info.Domain)
	}
	if ext.Info.Nonce == "" || ext.Info.IssuedAt == "" || ext.Info.ExpirationTime == "" {
		t.Fatal("nonce, issuedAt, and expirationTime must be set")
	}
	if len(ext.SupportedChains) != 2 ||
		ext.SupportedChains[0].Type != SignatureTypeEIP191 ||
		ext.SupportedChains[1].Type != SignatureTypeEd25519 {
		t.Fatalf("unexpected supportedChains: %+v", ext.SupportedChains)
	}

	// Each call must mint a fresh nonce.
	ext2, _ := DeclareExtension(DeclareOptions{ResourceURI: "https://api.example.com/data"})
	if ext.Info.Nonce == ext2.Info.Nonce {
		t.Fatal("nonce must be unique per declaration")
	}
}
