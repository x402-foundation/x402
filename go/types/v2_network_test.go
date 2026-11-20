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

const exactJSONInteger = "9007199254740993"

func exactNumberTree() string {
	return `{"n":` + exactJSONInteger + `,"arr":[` + exactJSONInteger + `,{"m":` + exactJSONInteger + `}]}`
}

func requirementsWithExactNumbers(network string) string {
	return `{"scheme":"exact","network":"` + network + `","amount":"` + exactJSONInteger + `","asset":"0x1","payTo":"0x2","maxTimeoutSeconds":60,"extra":{"counter":` + exactJSONInteger + `,"box":` + exactNumberTree() + `}}`
}

func assertExactNumber(t *testing.T, value interface{}, path string) {
	t.Helper()
	number, ok := value.(json.Number)
	if !ok || number.String() != exactJSONInteger {
		t.Fatalf("%s: got %T %v", path, value, value)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != exactJSONInteger {
		t.Fatalf("%s re-encoded as %s", path, encoded)
	}
}

func assertExactTree(t *testing.T, value interface{}, path string) {
	t.Helper()
	box, ok := value.(map[string]interface{})
	if !ok {
		t.Fatalf("%s: got %T", path, value)
	}
	assertExactNumber(t, box["n"], path+".n")
	arr, ok := box["arr"].([]interface{})
	if !ok || len(arr) != 2 {
		t.Fatalf("%s.arr: got %#v", path, box["arr"])
	}
	assertExactNumber(t, arr[0], path+".arr[0]")
	inner, ok := arr[1].(map[string]interface{})
	if !ok {
		t.Fatalf("%s.arr[1]: got %T", path, arr[1])
	}
	assertExactNumber(t, inner["m"], path+".arr[1].m")
}

func TestV2MapNumbersStayExact(t *testing.T) {
	requirementsJSON := requirementsWithExactNumbers("eip155:8453")

	t.Run("requirements extra", func(t *testing.T) {
		requirements, err := ToPaymentRequirements([]byte(requirementsJSON))
		if err != nil {
			t.Fatal(err)
		}
		if requirements.Amount != exactJSONInteger {
			t.Fatalf("amount %q", requirements.Amount)
		}
		assertExactNumber(t, requirements.Extra["counter"], "extra.counter")
		assertExactTree(t, requirements.Extra["box"], "extra.box")
	})

	t.Run("payload maps", func(t *testing.T) {
		body := `{"x402Version":2,"accepted":` + requirementsJSON + `,"payload":{"counter":` + exactJSONInteger + `,"box":` + exactNumberTree() + `},"extensions":{"ext":{"counter":` + exactJSONInteger + `,"box":` + exactNumberTree() + `}}}`
		payload, err := ToPaymentPayload([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		if payload.Accepted.Amount != exactJSONInteger {
			t.Fatalf("amount %q", payload.Accepted.Amount)
		}
		assertExactNumber(t, payload.Payload["counter"], "payload.counter")
		assertExactTree(t, payload.Payload["box"], "payload.box")
		assertExactNumber(t, payload.Accepted.Extra["counter"], "accepted.extra.counter")
		assertExactTree(t, payload.Accepted.Extra["box"], "accepted.extra.box")
		ext, ok := payload.Extensions["ext"].(map[string]interface{})
		if !ok {
			t.Fatalf("extensions.ext: got %T", payload.Extensions["ext"])
		}
		assertExactNumber(t, ext["counter"], "extensions.ext.counter")
		assertExactTree(t, ext["box"], "extensions.ext.box")
	})

	t.Run("payment required maps", func(t *testing.T) {
		body := `{"x402Version":2,"accepts":[` + requirementsJSON + `],"extensions":{"ext":{"counter":` + exactJSONInteger + `,"box":` + exactNumberTree() + `}}}`
		required, err := ToPaymentRequired([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		if len(required.Accepts) != 1 || required.Accepts[0].Amount != exactJSONInteger {
			t.Fatalf("accepts %+v", required.Accepts)
		}
		assertExactNumber(t, required.Accepts[0].Extra["counter"], "accepts[0].extra.counter")
		assertExactTree(t, required.Accepts[0].Extra["box"], "accepts[0].extra.box")
		ext, ok := required.Extensions["ext"].(map[string]interface{})
		if !ok {
			t.Fatalf("extensions.ext: got %T", required.Extensions["ext"])
		}
		assertExactNumber(t, ext["counter"], "extensions.ext.counter")
		assertExactTree(t, ext["box"], "extensions.ext.box")
	})

	t.Run("outer decoder UseNumber", func(t *testing.T) {
		body := `{"x402Version":2,"accepted":` + requirementsJSON + `,"payload":{"counter":` + exactJSONInteger + `}}`
		var payload PaymentPayload
		decoder := json.NewDecoder(strings.NewReader(body))
		decoder.UseNumber()
		if err := decoder.Decode(&payload); err != nil {
			t.Fatal(err)
		}
		assertExactNumber(t, payload.Payload["counter"], "payload.counter")
		if payload.Accepted.Amount != exactJSONInteger {
			t.Fatalf("amount %q", payload.Accepted.Amount)
		}
	})

	t.Run("rejects an invalid V2 network", func(t *testing.T) {
		_, err := ToPaymentRequirements([]byte(requirementsWithExactNumbers("ethereum")))
		if err == nil || !strings.Contains(err.Error(), "must be in CAIP-2 format (e.g., 'eip155:84532')") {
			t.Fatalf("got %v", err)
		}
	})
}

func TestV2UnmarshalRejectsTrailingBytes(t *testing.T) {
	requirementsJSON := requirementsWithExactNumbers("eip155:8453")
	cases := []struct {
		name   string
		body   string
		decode func([]byte) error
	}{
		{
			name: "requirements",
			body: requirementsJSON,
			decode: func(data []byte) error {
				_, err := ToPaymentRequirements(data)
				return err
			},
		},
		{
			name: "payload",
			body: `{"x402Version":2,"accepted":` + requirementsJSON + `,"payload":{"counter":` + exactJSONInteger + `}}`,
			decode: func(data []byte) error {
				_, err := ToPaymentPayload(data)
				return err
			},
		},
		{
			name: "payment required",
			body: `{"x402Version":2,"accepts":[` + requirementsJSON + `]}`,
			decode: func(data []byte) error {
				_, err := ToPaymentRequired(data)
				return err
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.decode([]byte(tc.body + "\n  ")); err != nil {
				t.Fatal(err)
			}
			if err := tc.decode([]byte(tc.body + " true")); err == nil {
				t.Fatal("expected trailing data rejection")
			}
		})
	}
}
