package types

import (
	"bytes"
	"encoding/json"
	"testing"
)

const exactExtraJSON = `{"big":9007199254740993,"dec":1.25,"amount":"9007199254740993","a":{"b":[1,9007199254740993,{"c":2}]}}`

func requirementsWithExtraJSON(network, extra string) string {
	return `{"scheme":"exact","network":"` + network + `","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","amount":"9007199254740993","payTo":"0x209693Bc6afc0C5328bA36FaF03C514EF312287C","maxTimeoutSeconds":60,"extra":` + extra + `}`
}

// assertExactNumbers checks that m holds every number in exactExtraJSON as a
// json.Number and that it re-marshals to the same bytes.
func assertExactNumbers(t *testing.T, name string, m map[string]interface{}) {
	t.Helper()
	if got, ok := m["big"].(json.Number); !ok || got != "9007199254740993" {
		t.Fatalf("%s big = %#v", name, m["big"])
	}
	if got, ok := m["dec"].(json.Number); !ok || got != "1.25" {
		t.Fatalf("%s dec = %#v", name, m["dec"])
	}
	if got, ok := m["amount"].(string); !ok || got != "9007199254740993" {
		t.Fatalf("%s amount = %#v", name, m["amount"])
	}
	arr := m["a"].(map[string]interface{})["b"].([]interface{})
	if got, ok := arr[1].(json.Number); !ok || got != "9007199254740993" {
		t.Fatalf("%s a.b[1] = %#v", name, arr[1])
	}
	if got, ok := arr[2].(map[string]interface{})["c"].(json.Number); !ok || got != "2" {
		t.Fatalf("%s a.b[2].c = %#v", name, arr[2])
	}
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var want bytes.Buffer
	if err := json.Compact(&want, []byte(exactExtraJSON)); err != nil {
		t.Fatal(err)
	}
	var wantMap, gotMap map[string]json.RawMessage
	_ = json.Unmarshal(want.Bytes(), &wantMap)
	_ = json.Unmarshal(out, &gotMap)
	for k, v := range wantMap {
		if !bytes.Equal(v, gotMap[k]) {
			t.Fatalf("%s re-marshal %s = %s, want %s", name, k, gotMap[k], v)
		}
	}
}

func TestPaymentRequirementsExtraKeepsExactNumbers(t *testing.T) {
	r, err := ToPaymentRequirements([]byte(requirementsWithExtraJSON("eip155:84532", exactExtraJSON)))
	if err != nil {
		t.Fatal(err)
	}
	assertExactNumbers(t, "extra", r.Extra)
}

func TestPaymentPayloadKeepsExactNumbers(t *testing.T) {
	body := `{"x402Version":2,"accepted":` + requirementsWithExtraJSON("eip155:84532", exactExtraJSON) +
		`,"payload":` + exactExtraJSON + `,"extensions":` + exactExtraJSON + `}`
	p, err := ToPaymentPayload([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	assertExactNumbers(t, "payload", p.Payload)
	assertExactNumbers(t, "extensions", p.Extensions)
	assertExactNumbers(t, "accepted.extra", p.Accepted.Extra)
}

func TestPaymentRequiredKeepsExactNumbers(t *testing.T) {
	body := `{"x402Version":2,"accepts":[` + requirementsWithExtraJSON("eip155:84532", exactExtraJSON) +
		`],"extensions":` + exactExtraJSON + `}`
	r, err := ToPaymentRequired([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	assertExactNumbers(t, "extensions", r.Extensions)
	assertExactNumbers(t, "accepts[0].extra", r.Accepts[0].Extra)
}

func TestStringAmountsUnchanged(t *testing.T) {
	r, err := ToPaymentRequirements([]byte(requirementsWithExtraJSON("eip155:84532", `{"balance":"9007199254740993"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if r.Amount != "9007199254740993" {
		t.Fatalf("amount = %q", r.Amount)
	}
	if got, ok := r.Extra["balance"].(string); !ok || got != "9007199254740993" {
		t.Fatalf("extra.balance = %#v", r.Extra["balance"])
	}
}

func TestV1EnvelopeKeepsExactNumbers(t *testing.T) {
	body := `{"x402Version":1,"scheme":"exact","network":"base-sepolia","payload":{"nonce":9007199254740993}}`
	p, err := ToPaymentPayload([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := p.Payload["nonce"].(json.Number); !ok || got != "9007199254740993" {
		t.Fatalf("nonce = %#v", p.Payload["nonce"])
	}
}

func TestMalformedJSONStillErrors(t *testing.T) {
	for _, body := range []string{"[]", "{", `{"x402Version":"2"}`} {
		if _, err := ToPaymentRequirements([]byte(body)); err == nil {
			t.Fatalf("ToPaymentRequirements(%s) succeeded", body)
		}
		if _, err := ToPaymentPayload([]byte(body)); err == nil {
			t.Fatalf("ToPaymentPayload(%s) succeeded", body)
		}
		if _, err := ToPaymentRequired([]byte(body)); err == nil {
			t.Fatalf("ToPaymentRequired(%s) succeeded", body)
		}
	}
}
