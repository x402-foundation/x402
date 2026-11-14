package svm

import (
	"encoding/json"
	"math"
	"testing"
)

func TestParseHintUint64JSONNumber(t *testing.T) {
	if got, ok := parseHintUint64(json.Number("12345")); !ok || got != 12345 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	if got, ok := parseHintUint64(json.Number("18446744073709551615")); !ok || got != math.MaxUint64 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	for _, bad := range []json.Number{"-1", "1.5"} {
		if got, ok := parseHintUint64(bad); ok {
			t.Fatalf("parseHintUint64(%q) = %d, want ok=false", bad, got)
		}
	}
}

func TestTransactionVersionEntryJSONNumber(t *testing.T) {
	for in, want := range map[json.Number]int{"0": 0, "1": 1} {
		if got, ok := transactionVersionEntry(in); !ok || got != want {
			t.Fatalf("transactionVersionEntry(%q) = (%d, %v)", in, got, ok)
		}
	}
	if _, ok := transactionVersionEntry(json.Number("2")); ok {
		t.Fatal("2 must be rejected")
	}
}
