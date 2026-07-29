package signinwithx

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

func TestDeclareExtension(t *testing.T) {
	got := DeclareExtension(DeclareOptions{
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

	if ext.Info.Domain != "" {
		t.Fatalf("domain = %q, want empty at declaration time", ext.Info.Domain)
	}
	if len(ext.Info.Resources) != 0 {
		t.Fatalf("resources = %#v, want empty at declaration time", ext.Info.Resources)
	}
	if ext.Info.Statement != "Sign in to access your purchased content" {
		t.Fatalf("statement = %q", ext.Info.Statement)
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

func TestFormatSIWEMessageWithoutStatement(t *testing.T) {
	payload := testPayload()
	payload.Statement = ""

	got, err := FormatSIWEMessage(payload)
	if err != nil {
		t.Fatalf("FormatSIWEMessage() error = %v", err)
	}

	want := "api.example.com wants you to sign in with your Ethereum account:\n" +
		"0x0000000000000000000000000000000000000001\n\n\n" +
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

func TestFormatSIWSMessage(t *testing.T) {
	payload := testSolanaPayload()

	got, err := FormatSIWSMessage(payload)
	if err != nil {
		t.Fatalf("FormatSIWSMessage() error = %v", err)
	}

	want := "api.example.com wants you to sign in with your Solana account:\n" +
		"6nYoFimREYaxQZZqBv7vbSd6ozGS1J8uhAAgUXPtaYy6\n\n" +
		"Sign in to access your purchased content\n\n" +
		"URI: https://api.example.com/data\n" +
		"Version: 1\n" +
		"Chain ID: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp\n" +
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

func TestExtractSolanaChainReference(t *testing.T) {
	got, err := ExtractSolanaChainReference(SolanaDevnet)
	if err != nil {
		t.Fatalf("ExtractSolanaChainReference() error = %v", err)
	}
	if got != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1" {
		t.Fatalf("reference = %q", got)
	}

	if _, err := ExtractSolanaChainReference("solana:"); err == nil {
		t.Fatal("ExtractSolanaChainReference() error = nil")
	}
}

func TestNormalizeConfiguredOrigin(t *testing.T) {
	got, err := normalizeConfiguredOrigin("https://api.example.com")
	if err != nil {
		t.Fatalf("normalizeConfiguredOrigin() error = %v", err)
	}
	if got.Scheme != "https" || got.Host != "api.example.com" {
		t.Fatalf("origin = %#v", got)
	}

	tests := []struct {
		name   string
		origin string
		want   string
	}{
		{name: "path", origin: "https://api.example.com/profile", want: "must not include a path, query, or fragment"},
		{name: "invalid url", origin: "not-a-url", want: "not a valid URL"},
		{name: "ftp", origin: "ftp://api.example.com", want: "must use http or https"},
		{name: "credentials", origin: "https://user:pass@api.example.com", want: "must not include credentials"},
		{name: "missing", origin: "", want: "siwx origin is required"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := normalizeConfiguredOrigin(tt.origin)
			if err == nil {
				t.Fatal("normalizeConfiguredOrigin() error = nil")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %q, want contains %q", err.Error(), tt.want)
			}
		})
	}
}

func TestValidateMessage(t *testing.T) {
	expectedOrigin := testOriginURL(t)

	payload := testPayload()
	payload.IssuedAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	payload.ExpirationTime = time.Now().Add(time.Minute).UTC().Format(time.RFC3339)

	result := ValidateMessage(payload, expectedOrigin, ValidationOptions{
		CheckNonce: func(nonce string) bool {
			return nonce == "abc123xyz"
		},
	})
	if !result.IsValid {
		t.Fatalf("ValidateMessage() invalid: %s", result.InvalidMessage)
	}

	payload.Domain = "evil.example.com"
	result = ValidateMessage(payload, expectedOrigin, ValidationOptions{})
	if result.IsValid || result.InvalidReason != ErrInvalidSIWxDomainMismatch {
		t.Fatalf("ValidateMessage() = %#v, want domain mismatch", result)
	}

	payload = testPayload()
	payload.IssuedAt = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	payload.URI = "https://api.example.com.attacker.test/data"
	result = ValidateMessage(payload, expectedOrigin, ValidationOptions{})
	if result.IsValid || result.InvalidReason != ErrInvalidSIWxURIMismatch {
		t.Fatalf("ValidateMessage() = %#v, want URI mismatch", result)
	}

	payload.URI = "http://api.example.com/data"
	result = ValidateMessage(payload, expectedOrigin, ValidationOptions{})
	if result.IsValid || result.InvalidReason != ErrInvalidSIWxURIMismatch {
		t.Fatalf("ValidateMessage() = %#v, want URI scheme mismatch", result)
	}

	payload.URI = "not-a-url"
	result = ValidateMessage(payload, expectedOrigin, ValidationOptions{})
	if result.IsValid || result.InvalidReason != ErrInvalidSIWxURIMismatch {
		t.Fatalf("ValidateMessage() = %#v, want invalid URI", result)
	}
}

func TestValidateMessageFailureCodes(t *testing.T) {
	expectedOrigin := testOriginURL(t)
	now := time.Now().UTC()

	tests := []struct {
		name          string
		overrides     func(*Payload)
		options       ValidationOptions
		invalidReason string
	}{
		{
			name: "issued_at",
			overrides: func(payload *Payload) {
				payload.IssuedAt = "not-a-date"
			},
			invalidReason: ErrInvalidSIWxIssuedAt,
		},
		{
			name: "issued_at_too_old",
			overrides: func(payload *Payload) {
				payload.IssuedAt = now.Add(-10 * time.Minute).Format(time.RFC3339)
			},
			invalidReason: ErrInvalidSIWxIssuedAtTooOld,
		},
		{
			name: "issued_at_in_future",
			overrides: func(payload *Payload) {
				payload.IssuedAt = now.Add(60 * time.Second).Format(time.RFC3339)
			},
			invalidReason: ErrInvalidSIWxIssuedAtInFuture,
		},
		{
			name: "expiration_time",
			overrides: func(payload *Payload) {
				payload.IssuedAt = now.Add(-time.Minute).Format(time.RFC3339)
				payload.ExpirationTime = "not-a-date"
			},
			invalidReason: ErrInvalidSIWxExpirationTime,
		},
		{
			name: "expired",
			overrides: func(payload *Payload) {
				payload.IssuedAt = now.Add(-2 * time.Minute).Format(time.RFC3339)
				payload.ExpirationTime = now.Add(-time.Second).Format(time.RFC3339)
			},
			invalidReason: ErrInvalidSIWxExpired,
		},
		{
			name: "not_before",
			overrides: func(payload *Payload) {
				payload.IssuedAt = now.Add(-time.Minute).Format(time.RFC3339)
				payload.NotBefore = "not-a-date"
			},
			invalidReason: ErrInvalidSIWxNotBefore,
		},
		{
			name: "not_yet_valid",
			overrides: func(payload *Payload) {
				payload.IssuedAt = now.Add(-time.Minute).Format(time.RFC3339)
				payload.NotBefore = now.Add(60 * time.Second).Format(time.RFC3339)
			},
			invalidReason: ErrInvalidSIWxNotYetValid,
		},
		{
			name: "nonce",
			overrides: func(payload *Payload) {
				payload.IssuedAt = now.Add(-time.Minute).Format(time.RFC3339)
			},
			options: ValidationOptions{
				CheckNonce: func(string) bool { return false },
			},
			invalidReason: ErrInvalidSIWxNonce,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload := testPayload()
			payload.ExpirationTime = ""
			payload.NotBefore = ""
			tt.overrides(&payload)
			result := ValidateMessage(payload, expectedOrigin, tt.options)
			if result.IsValid {
				t.Fatal("ValidateMessage() valid, want invalid")
			}
			if result.InvalidReason != tt.invalidReason {
				t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, tt.invalidReason)
			}
		})
	}
}

func TestVerifySolanaSignature(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}

	payload := testSolanaPayload()
	payload.Address = EncodeBase58(publicKey)

	message, err := FormatSIWSMessage(payload)
	if err != nil {
		t.Fatalf("FormatSIWSMessage() error = %v", err)
	}
	payload.Signature = EncodeBase58(ed25519.Sign(privateKey, []byte(message)))

	result := VerifySignature(payload)
	if !result.IsValid {
		t.Fatalf("VerifySignature() invalid: %s", result.InvalidMessage)
	}
	if result.Payer != payload.Address {
		t.Fatalf("payer = %q, want %q", result.Payer, payload.Address)
	}

	payload.Signature = EncodeBase58(ed25519.Sign(privateKey, []byte(message+"tampered")))
	result = VerifySignature(payload)
	if result.IsValid {
		t.Fatal("VerifySignature() valid for tampered Solana signature")
	}
	if result.InvalidReason != ErrInvalidSIWxSignature {
		t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxSignature)
	}
}

func TestVerifySolanaSignatureRejectsSmallOrderPublicKey(t *testing.T) {
	publicKey := bytesRepeat(ed25519.PublicKeySize, 0)
	publicKey[0] = 1
	signature := bytesRepeat(ed25519.SignatureSize, 0)
	signature[0] = 1

	if VerifySolanaSignature("arbitrary message", signature, publicKey) {
		t.Fatal("VerifySolanaSignature() valid for small-order public key forgery")
	}

	payload := testSolanaPayload()
	payload.Address = EncodeBase58(publicKey)
	payload.Signature = EncodeBase58(signature)

	result := VerifySignature(payload)
	if result.IsValid {
		t.Fatal("VerifySignature() valid for small-order public key forgery")
	}
	if result.InvalidReason != ErrInvalidSIWxSignature {
		t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxSignature)
	}
}

func TestVerifySolanaSignatureRejectsInvalidBase58(t *testing.T) {
	payload := testSolanaPayload()
	payload.Signature = "0OIl"

	result := VerifySignature(payload)
	if result.IsValid {
		t.Fatal("VerifySignature() valid for invalid Base58 signature")
	}
	if result.InvalidReason != ErrInvalidSIWxMalformedSignature {
		t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxMalformedSignature)
	}
	if !strings.Contains(result.InvalidMessage, "Invalid Base58 encoding") {
		t.Fatalf("InvalidMessage = %q", result.InvalidMessage)
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
	if !result.IsValid {
		t.Fatalf("VerifySignature() invalid: %s", result.InvalidMessage)
	}
	if result.Payer != address.Hex() {
		t.Fatalf("payer = %q, want %q", result.Payer, address.Hex())
	}

	payload.Address = "0x0000000000000000000000000000000000000002"
	result = VerifySignature(payload)
	if result.IsValid {
		t.Fatal("VerifySignature() valid for wrong address")
	}
	if result.InvalidReason != ErrInvalidSIWxSignature {
		t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxSignature)
	}
}

func TestVerifySignatureRejectsUnsupportedChain(t *testing.T) {
	payload := testPayload()
	payload.ChainID = "cosmos:cosmoshub-4"

	result := VerifySignature(payload)
	if result.IsValid {
		t.Fatal("VerifySignature() valid for unsupported chain")
	}
	if result.InvalidReason != ErrInvalidSIWxUnsupportedChain {
		t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxUnsupportedChain)
	}
	if !strings.Contains(result.InvalidMessage, "Unsupported chain namespace") {
		t.Fatalf("InvalidMessage = %q", result.InvalidMessage)
	}
}

func TestVerifySignatureStructuredErrors(t *testing.T) {
	t.Run("malformed_evm_chain_id", func(t *testing.T) {
		payload := testPayload()
		payload.ChainID = "eip155:not-a-number"

		result := VerifySignature(payload)
		if result.IsValid {
			t.Fatal("VerifySignature() valid, want invalid")
		}
		if result.InvalidReason != ErrInvalidSIWxChainID {
			t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxChainID)
		}
		if !strings.Contains(result.InvalidMessage, "invalid EVM chainId format") {
			t.Fatalf("InvalidMessage = %q", result.InvalidMessage)
		}
	})

	t.Run("invalid_solana_signature_length", func(t *testing.T) {
		payload := testSolanaPayload()
		payload.Signature = EncodeBase58(bytesRepeat(32, 0))
		payload.Address = EncodeBase58(bytesRepeat(32, 1))

		result := VerifySignature(payload)
		if result.IsValid {
			t.Fatal("VerifySignature() valid, want invalid")
		}
		if result.InvalidReason != ErrInvalidSIWxMalformedSignature {
			t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxMalformedSignature)
		}
		if !strings.Contains(result.InvalidMessage, "Invalid signature length") {
			t.Fatalf("InvalidMessage = %q", result.InvalidMessage)
		}
	})

	t.Run("empty_solana_chain_reference", func(t *testing.T) {
		payload := testSolanaPayload()
		payload.ChainID = "solana:"

		result := VerifySignature(payload)
		if result.IsValid {
			t.Fatal("VerifySignature() valid, want invalid")
		}
		if result.InvalidReason != ErrInvalidSIWxUnsupportedChain {
			t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxUnsupportedChain)
		}
	})
}

func TestVerifySignatureWithOptionsUsesEVMVerifier(t *testing.T) {
	payload := testPayload()
	payload.Signature = "0x" + strings.Repeat("ab", 96)
	called := false

	result := VerifySignatureWithOptions(context.Background(), payload, VerifyOptions{
		EVMVerifier: func(ctx context.Context, address string, message string, signature string) (bool, error) {
			called = true
			if address != payload.Address {
				t.Fatalf("address = %q, want %q", address, payload.Address)
			}
			if !strings.Contains(message, payload.Address) {
				t.Fatalf("message = %q, want address included", message)
			}
			if signature != payload.Signature {
				t.Fatalf("signature = %q, want %q", signature, payload.Signature)
			}
			return true, nil
		},
	})

	if !called {
		t.Fatal("EVM verifier was not called")
	}
	if !result.IsValid {
		t.Fatalf("VerifySignatureWithOptions() invalid: %s", result.InvalidMessage)
	}
	if result.Payer != common.HexToAddress(payload.Address).Hex() {
		t.Fatalf("payer = %q, want checksum address", result.Payer)
	}
}

func TestVerifySignatureWithOptionsHandlesEVMVerifierFailures(t *testing.T) {
	payload := testPayload()
	payload.Signature = "0x" + strings.Repeat("ab", 96)

	t.Run("invalid", func(t *testing.T) {
		result := VerifySignatureWithOptions(context.Background(), payload, VerifyOptions{
			EVMVerifier: func(context.Context, string, string, string) (bool, error) {
				return false, nil
			},
		})
		if result.IsValid {
			t.Fatal("VerifySignatureWithOptions() valid, want invalid")
		}
		if result.InvalidReason != ErrInvalidSIWxSignature {
			t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxSignature)
		}
		if !strings.Contains(result.InvalidMessage, "Signature verification failed") {
			t.Fatalf("InvalidMessage = %q", result.InvalidMessage)
		}
	})

	t.Run("error", func(t *testing.T) {
		result := VerifySignatureWithOptions(context.Background(), payload, VerifyOptions{
			EVMVerifier: func(context.Context, string, string, string) (bool, error) {
				return false, errors.New("rpc unavailable")
			},
		})
		if result.IsValid {
			t.Fatal("VerifySignatureWithOptions() valid, want invalid")
		}
		if result.InvalidReason != ErrInvalidSIWxVerifierError {
			t.Fatalf("InvalidReason = %q, want %q", result.InvalidReason, ErrInvalidSIWxVerifierError)
		}
		if !strings.Contains(result.InvalidMessage, "rpc unavailable") {
			t.Fatalf("InvalidMessage = %q", result.InvalidMessage)
		}
	})
}

func TestNewUniversalEVMVerifierSupportsEIP1271(t *testing.T) {
	payload := testPayload()
	payload.Address = "0x1234567890123456789012345678901234567890"
	payload.Signature = "0x" + strings.Repeat("ab", 96)

	verifier := NewUniversalEVMVerifier(&testFacilitatorSigner{
		getCodeResult:      []byte{0x60, 0x80},
		readContractResult: []byte{0x16, 0x26, 0xba, 0x7e},
	})

	result := VerifySignatureWithOptions(context.Background(), payload, VerifyOptions{
		EVMVerifier: verifier,
	})
	if !result.IsValid {
		t.Fatalf("VerifySignatureWithOptions() invalid: %s", result.InvalidMessage)
	}
	if result.Payer != common.HexToAddress(payload.Address).Hex() {
		t.Fatalf("payer = %q, want checksum address", result.Payer)
	}
}

func bytesRepeat(n int, value byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = value
	}
	return out
}

type testFacilitatorSigner struct {
	readContractResult interface{}
	readContractError  error
	getCodeResult      []byte
	getCodeError       error
}

func (s *testFacilitatorSigner) GetAddresses() []string {
	return []string{"0x0000000000000000000000000000000000000000"}
}

func (s *testFacilitatorSigner) ReadContract(
	context.Context,
	string,
	[]byte,
	string,
	...interface{},
) (interface{}, error) {
	if s.readContractError != nil {
		return nil, s.readContractError
	}
	return s.readContractResult, nil
}

func (s *testFacilitatorSigner) VerifyTypedData(
	context.Context,
	string,
	evm.TypedDataDomain,
	map[string][]evm.TypedDataField,
	string,
	map[string]interface{},
	[]byte,
) (bool, error) {
	return false, errors.New("not implemented")
}

func (s *testFacilitatorSigner) WriteContract(
	context.Context,
	string,
	[]byte,
	string,
	[]byte,
	...interface{},
) (string, error) {
	return "", errors.New("not implemented")
}

func (s *testFacilitatorSigner) SendTransaction(context.Context, string, []byte) (string, error) {
	return "", errors.New("not implemented")
}

func (s *testFacilitatorSigner) WaitForTransactionReceipt(context.Context, string) (*evm.TransactionReceipt, error) {
	return nil, errors.New("not implemented")
}

func (s *testFacilitatorSigner) GetBalance(context.Context, string, string) (*big.Int, error) {
	return big.NewInt(0), nil
}

func (s *testFacilitatorSigner) GetChainID(context.Context) (*big.Int, error) {
	return big.NewInt(1), nil
}

func (s *testFacilitatorSigner) GetCode(context.Context, string) ([]byte, error) {
	if s.getCodeError != nil {
		return nil, s.getCodeError
	}
	return s.getCodeResult, nil
}

func testOriginURL(t *testing.T) *url.URL {
	t.Helper()
	origin, err := normalizeConfiguredOrigin("https://api.example.com")
	if err != nil {
		t.Fatalf("normalizeConfiguredOrigin() error = %v", err)
	}
	return origin
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

func testSolanaPayload() Payload {
	return Payload{
		Domain:          "api.example.com",
		Address:         "6nYoFimREYaxQZZqBv7vbSd6ozGS1J8uhAAgUXPtaYy6",
		Statement:       "Sign in to access your purchased content",
		URI:             "https://api.example.com/data",
		Version:         Version,
		ChainID:         SolanaMainnet,
		Type:            SignatureTypeEd25519,
		Nonce:           "abc123xyz",
		IssuedAt:        "2026-05-27T00:00:00Z",
		ExpirationTime:  "2026-05-27T00:05:00Z",
		RequestID:       "request-1",
		Resources:       []string{"https://api.example.com/data"},
		SignatureScheme: SignatureSchemeSIWS,
		Signature:       "signature",
	}
}
