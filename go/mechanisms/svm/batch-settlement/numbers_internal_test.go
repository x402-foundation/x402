package batchsettlement

import (
	"encoding/json"
	"testing"
)

func TestAsInt64JSONNumber(t *testing.T) {
	for _, in := range []json.Number{"60.0", "6e1"} {
		if got, ok := asInt64(in); !ok || got != 60 {
			t.Fatalf("asInt64(%q) = (%d, %v)", in, got, ok)
		}
	}
	for _, in := range []json.Number{"1.5", "9223372036854775808"} {
		if got, ok := asInt64(in); ok {
			t.Fatalf("asInt64(%q) = %d, want ok=false", in, got)
		}
	}
}
