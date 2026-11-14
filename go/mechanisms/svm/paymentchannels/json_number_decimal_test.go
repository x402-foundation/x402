package paymentchannels

import (
	"encoding/json"
	"testing"
)

func TestParseU64IntegralDecimal(t *testing.T) {
	for _, in := range []json.Number{"60.0", "6e1"} {
		if got, err := ParseU64(in, "x"); err != nil || got != 60 {
			t.Fatalf("ParseU64(%q) = (%d, %v)", in, got, err)
		}
	}
	if _, err := ParseU64(json.Number("1.5"), "x"); err == nil {
		t.Fatal("1.5 must be rejected")
	}
}
