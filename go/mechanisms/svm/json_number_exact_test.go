package svm

import (
	"encoding/json"
	"testing"
)

func TestParseHintUint64ExactDecimal(t *testing.T) {
	if got, ok := parseHintUint64(json.Number("9007199254740993.0")); !ok || got != 9007199254740993 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	if _, ok := transactionVersionEntry(json.Number("1.0000000000000000001")); ok {
		t.Fatal("near-integer version accepted")
	}
	if got, ok := uptoOpenSlotString(json.Number("9007199254740993.0")); !ok || got != "9007199254740993" {
		t.Fatalf("openSlot = (%q, %v)", got, ok)
	}
}
