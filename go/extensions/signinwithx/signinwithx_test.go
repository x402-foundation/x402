package signinwithx

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

func TestDeclareExtension(t *testing.T) {
	got := DeclareExtension(DeclareOptions{
		Domain:            "api.example.com",
		ResourceURI:       "https://api.example.com/data",
		Statement:         "Sign in to access your purchased content",
		Networks:          []string{"eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"},
		ExpirationSeconds: 300,
	})

	raw, ok := got[ExtensionKey]
	if !ok {
		t.Fatalf("missing %q extension", ExtensionKey)
	}

	ext, ok := raw.(Extension)
	if !ok {
		t.Fatalf("extension type = %T, want Extension", raw)
	}

	if ext.Info.Domain != "api.example.com" {
		t.Fatalf("domain = %q", ext.Info.Domain)
	}
	if len(ext.Info.Resources) != 1 || ext.Info.Resources[0] != "https://api.example.com/data" {
		t.Fatalf("resources = %#v", ext.Info.Resources)
	}
	if len(ext.SupportedChains) != 2 {
		t.Fatalf("supportedChains length = %d", len(ext.SupportedChains))
	}
	if ext.SupportedChains[0].Type != SignatureTypeEIP191 {
		t.Fatalf("EVM signature type = %q", ext.SupportedChains[0].Type)
	}
	if ext.SupportedChains[1].Type != SignatureTypeEd25519 {
		t.Fatalf("Solana signature type = %q", ext.SupportedChains[1].Type)
	}
}

func TestEncodeParseHeaderRoundTrip(t *testing.T) {
	payload := testPayload()

	header, err := EncodeHeader(payload)
	if err != nil {
		t.Fatalf("EncodeHeader() error = %v", err)
	}

	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		t.Fatalf("header is not base64: %v", err)
	}
	if !json.Valid(decoded) {
		t.Fatalf("decoded header is not JSON: %s", decoded)
	}

	got, err := ParseHeader(header)
	if err != nil {
		t.Fatalf("ParseHeader() error = %v", err)
	}
	if !reflect.DeepEqual(got, payload) {
		t.Fatalf("payload = %#v, want %#v", got, payload)
	}
}

func TestParseHeaderRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
	}{
		{
			name:   "invalid base64",
			header: "not base64",
			want:   "not valid base64",
		},
		{
			name:   "invalid json",
			header: base64.StdEncoding.EncodeToString([]byte("{")),
			want:   "not valid JSON",
		},
		{
			name:   "missing required field",
			header: base64.StdEncoding.EncodeToString([]byte(`{"domain":"api.example.com"}`)),
			want:   "missing required field",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseHeader(tt.header)
			if err == nil {
				t.Fatal("ParseHeader() error = nil")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %q, want contains %q", err.Error(), tt.want)
			}
		})
	}
}

func TestFormatSIWEMessage(t *testing.T) {
	payload := testPayload()

	got, err := FormatSIWEMessage(payload)
	if err != nil {
		t.Fatalf("FormatSIWEMessage() error = %v", err)
	}

	want := "api.example.com wants you to sign in with your Ethereum account:\n" +
		"0x0000000000000000000000000000000000000001\n\n" +
		"Sign in to access your purchased content\n\n" +
		"URI: https://api.example.com/data\n" +
		"Version: 1\n" +
		"Chain ID: 8453\n" +
		"Nonce: abc123xyz\n" +
		"Issued At: 2026-05-27T00:00:00Z\n" +
		"Expiration Time: 2026-05-27T00:05:00Z\n" +
		"Request ID: request-1\n" +
		"Resources:\n" +
		"- https://api.example.com/data"

	if got != want {
		t.Fatalf("message =\n%s\nwant =\n%s", got, want)
	}
}

func TestValidateMessage(t *testing.T) {
	payload := testPayload()
	payload.IssuedAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	payload.ExpirationTime = time.Now().Add(time.Minute).UTC().Format(time.RFC3339)

	result := ValidateMessage(payload, "https://api.example.com/data", ValidationOptions{
		CheckNonce: func(nonce string) bool {
			return nonce == "abc123xyz"
		},
	})
	if !result.Valid {
		t.Fatalf("ValidateMessage() invalid: %s", result.Error)
	}

	payload.Domain = "evil.example.com"
	result = ValidateMessage(payload, "https://api.example.com/data", ValidationOptions{})
	if result.Valid || !strings.Contains(result.Error, "Domain mismatch") {
		t.Fatalf("ValidateMessage() = %#v, want domain mismatch", result)
	}
}

func TestVerifyEVMSignature(t *testing.T) {
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	payload := testPayload()
	payload.Address = address.Hex()

	message, err := FormatSIWEMessage(payload)
	if err != nil {
		t.Fatalf("FormatSIWEMessage() error = %v", err)
	}

	signature, err := crypto.Sign(accounts.TextHash([]byte(message)), privateKey)
	if err != nil {
		t.Fatalf("Sign() error = %v", err)
	}
	signature[64] += 27
	payload.Signature = "0x" + common.Bytes2Hex(signature)

	result := VerifySignature(payload)
	if !result.Valid {
		t.Fatalf("VerifySignature() invalid: %s", result.Error)
	}
	if result.Address != address.Hex() {
		t.Fatalf("address = %q, want %q", result.Address, address.Hex())
	}

	payload.Address = "0x0000000000000000000000000000000000000002"
	result = VerifySignature(payload)
	if result.Valid {
		t.Fatal("VerifySignature() valid for wrong address")
	}
}

func TestVerifySignatureRejectsUnsupportedChain(t *testing.T) {
	payload := testPayload()
	payload.ChainID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

	result := VerifySignature(payload)
	if result.Valid {
		t.Fatal("VerifySignature() valid for unsupported chain")
	}
	if !strings.Contains(result.Error, "Unsupported chain namespace") {
		t.Fatalf("error = %q", result.Error)
	}
}

func testPayload() Payload {
	return Payload{
		Domain:         "api.example.com",
		Address:        "0x0000000000000000000000000000000000000001",
		Statement:      "Sign in to access your purchased content",
		URI:            "https://api.example.com/data",
		Version:        Version,
		ChainID:        "eip155:8453",
		Type:           SignatureTypeEIP191,
		Nonce:          "abc123xyz",
		IssuedAt:       "2026-05-27T00:00:00Z",
		ExpirationTime: "2026-05-27T00:05:00Z",
		RequestID:      "request-1",
		Resources:      []string{"https://api.example.com/data"},
		Signature:      "0xsignature",
	}
}
