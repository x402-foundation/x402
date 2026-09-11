package signinwithx

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/x402-foundation/x402/go/v2/types"
)

type testEVMSigner struct {
	address string
	sign    func(context.Context, string) (string, error)
}

func (s *testEVMSigner) Address() string { return s.address }
func (s *testEVMSigner) SignMessage(ctx context.Context, message string) (string, error) {
	return s.sign(ctx, message)
}

type testSolanaSigner struct {
	address string
	sign    func(context.Context, string) (string, error)
}

func (s *testSolanaSigner) Address() string { return s.address }
func (s *testSolanaSigner) SignMessage(ctx context.Context, message string) (string, error) {
	return s.sign(ctx, message)
}

func TestCreatePayloadSignsEVMDeclaration(t *testing.T) {
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	signer := &testEVMSigner{
		address: address.Hex(),
		sign: func(_ context.Context, message string) (string, error) {
			signature, err := crypto.Sign(accounts.TextHash([]byte(message)), privateKey)
			if err != nil {
				return "", err
			}
			signature[64] += 27
			return "0x" + common.Bytes2Hex(signature), nil
		},
	}
	declaration := Extension{
		Info: Info{
			Domain:         "api.example.com",
			URI:            "https://api.example.com/profile",
			Statement:      "Sign in",
			Version:        Version,
			Nonce:          "nonceabc1",
			IssuedAt:       "2026-06-05T00:00:00Z",
			ExpirationTime: "2026-06-05T00:05:00Z",
			Resources:      []string{"https://api.example.com/profile"},
		},
		SupportedChains: []SupportedChain{
			{ChainID: "solana:mainnet", Type: SignatureTypeEd25519},
			{ChainID: "eip155:8453", Type: SignatureTypeEIP191},
		},
		Schema: Schema(),
	}

	payload, err := CreatePayload(context.Background(), declaration, signer, "https://api.example.com/profile")
	if err != nil {
		t.Fatalf("CreatePayload() error = %v", err)
	}

	if payload.Address != address.Hex() {
		t.Fatalf("address = %q, want %q", payload.Address, address.Hex())
	}
	if payload.ChainID != "eip155:8453" {
		t.Fatalf("chainID = %q", payload.ChainID)
	}
	if payload.Signature == "" {
		t.Fatal("signature is empty")
	}
	result := VerifySignature(payload)
	if !result.IsValid {
		t.Fatalf("VerifySignature() invalid: %s", result.InvalidMessage)
	}
}

func TestCreatePayloadWithSignersSignsSolanaDeclaration(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	signer := &testSolanaSigner{
		address: EncodeBase58(publicKey),
		sign: func(_ context.Context, message string) (string, error) {
			return EncodeBase58(ed25519.Sign(privateKey, []byte(message))), nil
		},
	}
	declaration := Extension{
		Info: Info{
			Domain:         "api.example.com",
			URI:            "https://api.example.com/profile",
			Statement:      "Sign in",
			Version:        Version,
			Nonce:          "nonceabc1",
			IssuedAt:       "2026-06-05T00:00:00Z",
			ExpirationTime: "2026-06-05T00:05:00Z",
			Resources:      []string{"https://api.example.com/profile"},
		},
		SupportedChains: []SupportedChain{
			{ChainID: SolanaMainnet, Type: SignatureTypeEd25519},
			{ChainID: "eip155:8453", Type: SignatureTypeEIP191},
		},
		Schema: Schema(),
	}

	payload, err := CreatePayloadWithSigners(context.Background(), declaration, "https://api.example.com/profile", NewSolanaSIWXSigner(signer))
	if err != nil {
		t.Fatalf("CreatePayloadWithSigners() error = %v", err)
	}

	if payload.Address != signer.Address() {
		t.Fatalf("address = %q, want %q", payload.Address, signer.Address())
	}
	if payload.ChainID != SolanaMainnet {
		t.Fatalf("chainID = %q", payload.ChainID)
	}
	if payload.SignatureScheme != SignatureSchemeSIWS {
		t.Fatalf("signatureScheme = %q", payload.SignatureScheme)
	}
	result := VerifySignature(payload)
	if !result.IsValid {
		t.Fatalf("VerifySignature() invalid: %s", result.InvalidMessage)
	}
}

func TestCreatePayloadWithSignersUsesFirstCompatibleSigner(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	solanaSigner := &testSolanaSigner{
		address: EncodeBase58(publicKey),
		sign: func(_ context.Context, message string) (string, error) {
			return EncodeBase58(ed25519.Sign(privateKey, []byte(message))), nil
		},
	}
	evmSigner := &testEVMSigner{
		address: "0x0000000000000000000000000000000000000001",
		sign: func(context.Context, string) (string, error) {
			t.Fatal("EVM signer should not be called")
			return "", nil
		},
	}

	payload, err := CreatePayloadWithSigners(context.Background(), Extension{
		Info: Info{
			Domain:   "api.example.com",
			URI:      "https://api.example.com/profile",
			Version:  Version,
			Nonce:    "nonceabc1",
			IssuedAt: "2026-06-05T00:00:00Z",
		},
		SupportedChains: []SupportedChain{
			{ChainID: SolanaMainnet, Type: SignatureTypeEd25519},
		},
	}, "https://api.example.com/profile", NewEVMSIWXSigner(evmSigner), NewSolanaSIWXSigner(solanaSigner))
	if err != nil {
		t.Fatalf("CreatePayloadWithSigners() error = %v", err)
	}
	if payload.Type != SignatureTypeEd25519 {
		t.Fatalf("type = %q", payload.Type)
	}
}

func TestCreateHeaderAcceptsJSONDecodedDeclaration(t *testing.T) {
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	signer := &testEVMSigner{
		address: address.Hex(),
		sign: func(_ context.Context, message string) (string, error) {
			signature, err := crypto.Sign(accounts.TextHash([]byte(message)), privateKey)
			if err != nil {
				return "", err
			}
			signature[64] += 27
			return common.Bytes2Hex(signature), nil
		},
	}

	declaration := map[string]interface{}{
		"info": map[string]interface{}{
			"domain":   "api.example.com",
			"uri":      "https://api.example.com/profile",
			"version":  Version,
			"nonce":    "nonceabc2",
			"issuedAt": "2026-06-05T00:00:00Z",
		},
		"supportedChains": []interface{}{
			map[string]interface{}{"chainId": "eip155:8453", "type": SignatureTypeEIP191},
		},
		"schema": Schema(),
	}

	header, err := CreateHeader(context.Background(), declaration, signer, "https://api.example.com/profile")
	if err != nil {
		t.Fatalf("CreateHeader() error = %v", err)
	}
	payload, err := ParseHeader(header)
	if err != nil {
		t.Fatalf("ParseHeader() error = %v", err)
	}
	if !strings.HasPrefix(payload.Signature, "0x") {
		t.Fatalf("signature = %q, want 0x prefix", payload.Signature)
	}
	if result := VerifySignature(payload); !result.IsValid {
		asJSON, _ := json.Marshal(payload)
		t.Fatalf("VerifySignature() invalid: %s payload=%s", result.InvalidMessage, asJSON)
	}
}

func TestCreatePayloadRejectsUnsupportedDeclaration(t *testing.T) {
	signer := &testEVMSigner{
		address: "0x0000000000000000000000000000000000000001",
		sign: func(context.Context, string) (string, error) {
			t.Fatal("sign should not be called")
			return "", nil
		},
	}

	_, err := CreatePayload(context.Background(), Extension{
		Info: Info{
			Domain:  "api.example.com",
			URI:     "https://api.example.com/profile",
			Version: Version,
		},
		SupportedChains: []SupportedChain{
			{ChainID: "solana:mainnet", Type: SignatureTypeEd25519},
		},
	}, signer, "https://api.example.com/profile")
	if err == nil || !strings.Contains(err.Error(), "does not support any configured signer") {
		t.Fatalf("error = %v, want unsupported signer", err)
	}
}

func TestCreatePayloadRequiresSigner(t *testing.T) {
	_, err := CreatePayload(context.Background(), Extension{}, nil, "https://api.example.com/profile")
	if err == nil || !strings.Contains(err.Error(), "signer is required") {
		t.Fatalf("error = %v, want signer required", err)
	}
}

func TestCreateClientHookReturnsSIWXHeader(t *testing.T) {
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	signer := &testEVMSigner{
		address: address.Hex(),
		sign: func(_ context.Context, message string) (string, error) {
			signature, err := crypto.Sign(accounts.TextHash([]byte(message)), privateKey)
			if err != nil {
				return "", err
			}
			signature[64] += 27
			return "0x" + common.Bytes2Hex(signature), nil
		},
	}

	hook := CreateClientHook(signer)
	result, err := hook(context.Background(), types.PaymentRequired{
		X402Version: 2,
		Resource:    &types.ResourceInfo{URL: "https://example.com/resource"},
		Extensions: map[string]interface{}{
			ExtensionKey: Extension{
				Info: Info{
					Domain:   "api.example.com",
					URI:      "https://api.example.com/profile",
					Version:  Version,
					Nonce:    "noncehook",
					IssuedAt: "2026-06-05T00:00:00Z",
				},
				SupportedChains: []SupportedChain{{ChainID: "eip155:8453", Type: SignatureTypeEIP191}},
			},
		},
	}, "https://api.example.com/profile")
	if err != nil {
		t.Fatalf("hook error = %v", err)
	}
	if result == nil || result.Headers[HeaderName] == "" {
		t.Fatalf("result = %#v, want SIWX header", result)
	}
	payload, err := ParseHeader(result.Headers[HeaderName])
	if err != nil {
		t.Fatalf("ParseHeader() error = %v", err)
	}
	if verify := VerifySignature(payload); !verify.IsValid {
		t.Fatalf("VerifySignature() invalid: %s", verify.InvalidMessage)
	}
}

func TestCreateClientHookWithSignersReturnsSolanaHeader(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	signer := &testSolanaSigner{
		address: EncodeBase58(publicKey),
		sign: func(_ context.Context, message string) (string, error) {
			return EncodeBase58(ed25519.Sign(privateKey, []byte(message))), nil
		},
	}

	hook := CreateClientHookWithSigners(NewSolanaSIWXSigner(signer))
	result, err := hook(context.Background(), types.PaymentRequired{
		X402Version: 2,
		Resource:    &types.ResourceInfo{URL: "https://example.com/resource"},
		Extensions: map[string]interface{}{
			ExtensionKey: Extension{
				Info: Info{
					Domain:   "api.example.com",
					URI:      "https://api.example.com/profile",
					Version:  Version,
					Nonce:    "noncehook",
					IssuedAt: "2026-06-05T00:00:00Z",
				},
				SupportedChains: []SupportedChain{{ChainID: SolanaMainnet, Type: SignatureTypeEd25519}},
			},
		},
	}, "https://api.example.com/profile")
	if err != nil {
		t.Fatalf("hook error = %v", err)
	}
	if result == nil || result.Headers[HeaderName] == "" {
		t.Fatalf("result = %#v, want SIWX header", result)
	}
	payload, err := ParseHeader(result.Headers[HeaderName])
	if err != nil {
		t.Fatalf("ParseHeader() error = %v", err)
	}
	if verify := VerifySignature(payload); !verify.IsValid {
		t.Fatalf("VerifySignature() invalid: %s", verify.InvalidMessage)
	}
}

func TestCreateClientHookReturnsNilWithoutDeclaration(t *testing.T) {
	hook := CreateClientHook(&testEVMSigner{})
	result, err := hook(context.Background(), types.PaymentRequired{X402Version: 2}, "http://example.com/resource")
	if err != nil {
		t.Fatalf("hook error = %v", err)
	}
	if result != nil {
		t.Fatalf("result = %#v, want nil", result)
	}
}

func TestCreateClientExtension(t *testing.T) {
	signer := &testEVMSigner{address: "0x0000000000000000000000000000000000000001"}
	extension := CreateClientExtension(signer)
	if extension.Key() != ExtensionKey {
		t.Fatalf("Key() = %q, want %q", extension.Key(), ExtensionKey)
	}
	if extension.PaymentRequiredHook() == nil {
		t.Fatal("PaymentRequiredHook() = nil")
	}

	payload := types.PaymentPayload{X402Version: 2}
	enriched, err := extension.EnrichPaymentPayload(context.Background(), payload, types.PaymentRequired{})
	if err != nil {
		t.Fatalf("EnrichPaymentPayload() error = %v", err)
	}
	if !reflect.DeepEqual(enriched, payload) {
		t.Fatalf("EnrichPaymentPayload() = %#v, want %#v", enriched, payload)
	}
}

func TestCreatePayloadRejectsMismatchedDomain(t *testing.T) {
	signer := &testEVMSigner{
		address: "0x0000000000000000000000000000000000000001",
		sign: func(context.Context, string) (string, error) {
			t.Fatal("sign should not be called")
			return "", nil
		},
	}
	declaration := Extension{
		Info: Info{
			Domain:   "evil.example.com",
			URI:      "https://api.example.com/resource",
			Version:  Version,
			Nonce:    "nonceabc1",
			IssuedAt: "2026-06-05T00:00:00Z",
		},
		SupportedChains: []SupportedChain{
			{ChainID: "eip155:8453", Type: SignatureTypeEIP191},
		},
	}

	_, err := CreatePayload(context.Background(), declaration, signer, "https://api.example.com/resource")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "domain") || !strings.Contains(strings.ToLower(err.Error()), "does not match") {
		t.Fatalf("error = %v, want domain mismatch", err)
	}
}

func TestCreatePayloadRejectsMismatchedURIOrigin(t *testing.T) {
	signer := &testEVMSigner{
		address: "0x0000000000000000000000000000000000000001",
		sign: func(context.Context, string) (string, error) {
			t.Fatal("sign should not be called")
			return "", nil
		},
	}
	declaration := Extension{
		Info: Info{
			Domain:   "api.example.com",
			URI:      "https://evil.example.com/resource",
			Version:  Version,
			Nonce:    "nonceabc1",
			IssuedAt: "2026-06-05T00:00:00Z",
		},
		SupportedChains: []SupportedChain{
			{ChainID: "eip155:8453", Type: SignatureTypeEIP191},
		},
	}

	_, err := CreatePayload(context.Background(), declaration, signer, "https://api.example.com/resource")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "uri origin") || !strings.Contains(strings.ToLower(err.Error()), "does not match") {
		t.Fatalf("error = %v, want uri origin mismatch", err)
	}
}

func TestCreatePayloadSignsWhenBoundToResponseOrigin(t *testing.T) {
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	signer := &testEVMSigner{
		address: address.Hex(),
		sign: func(_ context.Context, message string) (string, error) {
			signature, err := crypto.Sign(accounts.TextHash([]byte(message)), privateKey)
			if err != nil {
				return "", err
			}
			signature[64] += 27
			return "0x" + common.Bytes2Hex(signature), nil
		},
	}
	declaration := Extension{
		Info: Info{
			Domain:   "api.example.com",
			URI:      "https://api.example.com/resource",
			Version:  Version,
			Nonce:    "nonceabc1",
			IssuedAt: "2026-06-05T00:00:00Z",
		},
		SupportedChains: []SupportedChain{
			{ChainID: "eip155:8453", Type: SignatureTypeEIP191},
		},
	}

	payload, err := CreatePayload(context.Background(), declaration, signer, "https://api.example.com/resource")
	if err != nil {
		t.Fatalf("CreatePayload() error = %v", err)
	}
	if payload.Signature == "" {
		t.Fatal("signature is empty")
	}
}

func TestCreatePayloadAllowsCrossOriginResources(t *testing.T) {
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	signer := &testEVMSigner{
		address: address.Hex(),
		sign: func(_ context.Context, message string) (string, error) {
			signature, err := crypto.Sign(accounts.TextHash([]byte(message)), privateKey)
			if err != nil {
				return "", err
			}
			signature[64] += 27
			return "0x" + common.Bytes2Hex(signature), nil
		},
	}
	declaration := Extension{
		Info: Info{
			Domain:    "api.example.com",
			URI:       "https://api.example.com/resource",
			Version:   Version,
			Nonce:     "nonceabc1",
			IssuedAt:  "2026-06-05T00:00:00Z",
			Resources: []string{"https://cdn.other-example.com/asset"},
		},
		SupportedChains: []SupportedChain{
			{ChainID: "eip155:8453", Type: SignatureTypeEIP191},
		},
	}

	payload, err := CreatePayload(context.Background(), declaration, signer, "https://api.example.com/resource")
	if err != nil {
		t.Fatalf("CreatePayload() error = %v", err)
	}
	if payload.Signature == "" {
		t.Fatal("signature is empty")
	}
	if !reflect.DeepEqual(payload.Resources, []string{"https://cdn.other-example.com/asset"}) {
		t.Fatalf("resources = %#v", payload.Resources)
	}
}

func TestAssertChallengeBoundToOriginRejectsInvalidURI(t *testing.T) {
	err := AssertChallengeBoundToOrigin(Info{
		Domain:   "api.example.com",
		URI:      "not-a-url",
		Version:  Version,
		Nonce:    "abc",
		IssuedAt: "2026-06-05T00:00:00Z",
	}, "https://api.example.com/resource")
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "uri") || !strings.Contains(strings.ToLower(err.Error()), "not a valid url") {
		t.Fatalf("error = %v, want invalid uri", err)
	}
}

func TestCreateClientHookDoesNotSignWhenOriginMismatched(t *testing.T) {
	signer := &testEVMSigner{
		address: "0x0000000000000000000000000000000000000001",
		sign: func(context.Context, string) (string, error) {
			t.Fatal("sign should not be called")
			return "", nil
		},
	}
	hook := CreateClientHook(signer)
	result, err := hook(context.Background(), types.PaymentRequired{
		X402Version: 2,
		Resource:    &types.ResourceInfo{URL: "https://example.com/resource"},
		Accepts:     []types.PaymentRequirements{{Network: "eip155:1"}},
		Extensions: map[string]interface{}{
			ExtensionKey: Extension{
				Info: Info{
					Domain:   "evil.example.com",
					URI:      "https://evil.example.com/resource",
					Version:  Version,
					Nonce:    "noncehook",
					IssuedAt: "2026-06-05T00:00:00Z",
				},
				SupportedChains: []SupportedChain{{ChainID: "eip155:1", Type: SignatureTypeEIP191}},
			},
		},
	}, "http://example.com/resource")
	if err != nil {
		t.Fatalf("hook error = %v", err)
	}
	if result != nil {
		t.Fatalf("result = %#v, want nil", result)
	}
}
