package types

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPaymentRequiredMarshalRequiresResourceURL(t *testing.T) {
	if _, err := json.Marshal(PaymentRequired{X402Version: 1}); err != nil {
		t.Fatalf("v1 must still marshal without resource: %v", err)
	}
	_, err := json.Marshal(PaymentRequired{X402Version: 2})
	if err == nil {
		t.Fatal("expected marshal error when resource is missing")
	}
	if !strings.Contains(err.Error(), "resource.url") {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := json.Marshal(PaymentRequired{
		X402Version: 2,
		Resource:    &ResourceInfo{URL: "https://example.com/paid"},
		Accepts:     []PaymentRequirements{{Scheme: "exact", Network: "eip155:1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"resource"`) {
		t.Fatalf("expected resource key on wire: %s", data)
	}
}
