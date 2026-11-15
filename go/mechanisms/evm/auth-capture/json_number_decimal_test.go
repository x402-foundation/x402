package authcapture

import (
	"encoding/json"
	"testing"
)

func TestJSONNumberToUint64IntegralDecimal(t *testing.T) {
	for _, in := range []json.Number{"60.0", "6e1"} {
		if got, ok := JSONNumberToUint64(in); !ok || got != 60 {
			t.Fatalf("JSONNumberToUint64(%q) = (%d, %v)", in, got, ok)
		}
	}
	if _, ok := JSONNumberToUint64(json.Number("1.5")); ok {
		t.Fatal("1.5 must be rejected")
	}
}

func TestJSONNumberToUint64AboveInt64(t *testing.T) {
	if got, ok := JSONNumberToUint64(json.Number("18446744073709551615")); !ok || got != 18446744073709551615 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	if got, ok := JSONNumberToUint64(json.Number("18446744073709551616")); ok {
		t.Fatalf("2^64 accepted as %d", got)
	}
}
