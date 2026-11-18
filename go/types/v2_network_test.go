package types

import (
	"encoding/json"
	"strings"
	"testing"
)

func paymentRequirementsV2JSON(t *testing.T, network string) []byte {
	t.Helper()
	body := map[string]any{
		"scheme":            "exact",
		"network":           network,
		"amount":            "10000",
		"asset":             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		"payTo":             "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
		"maxTimeoutSeconds": 60,
		"extra":             map[string]any{"name": "USDC", "version": "2"},
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal requirements: %v", err)
	}
	return data
}

func TestPaymentRequirementsV2Network(t *testing.T) {
	t.Run("accepts eip155:84532", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "eip155:84532")); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("accepts solana:devnet", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "solana:devnet")); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("accepts minimum abc:d", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "abc:d")); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("accepts 32-character reference", func(t *testing.T) {
		if _, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")); err != nil {
			t.Fatal(err)
		}
	})

	malformed := []string{
		"base-sepolia",
		"ethereum",
		"a:",
		"a:b",
		"EIP155:84532",
		"123456789:1",
		"eip155:",
		"eip155:" + strings.Repeat("a", 33),
		"eip155:base.mainnet",
		":84532",
		"eip155:84532:extra",
		"eip155:*",
	}
	for _, network := range malformed {
		t.Run("rejects "+network, func(t *testing.T) {
			_, err := ToPaymentRequirements(paymentRequirementsV2JSON(t, network))
			if err == nil {
				t.Fatalf("expected CAIP-2 rejection for %q", network)
			}
			if !strings.Contains(err.Error(), "must be in CAIP-2 format (e.g., 'eip155:84532')") {
				t.Fatalf("error %q missing CAIP-2 clause", err)
			}
		})
	}
}

func TestPaymentRequirementsV1NetworkStaysLoose(t *testing.T) {
	for _, network := range []string{"base-sepolia", "eip155:84532"} {
		t.Run(network, func(t *testing.T) {
			body := map[string]any{
				"scheme":            "exact",
				"network":           network,
				"maxAmountRequired": "10000",
				"resource":          "https://api.example.com/premium-data",
				"description":       "Access to premium market data",
				"payTo":             "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
				"maxTimeoutSeconds": 60,
				"asset":             "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			}
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ToPaymentRequirementsV1(data); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPaymentPayloadAndRequiredRejectMalformedNetwork(t *testing.T) {
	requirements := paymentRequirementsV2JSON(t, "eip155:base.mainnet")
	payload := []byte(`{"x402Version":2,"accepted":` + string(requirements) + `,"payload":{"signature":"0x1234"}}`)
	if _, err := ToPaymentPayload(payload); err == nil {
		t.Fatal("expected payload rejection")
	}

	required := []byte(`{"x402Version":2,"resource":{"url":"https://api.example.com/premium-data"},"accepts":[` + string(requirements) + `]}`)
	if _, err := ToPaymentRequired(required); err == nil {
		t.Fatal("expected payment-required rejection")
	}
}

func TestV2EnvelopeNetworkRuleFollowsX402Version(t *testing.T) {
	t.Run("rejects a V2 payload without accepted", func(t *testing.T) {
		payload := []byte(`{"x402Version":2,"payload":{"signature":"0x1234"}}`)
		_, err := ToPaymentPayload(payload)
		if err == nil || !strings.Contains(err.Error(), "must be in CAIP-2 format (e.g., 'eip155:84532')") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("rejects a V2 accepts list with one malformed entry", func(t *testing.T) {
		good := paymentRequirementsV2JSON(t, "eip155:84532")
		bad := paymentRequirementsV2JSON(t, "ethereum")
		required := []byte(`{"x402Version":2,"accepts":[` + string(good) + `,` + string(bad) + `]}`)
		_, err := ToPaymentRequired(required)
		if err == nil || !strings.Contains(err.Error(), "must be in CAIP-2 format (e.g., 'eip155:84532')") {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("accepts a V1 payment required body", func(t *testing.T) {
		body := []byte(`{"x402Version":1,"accepts":[{"scheme":"exact","network":"base-sepolia","maxAmountRequired":"10000","resource":"https://api.example.com/premium-data","description":"Access to premium market data","payTo":"0x209693Bc6afc0C5328bA36FaF03C514EF312287C","maxTimeoutSeconds":60,"asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e"}]}`)
		required, err := ToPaymentRequired(body)
		if err != nil {
			t.Fatal(err)
		}
		if required.X402Version != 1 || len(required.Accepts) != 1 || required.Accepts[0].Network != "base-sepolia" {
			t.Fatalf("decoded %+v", required)
		}
	})

	t.Run("accepts a V1 payment payload body", func(t *testing.T) {
		body := []byte(`{"x402Version":1,"scheme":"exact","network":"base-sepolia","payload":{"signature":"0x1234"}}`)
		payload, err := ToPaymentPayload(body)
		if err != nil {
			t.Fatal(err)
		}
		if payload.X402Version != 1 || payload.Payload["signature"] != "0x1234" {
			t.Fatalf("decoded %+v", payload)
		}
	})

	t.Run("keeps the rest of a valid V2 payload", func(t *testing.T) {
		requirements := paymentRequirementsV2JSON(t, "eip155:84532")
		body := []byte(`{"x402Version":2,"payload":{"signature":"0x1234"},"accepted":` + string(requirements) + `,"resource":{"url":"https://api.example.com/premium-data","description":"premium"},"extensions":{"bazaar":{"info":true}}}`)
		payload, err := ToPaymentPayload(body)
		if err != nil {
			t.Fatal(err)
		}
		if payload.X402Version != 2 || payload.Accepted.Network != "eip155:84532" || payload.Accepted.Scheme != "exact" || payload.Accepted.Amount != "10000" {
			t.Fatalf("decoded payload %+v", payload)
		}
		if payload.Payload["signature"] != "0x1234" || payload.Resource == nil || payload.Resource.URL != "https://api.example.com/premium-data" {
			t.Fatalf("decoded payload fields %+v", payload)
		}
		if payload.Extensions["bazaar"] == nil {
			t.Fatalf("decoded extensions %+v", payload.Extensions)
		}
	})
}
