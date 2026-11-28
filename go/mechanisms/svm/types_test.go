package svm

import (
	"encoding/json"
	"testing"

	"github.com/x402-foundation/x402/go/v2/types"
)

func TestExactSvmPayloadV1Structure(t *testing.T) {
	payload := ExactSvmPayloadV1{Transaction: "base64encodedtransaction=="}
	if payload.Transaction == "" {
		t.Fatal("expected transaction field")
	}
}

func TestExactSvmPayloadV2CompatibleWithV1(t *testing.T) {
	payload := ExactSvmPayloadV2{Transaction: "base64encodedtransaction=="}
	v1 := ExactSvmPayloadV1(payload)
	if v1.Transaction != payload.Transaction {
		t.Fatalf("expected V2 to be assignable to V1")
	}
}

func TestUptoSvmPayloadV2Alias(t *testing.T) {
	payload := UptoSvmPayloadV2{
		From:             "From1111111111111111111111111111111111111",
		MaxAmount:        "1000",
		ExpiresAt:        1_700_000_000,
		ValidAfter:       1_699_999_000,
		Nonce:            "1",
		OpenSlot:         "341000000",
		ChannelId:        "Channel111111111111111111111111111111111111",
		Deposit:          "1000",
		AuthorizedSigner: "Auth1111111111111111111111111111111111111",
		OpenTransaction:  "dGVzdA==",
	}
	if payload.From == "" {
		t.Fatal("expected from field on UptoSvmPayloadV2 alias")
	}
}

func TestIsUptoSvmPayload(t *testing.T) {
	valid := map[string]interface{}{
		"from":             "From1111111111111111111111111111111111111",
		"maxAmount":        "1000",
		"deposit":          "1000",
		"channelId":        "Channel111111111111111111111111111111111111",
		"authorizedSigner": "Auth1111111111111111111111111111111111111",
		"openTransaction":  "dGVzdA==",
		"openSlot":         "341000000",
		"nonce":            "1",
		"expiresAt":        float64(1_700_000_000),
		"validAfter":       float64(1_699_999_000),
	}
	if !IsUptoSvmPayload(valid) {
		t.Fatal("expected valid upto payload")
	}

	valid["type"] = UptoPayloadTypeDeposit
	if !IsUptoSvmPayload(valid) {
		t.Fatal("expected deposit type to pass the guard")
	}
	valid["type"] = "refund"
	if IsUptoSvmPayload(valid) {
		t.Fatal("expected invalid type to fail the guard")
	}
	delete(valid, "type")

	missingExpires := map[string]interface{}{}
	for k, v := range valid {
		missingExpires[k] = v
	}
	delete(missingExpires, "expiresAt")
	if IsUptoSvmPayload(missingExpires) {
		t.Fatal("expected missing expiresAt to fail the guard")
	}
}

func TestPayloadFromMapRequiresTransaction(t *testing.T) {
	if _, err := PayloadFromMap(map[string]interface{}{}); err == nil {
		t.Fatal("expected error for missing transaction")
	}
}

func TestUptoPayloadFromMapRequiresFields(t *testing.T) {
	if _, err := UptoPayloadFromMap(map[string]interface{}{"from": "x"}); err == nil {
		t.Fatal("expected error for incomplete upto payload")
	}
}

func uptoPayloadFromJSON(t *testing.T, expiresAt string) (*UptoSvmPayload, error) {
	t.Helper()
	body := `{"x402Version":2,"accepted":{"scheme":"upto","network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1","amount":"1","asset":"a","payTo":"b","maxTimeoutSeconds":60},` +
		`"payload":{"from":"f","maxAmount":"1","expiresAt":` + expiresAt + `,"validAfter":1.0e0,"nonce":"1","openSlot":"5","channelId":"c","deposit":"1","authorizedSigner":"s","openTransaction":"dGVzdA=="}}`
	p, err := types.ToPaymentPayload([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return UptoPayloadFromMap(p.Payload)
}

func TestUptoPayloadFromMapIntegralDecimals(t *testing.T) {
	for _, in := range []string{"1900000000", "1900000000.0", "1.9e9"} {
		p, err := uptoPayloadFromJSON(t, in)
		if err != nil {
			t.Fatalf("expiresAt %s: %v", in, err)
		}
		if p.ExpiresAt != 1900000000 || p.ValidAfter != 1 {
			t.Fatalf("expiresAt %s decoded as %d / %d", in, p.ExpiresAt, p.ValidAfter)
		}
	}
	if _, err := uptoPayloadFromJSON(t, "1900000000.5"); err == nil {
		t.Fatal("fractional expiresAt accepted")
	}
}

func TestUptoNumberHelpersJSONNumber(t *testing.T) {
	for in, want := range map[json.Number]string{"60.0": "60", "9007199254740993.0": "9007199254740993"} {
		if got, ok := uptoOpenSlotString(in); !ok || got != want {
			t.Fatalf("uptoOpenSlotString(%q) = (%q, %v), want %q", in, got, ok, want)
		}
	}
	if got, ok := uptoOpenSlotString(json.Number("-1")); ok {
		t.Fatalf("uptoOpenSlotString(-1) = %q, want ok=false", got)
	}
	if !jsonNumberIsInt64(json.Number("6e1")) {
		t.Fatal("jsonNumberIsInt64(6e1) = false")
	}
	for _, bad := range []json.Number{"1.5", "9223372036854775808"} {
		if jsonNumberIsInt64(bad) {
			t.Fatalf("jsonNumberIsInt64(%q) = true", bad)
		}
	}
}
