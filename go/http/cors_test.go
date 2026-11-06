package http

import (
	"net/http"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
)

func TestWithPaymentCORSExposeHeaders(t *testing.T) {
	tests := []struct {
		name     string
		existing []string
		want     string
	}{
		{
			name: "no existing list",
			want: "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
		},
		{
			name:     "keeps app names and order",
			existing: []string{"X-Request-Id, X-Trace"},
			want:     "X-Request-Id, X-Trace, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
		},
		{
			name:     "merges across multiple header values",
			existing: []string{"X-Request-Id", "X-Trace"},
			want:     "X-Request-Id, X-Trace, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
		},
		{
			name:     "dedups case-insensitively and keeps the first spelling",
			existing: []string{"payment-required, X-Trace", "x-trace, Payment-Response"},
			want:     "payment-required, X-Trace, Payment-Response",
		},
		{
			name:     "drops empty entries",
			existing: []string{" , X-Trace ,,", ""},
			want:     "X-Trace, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := WithPaymentCORSExposeHeaders(tt.existing...); got != tt.want {
				t.Errorf("WithPaymentCORSExposeHeaders(%q) = %q, want %q", tt.existing, got, tt.want)
			}
		})
	}
}

func TestApplyPaymentResponseHeaders_MergesExistingExposeValues(t *testing.T) {
	dst := http.Header{}
	dst.Set("Access-Control-Allow-Origin", "https://app.example")
	dst.Add("Access-Control-Expose-Headers", "X-Request-Id, payment-required")
	dst.Add("Access-Control-Expose-Headers", "X-Trace")

	ApplyPaymentResponseHeaders(dst, map[string]string{
		"PAYMENT-RESPONSE":              "receipt",
		"Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
	})

	if got := dst.Get("PAYMENT-RESPONSE"); got != "receipt" {
		t.Errorf("PAYMENT-RESPONSE = %q, want %q", got, "receipt")
	}
	want := "X-Request-Id, payment-required, X-Trace, PAYMENT-RESPONSE"
	if got := dst.Values("Access-Control-Expose-Headers"); len(got) != 1 || got[0] != want {
		t.Errorf("Access-Control-Expose-Headers = %q, want [%q]", got, want)
	}
	if got := dst.Values("Access-Control-Allow-Origin"); len(got) != 1 || got[0] != "https://app.example" {
		t.Errorf("Access-Control-Allow-Origin = %q, want [https://app.example]", got)
	}
}

func TestApplyPaymentResponseHeaders_LeavesNonPaymentHeadersAlone(t *testing.T) {
	dst := http.Header{}
	dst.Set("Access-Control-Expose-Headers", "X-Trace")

	ApplyPaymentResponseHeaders(dst, map[string]string{"Cache-Control": "private"})

	if got := dst.Get("Access-Control-Expose-Headers"); got != "X-Trace" {
		t.Errorf("Access-Control-Expose-Headers = %q, want %q", got, "X-Trace")
	}
	if got := dst.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q, want it unset", got)
	}
}

func TestCreateSettlementHeaders_ExposesPaymentHeaders(t *testing.T) {
	server := Newx402HTTPResourceServer(RoutesConfig{})
	headers, err := server.CreateSettlementHeaders(&x402.SettleResponse{
		Success:     true,
		Transaction: "0xtx",
		Network:     "eip155:1",
	})
	if err != nil {
		t.Fatalf("CreateSettlementHeaders: %v", err)
	}
	if headers["PAYMENT-RESPONSE"] == "" {
		t.Error("Expected PAYMENT-RESPONSE header")
	}
	if got, want := headers["Access-Control-Expose-Headers"], "PAYMENT-REQUIRED, PAYMENT-RESPONSE"; got != want {
		t.Errorf("Access-Control-Expose-Headers = %q, want %q", got, want)
	}
	if _, ok := headers["Access-Control-Allow-Origin"]; ok {
		t.Error("CreateSettlementHeaders must not set Access-Control-Allow-Origin")
	}
}
