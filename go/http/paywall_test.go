package http

import (
	"strings"
	"testing"

	"github.com/coinbase/x402/go/types"
)

// mockPaywallProvider is a test PaywallProvider that returns configurable HTML.
type mockPaywallProvider struct {
	html string
}

func (m *mockPaywallProvider) GenerateHTML(_ types.PaymentRequired, _ *PaywallConfig) string {
	return m.html
}

// mockNetworkHandler is a test PaywallNetworkHandler for a configurable network prefix.
type mockNetworkHandler struct {
	prefix string
	html   string
}

func (m *mockNetworkHandler) Supports(req types.PaymentRequirements) bool {
	return strings.HasPrefix(req.Network, m.prefix)
}

func (m *mockNetworkHandler) GenerateHTML(_ types.PaymentRequirements, _ types.PaymentRequired, _ *PaywallConfig) string {
	return m.html
}

func makePaymentRequired(network string) types.PaymentRequired {
	return types.PaymentRequired{
		X402Version: 2,
		Accepts: []types.PaymentRequirements{
			{
				Scheme:  "exact",
				Network: network,
				Asset:   "USDC",
				Amount:  "1000000",
				PayTo:   "0xtest",
			},
		},
		Resource: &types.ResourceInfo{
			URL:         "/api/test",
			Description: "Test API",
		},
	}
}

// --- EVMPaywallHandler tests ---

func TestEVMPaywallHandler_Supports(t *testing.T) {
	handler := &EVMPaywallHandler{}

	tests := []struct {
		network string
		want    bool
	}{
		{"eip155:1", true},
		{"eip155:8453", true},
		{"eip155:84532", true},
		{"solana:mainnet", false},
		{"solana:devnet", false},
		{"aptos:mainnet", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.network, func(t *testing.T) {
			req := types.PaymentRequirements{Network: tt.network}
			got := handler.Supports(req)
			if got != tt.want {
				t.Errorf("EVMPaywallHandler.Supports(%q) = %v, want %v", tt.network, got, tt.want)
			}
		})
	}
}

// --- SVMPaywallHandler tests ---

func TestSVMPaywallHandler_Supports(t *testing.T) {
	handler := &SVMPaywallHandler{}

	tests := []struct {
		network string
		want    bool
	}{
		{"solana:mainnet", true},
		{"solana:devnet", true},
		{"eip155:1", false},
		{"eip155:8453", false},
		{"aptos:mainnet", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.network, func(t *testing.T) {
			req := types.PaymentRequirements{Network: tt.network}
			got := handler.Supports(req)
			if got != tt.want {
				t.Errorf("SVMPaywallHandler.Supports(%q) = %v, want %v", tt.network, got, tt.want)
			}
		})
	}
}

// --- PaywallBuilder tests ---

func TestPaywallBuilder_Build(t *testing.T) {
	provider := NewPaywallBuilder().
		WithNetwork(&mockNetworkHandler{prefix: "eip155:", html: "<evm-html>"}).
		WithNetwork(&mockNetworkHandler{prefix: "solana:", html: "<svm-html>"}).
		Build()

	t.Run("matches EVM network", func(t *testing.T) {
		got := provider.GenerateHTML(makePaymentRequired("eip155:8453"), nil)
		if got != "<evm-html>" {
			t.Errorf("expected <evm-html>, got %q", got)
		}
	})

	t.Run("matches Solana network", func(t *testing.T) {
		got := provider.GenerateHTML(makePaymentRequired("solana:mainnet"), nil)
		if got != "<svm-html>" {
			t.Errorf("expected <svm-html>, got %q", got)
		}
	})

	t.Run("no match returns empty string", func(t *testing.T) {
		got := provider.GenerateHTML(makePaymentRequired("aptos:mainnet"), nil)
		if got != "" {
			t.Errorf("expected empty string for unsupported network, got %q", got)
		}
	})
}

func TestPaywallBuilder_WithConfig(t *testing.T) {
	var capturedConfig *PaywallConfig

	handler := &configCapturingHandler{
		prefix: "eip155:",
		onGenerate: func(config *PaywallConfig) {
			capturedConfig = config
		},
	}

	builderConfig := &PaywallConfig{AppName: "TestApp", Testnet: true}
	provider := NewPaywallBuilder().
		WithNetwork(handler).
		WithConfig(builderConfig).
		Build()

	t.Run("uses builder config when no per-call config", func(t *testing.T) {
		provider.GenerateHTML(makePaymentRequired("eip155:1"), nil)
		if capturedConfig == nil || capturedConfig.AppName != "TestApp" {
			t.Errorf("expected builder config to be used, got %+v", capturedConfig)
		}
	})

	t.Run("per-call config overrides builder config", func(t *testing.T) {
		callConfig := &PaywallConfig{AppName: "CallApp"}
		provider.GenerateHTML(makePaymentRequired("eip155:1"), callConfig)
		if capturedConfig == nil || capturedConfig.AppName != "CallApp" {
			t.Errorf("expected per-call config to override, got %+v", capturedConfig)
		}
	})
}

type configCapturingHandler struct {
	prefix     string
	onGenerate func(config *PaywallConfig)
}

func (h *configCapturingHandler) Supports(req types.PaymentRequirements) bool {
	return strings.HasPrefix(req.Network, h.prefix)
}

func (h *configCapturingHandler) GenerateHTML(_ types.PaymentRequirements, _ types.PaymentRequired, config *PaywallConfig) string {
	if h.onGenerate != nil {
		h.onGenerate(config)
	}
	return "<captured>"
}

// --- DefaultPaywallProvider tests ---

func TestDefaultPaywallProvider(t *testing.T) {
	provider := DefaultPaywallProvider()

	t.Run("EVM network returns non-empty HTML", func(t *testing.T) {
		got := provider.GenerateHTML(makePaymentRequired("eip155:8453"), nil)
		if got == "" {
			t.Error("expected non-empty HTML for EVM network")
		}
		if !strings.Contains(got, "window.x402") {
			t.Error("expected window.x402 config injection in HTML")
		}
	})

	t.Run("Solana network returns non-empty HTML", func(t *testing.T) {
		got := provider.GenerateHTML(makePaymentRequired("solana:mainnet"), nil)
		if got == "" {
			t.Error("expected non-empty HTML for Solana network")
		}
		if !strings.Contains(got, "window.x402") {
			t.Error("expected window.x402 config injection in HTML")
		}
	})

	t.Run("unsupported network returns empty", func(t *testing.T) {
		got := provider.GenerateHTML(makePaymentRequired("aptos:mainnet"), nil)
		if got != "" {
			t.Errorf("expected empty string for unsupported network, got length %d", len(got))
		}
	})
}

// --- RegisterPaywallProvider integration tests ---

func TestRegisterPaywallProvider(t *testing.T) {
	routes := RoutesConfig{
		"GET /api/test": {
			Accepts: PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:8453",
				},
			},
		},
	}

	t.Run("returns server for chaining", func(t *testing.T) {
		server := Newx402HTTPResourceServer(routes)
		result := server.RegisterPaywallProvider(&mockPaywallProvider{html: "<custom>"})
		if result != server {
			t.Error("expected RegisterPaywallProvider to return the same server instance")
		}
	})

	t.Run("registered provider is used in generatePaywallHTMLV2", func(t *testing.T) {
		server := Newx402HTTPResourceServer(routes)
		server.RegisterPaywallProvider(&mockPaywallProvider{html: "<custom-paywall>"})

		got := server.generatePaywallHTMLV2(makePaymentRequired("eip155:8453"), nil, "")
		if got != "<custom-paywall>" {
			t.Errorf("expected <custom-paywall>, got %q", got)
		}
	})

	t.Run("CustomPaywallHTML takes priority over provider", func(t *testing.T) {
		server := Newx402HTTPResourceServer(routes)
		server.RegisterPaywallProvider(&mockPaywallProvider{html: "<custom-paywall>"})

		got := server.generatePaywallHTMLV2(makePaymentRequired("eip155:8453"), nil, "<route-custom>")
		if got != "<route-custom>" {
			t.Errorf("expected <route-custom>, got %q", got)
		}
	})

	t.Run("no provider falls back to built-in template", func(t *testing.T) {
		server := Newx402HTTPResourceServer(routes)

		got := server.generatePaywallHTMLV2(makePaymentRequired("eip155:8453"), nil, "")
		if got == "" {
			t.Error("expected non-empty HTML from built-in template")
		}
		if !strings.Contains(got, "window.x402") {
			t.Error("expected built-in template with window.x402 injection")
		}
	})
}

// --- injectPaywallConfig tests ---

func TestInjectPaywallConfig(t *testing.T) {
	template := "<html><head></head><body></body></html>"
	paymentReq := makePaymentRequired("eip155:8453")

	t.Run("injects window.x402 config", func(t *testing.T) {
		got := injectPaywallConfig(template, paymentReq, nil)
		if !strings.Contains(got, "window.x402") {
			t.Error("expected window.x402 in output")
		}
		if !strings.Contains(got, "</body>") {
			t.Error("expected </body> to remain in output")
		}
	})

	t.Run("includes PaywallConfig values", func(t *testing.T) {
		config := &PaywallConfig{
			AppName: "TestApp",
			AppLogo: "https://example.com/logo.png",
			Testnet: true,
		}
		got := injectPaywallConfig(template, paymentReq, config)
		if !strings.Contains(got, "TestApp") {
			t.Error("expected appName in output")
		}
		if !strings.Contains(got, "https://example.com/logo.png") {
			t.Error("expected appLogo in output")
		}
		if !strings.Contains(got, "testnet: true") {
			t.Error("expected testnet: true in output")
		}
	})

	t.Run("escapes HTML in config values", func(t *testing.T) {
		config := &PaywallConfig{AppName: `<script>alert("xss")</script>`}
		got := injectPaywallConfig(template, paymentReq, config)
		if strings.Contains(got, `<script>alert("xss")</script>`) {
			t.Error("expected HTML-escaped appName, got raw script tag")
		}
	})

	t.Run("uses resource URL as currentUrl fallback", func(t *testing.T) {
		got := injectPaywallConfig(template, paymentReq, nil)
		if !strings.Contains(got, "/api/test") {
			t.Error("expected resource URL as currentUrl fallback")
		}
	})
}
