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
