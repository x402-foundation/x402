package signinwithx

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/types"
)

type testHTTPAdapter struct {
	headers map[string]string
	method  string
	path    string
	url     string
	accept  string
	agent   string
}

func (a *testHTTPAdapter) GetHeader(name string) string {
	if a.headers == nil {
		return ""
	}
	return a.headers[name]
}
func (a *testHTTPAdapter) GetMethod() string       { return a.method }
func (a *testHTTPAdapter) GetPath() string         { return a.path }
func (a *testHTTPAdapter) GetURL() string          { return a.url }
func (a *testHTTPAdapter) GetAcceptHeader() string { return a.accept }
func (a *testHTTPAdapter) GetUserAgent() string    { return a.agent }

func TestInMemoryStorageRecordsPaymentsCaseInsensitiveForEVM(t *testing.T) {
	storage := NewInMemoryStorage()
	ctx := context.Background()

	if err := storage.RecordPayment(ctx, "/data", "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"); err != nil {
		t.Fatalf("RecordPayment() error = %v", err)
	}

	paid, err := storage.HasPaid(ctx, "/data", "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")
	if err != nil {
		t.Fatalf("HasPaid() error = %v", err)
	}
	if !paid {
		t.Fatal("HasPaid() = false, want true")
	}

	paid, err = storage.HasPaid(ctx, "/other", "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")
	if err != nil {
		t.Fatalf("HasPaid(other) error = %v", err)
	}
	if paid {
		t.Fatal("HasPaid(other) = true, want false")
	}
}

func TestInMemoryStorageTracksNonces(t *testing.T) {
	storage := NewInMemoryStorage()
	ctx := context.Background()

	used, err := storage.HasUsedNonce(ctx, "nonce-1")
	if err != nil {
		t.Fatalf("HasUsedNonce() error = %v", err)
	}
	if used {
		t.Fatal("HasUsedNonce() = true before record")
	}

	if err := storage.RecordNonce(ctx, "nonce-1"); err != nil {
		t.Fatalf("RecordNonce() error = %v", err)
	}
	used, err = storage.HasUsedNonce(ctx, "nonce-1")
	if err != nil {
		t.Fatalf("HasUsedNonce(after) error = %v", err)
	}
	if !used {
		t.Fatal("HasUsedNonce() = false after record")
	}
}

func TestResourceServerExtensionEnrichDeclarationFromPaymentRequirements(t *testing.T) {
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: NewInMemoryStorage()})
	declaration := DeclareExtension(DeclareOptions{})[ExtensionKey]

	enrichedRaw := ext.EnrichDeclaration(declaration, x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{url: "https://api.example.com/weather"},
		Requirements: []types.PaymentRequirements{
			{Scheme: "exact", Network: "eip155:84532"},
			{Scheme: "exact", Network: SolanaDevnet},
		},
	})
	enriched, ok := enrichedRaw.(Extension)
	if !ok {
		t.Fatalf("enriched type = %T, want Extension", enrichedRaw)
	}
	if len(enriched.SupportedChains) != 2 {
		t.Fatalf("supportedChains length = %d, want 2", len(enriched.SupportedChains))
	}
	if enriched.SupportedChains[0].ChainID != "eip155:84532" || enriched.SupportedChains[0].Type != SignatureTypeEIP191 {
		t.Fatalf("first chain = %#v", enriched.SupportedChains[0])
	}
	if enriched.SupportedChains[1].ChainID != SolanaDevnet || enriched.SupportedChains[1].Type != SignatureTypeEd25519 {
		t.Fatalf("second chain = %#v", enriched.SupportedChains[1])
	}
}

func TestResourceServerExtensionEnrichDeclaration(t *testing.T) {
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: NewInMemoryStorage()})
	declaration := DeclareExtension(DeclareOptions{
		Statement:         "Sign in",
		Networks:          []string{"eip155:8453"},
		ExpirationSeconds: 300,
	})[ExtensionKey]

	enrichedRaw := ext.EnrichDeclaration(declaration, x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{url: "https://api.example.com/data"},
	})
	enriched, ok := enrichedRaw.(Extension)
	if !ok {
		t.Fatalf("enriched type = %T, want Extension", enrichedRaw)
	}

	if enriched.Info.Domain != "api.example.com" {
		t.Fatalf("domain = %q", enriched.Info.Domain)
	}
	if enriched.Info.URI != "https://api.example.com/data" {
		t.Fatalf("uri = %q", enriched.Info.URI)
	}
	if enriched.Info.Nonce == "" {
		t.Fatal("nonce is empty")
	}
	if enriched.Info.IssuedAt == "" {
		t.Fatal("issuedAt is empty")
	}
	if enriched.Info.ExpirationTime == "" {
		t.Fatal("expirationTime is empty")
	}
	if len(enriched.Info.Resources) != 1 || enriched.Info.Resources[0] != "https://api.example.com/data" {
		t.Fatalf("resources = %#v", enriched.Info.Resources)
	}
	if len(enriched.SupportedChains) != 1 || enriched.SupportedChains[0].ChainID != "eip155:8453" {
		t.Fatalf("supportedChains = %#v", enriched.SupportedChains)
	}
	if enriched.Schema == nil {
		t.Fatal("schema is nil")
	}
}

func TestResourceServerExtensionDynamicInfoFields(t *testing.T) {
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: NewInMemoryStorage()})
	fields := ext.DynamicInfoFields()

	want := []string{"nonce", "issuedAt", "expirationTime"}
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("DynamicInfoFields() = %#v, want %#v", fields, want)
	}
}

func TestHTTPServerAuthOnlyRouteReturnsSIWXChallenge(t *testing.T) {
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: NewInMemoryStorage()})
	server := x402http.Newx402HTTPResourceServer(x402http.RoutesConfig{
		"GET /profile": {
			Accepts:     x402http.PaymentOptions{},
			Description: "Profile",
			Extensions: map[string]interface{}{
				ExtensionKey: DeclareExtension(DeclareOptions{Networks: []string{"eip155:8453"}})[ExtensionKey],
			},
		},
	})
	server.RegisterExtension(ext)

	result := server.ProcessHTTPRequest(context.Background(), x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{method: "GET", path: "/profile", url: "https://api.example.com/profile"},
		Path:    "/profile",
		Method:  "GET",
	}, nil)

	if result.Type != x402http.ResultPaymentError {
		t.Fatalf("result type = %s, want payment-error", result.Type)
	}
	if result.Response == nil || result.Response.Status != 402 {
		t.Fatalf("response = %#v, want 402", result.Response)
	}
	encoded := result.Response.Headers["PAYMENT-REQUIRED"]
	if encoded == "" {
		t.Fatal("PAYMENT-REQUIRED header is empty")
	}
	required, err := decodePaymentRequiredForTest(encoded)
	if err != nil {
		t.Fatalf("decode payment required: %v", err)
	}
	if len(required.Accepts) != 0 {
		t.Fatalf("accepts length = %d, want 0", len(required.Accepts))
	}
	if _, ok := required.Extensions[ExtensionKey]; !ok {
		t.Fatalf("missing %q extension in %#v", ExtensionKey, required.Extensions)
	}
}

func TestProtectedRequestHookGrantsAuthOnlyAccess(t *testing.T) {
	storage := NewInMemoryStorage()
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: storage})
	header := signedHeaderForTest(t, "https://api.example.com/profile", "nonceauth")

	result, err := ext.ProtectedRequestHook()(context.Background(), x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{
			headers: map[string]string{HeaderName: header},
			path:    "/profile",
			url:     "https://api.example.com/profile",
		},
		Path: "/profile",
	}, x402http.RouteConfig{Accepts: x402http.PaymentOptions{}})
	if err != nil {
		t.Fatalf("hook error = %v", err)
	}
	if result == nil || !result.GrantAccess {
		t.Fatalf("result = %#v, want grant", result)
	}
}

func TestProtectedRequestHookGrantsAuthOnlyAccessWithSmartWalletVerifier(t *testing.T) {
	storage := NewInMemoryStorage()
	smartWallet := "0x1234567890123456789012345678901234567890"
	ext := MustCreateResourceServerExtension(ServerOptions{
		Storage: storage,
		VerifyOptions: VerifyOptions{
			EVMVerifier: func(ctx context.Context, address string, message string, signature string) (bool, error) {
				if address != smartWallet {
					t.Fatalf("address = %q, want %q", address, smartWallet)
				}
				if !strings.Contains(message, smartWallet) {
					t.Fatalf("message = %q, want wallet address included", message)
				}
				if signature == "" {
					t.Fatal("signature is empty")
				}
				return true, nil
			},
		},
	})
	header := smartWalletHeaderForTest(t, "https://api.example.com/profile", "noncesmartwallet", smartWallet)

	result, err := ext.ProtectedRequestHook()(context.Background(), x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{
			headers: map[string]string{HeaderName: header},
			path:    "/profile",
			url:     "https://api.example.com/profile",
		},
		Path: "/profile",
	}, x402http.RouteConfig{Accepts: x402http.PaymentOptions{}})
	if err != nil {
		t.Fatalf("hook error = %v", err)
	}
	if result == nil || !result.GrantAccess {
		t.Fatalf("result = %#v, want grant", result)
	}
}

func TestProtectedRequestHookRequiresPaymentRecordForPaidRoute(t *testing.T) {
	ctx := context.Background()
	storage := NewInMemoryStorage()
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: storage})
	header, address := signedHeaderAndAddressForTest(t, "https://api.example.com/weather", "noncepaid")
	reqCtx := x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{
			headers: map[string]string{HeaderName: header},
			path:    "/weather",
			url:     "https://api.example.com/weather",
		},
		Path: "/weather",
	}
	route := x402http.RouteConfig{Accepts: x402http.PaymentOptions{{Scheme: "exact", Network: "eip155:8453"}}}

	result, err := ext.ProtectedRequestHook()(ctx, reqCtx, route)
	if err != nil {
		t.Fatalf("hook error before payment = %v", err)
	}
	if result != nil {
		t.Fatalf("result before payment = %#v, want nil", result)
	}

	if err := storage.RecordPayment(ctx, "/weather", address); err != nil {
		t.Fatalf("RecordPayment() error = %v", err)
	}
	result, err = ext.ProtectedRequestHook()(ctx, reqCtx, route)
	if err != nil {
		t.Fatalf("hook error after payment = %v", err)
	}
	if result == nil || !result.GrantAccess {
		t.Fatalf("result after payment = %#v, want grant", result)
	}
}

func TestProtectedRequestHookRejectsNonceReplay(t *testing.T) {
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: NewInMemoryStorage()})
	header := signedHeaderForTest(t, "https://api.example.com/profile", "noncereplay")
	reqCtx := x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{
			headers: map[string]string{HeaderName: header},
			path:    "/profile",
			url:     "https://api.example.com/profile",
		},
		Path: "/profile",
	}
	route := x402http.RouteConfig{Accepts: x402http.PaymentOptions{}}

	first, err := ext.ProtectedRequestHook()(context.Background(), reqCtx, route)
	if err != nil {
		t.Fatalf("first hook error = %v", err)
	}
	if first == nil || !first.GrantAccess {
		t.Fatalf("first result = %#v, want grant", first)
	}

	second, err := ext.ProtectedRequestHook()(context.Background(), reqCtx, route)
	if err != nil {
		t.Fatalf("second hook error = %v", err)
	}
	if second != nil {
		t.Fatalf("second result = %#v, want nil", second)
	}
}

func TestProtectedRequestHookFallsBackForInvalidHeader(t *testing.T) {
	var events []HookEvent
	ext := MustCreateResourceServerExtension(ServerOptions{
		Storage: NewInMemoryStorage(),
		OnEvent: func(event HookEvent) {
			events = append(events, event)
		},
	})

	result, err := ext.ProtectedRequestHook()(context.Background(), x402http.HTTPRequestContext{
		Adapter: &testHTTPAdapter{
			headers: map[string]string{HeaderName: "not-base64"},
			path:    "/profile",
			url:     "https://api.example.com/profile",
		},
		Path: "/profile",
	}, x402http.RouteConfig{Accepts: x402http.PaymentOptions{}})
	if err != nil {
		t.Fatalf("hook error = %v", err)
	}
	if result != nil {
		t.Fatalf("result = %#v, want nil fallback", result)
	}
	if len(events) != 1 || events[0].Type != "validation_failed" {
		t.Fatalf("events = %#v, want validation_failed", events)
	}
}

func TestAfterSettleHookRecordsPayment(t *testing.T) {
	ctx := context.Background()
	storage := NewInMemoryStorage()
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: storage})
	payload := types.PaymentPayload{
		X402Version: 2,
		Resource:    &types.ResourceInfo{URL: "https://api.example.com/weather"},
	}

	err := ext.ResourceServerExtensionHooks().OnAfterSettle(x402.SettleResultContext{
		SettleContext: x402.SettleContext{
			Ctx:     ctx,
			Payload: payload,
		},
		Result: &x402.SettleResponse{Success: true, Payer: "0xabc0000000000000000000000000000000000000"},
	})
	if err != nil {
		t.Fatalf("OnAfterSettle() error = %v", err)
	}

	paid, err := storage.HasPaid(ctx, "/weather", "0xAbC0000000000000000000000000000000000000")
	if err != nil {
		t.Fatalf("HasPaid() error = %v", err)
	}
	if !paid {
		t.Fatal("payment was not recorded")
	}
}

func TestAfterSettleHookIgnoresUnsuccessfulOrMissingPayer(t *testing.T) {
	ctx := context.Background()
	storage := NewInMemoryStorage()
	ext := MustCreateResourceServerExtension(ServerOptions{Storage: storage})
	hook := ext.ResourceServerExtensionHooks().OnAfterSettle
	payload := types.PaymentPayload{X402Version: 2, Resource: &types.ResourceInfo{URL: "https://api.example.com/weather"}}

	if err := hook(x402.SettleResultContext{
		SettleContext: x402.SettleContext{Ctx: ctx, Payload: payload},
		Result:        &x402.SettleResponse{Success: false, Payer: "0xabc0000000000000000000000000000000000000"},
	}); err != nil {
		t.Fatalf("unsuccessful settle hook error = %v", err)
	}
	if err := hook(x402.SettleResultContext{
		SettleContext: x402.SettleContext{Ctx: ctx, Payload: payload},
		Result:        &x402.SettleResponse{Success: true},
	}); err != nil {
		t.Fatalf("missing payer settle hook error = %v", err)
	}

	paid, err := storage.HasPaid(ctx, "/weather", "0xabc0000000000000000000000000000000000000")
	if err != nil {
		t.Fatalf("HasPaid() error = %v", err)
	}
	if paid {
		t.Fatal("payment should not be recorded")
	}
}

func signedHeaderForTest(t *testing.T, resourceURI string, nonce string) string {
	t.Helper()
	header, _ := signedHeaderAndAddressForTest(t, resourceURI, nonce)
	return header
}

func signedHeaderAndAddressForTest(t *testing.T, resourceURI string, nonce string) (string, string) {
	t.Helper()
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	payload := Payload{
		Domain:         "api.example.com",
		Address:        address.Hex(),
		Statement:      "Sign in to access your purchased content",
		URI:            resourceURI,
		Version:        Version,
		ChainID:        "eip155:8453",
		Type:           SignatureTypeEIP191,
		Nonce:          nonce,
		IssuedAt:       time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
		ExpirationTime: time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
		Resources:      []string{resourceURI},
	}
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
	header, err := EncodeHeader(payload)
	if err != nil {
		t.Fatalf("EncodeHeader() error = %v", err)
	}
	return header, address.Hex()
}

func smartWalletHeaderForTest(t *testing.T, resourceURI string, nonce string, address string) string {
	t.Helper()
	payload := Payload{
		Domain:         "api.example.com",
		Address:        address,
		Statement:      "Sign in to access your purchased content",
		URI:            resourceURI,
		Version:        Version,
		ChainID:        "eip155:8453",
		Type:           SignatureTypeEIP191,
		Nonce:          nonce,
		IssuedAt:       time.Now().Add(-time.Minute).UTC().Format(time.RFC3339),
		ExpirationTime: time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
		Resources:      []string{resourceURI},
		Signature:      "0x" + strings.Repeat("ab", 96),
	}
	header, err := EncodeHeader(payload)
	if err != nil {
		t.Fatalf("EncodeHeader() error = %v", err)
	}
	return header
}

func decodePaymentRequiredForTest(header string) (types.PaymentRequired, error) {
	decoded, err := base64DecodeForTest(header)
	if err != nil {
		return types.PaymentRequired{}, err
	}
	var required types.PaymentRequired
	if err := json.Unmarshal(decoded, &required); err != nil {
		return types.PaymentRequired{}, err
	}
	return required, nil
}

func base64DecodeForTest(header string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(header)
}
