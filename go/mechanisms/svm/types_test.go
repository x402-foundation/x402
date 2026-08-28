package svm

import (
	"testing"
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
