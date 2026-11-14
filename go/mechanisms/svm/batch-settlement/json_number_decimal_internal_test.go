package batchsettlement

import (
	"encoding/json"
	"testing"
)

func TestAsInt64IntegralDecimal(t *testing.T) {
	for _, in := range []json.Number{"60.0", "6e1"} {
		if got, ok := asInt64(in); !ok || got != 60 {
			t.Fatalf("asInt64(%q) = (%d, %v)", in, got, ok)
		}
	}
	if _, ok := asInt64(json.Number("1.5")); ok {
		t.Fatal("1.5 must be rejected")
	}
}
