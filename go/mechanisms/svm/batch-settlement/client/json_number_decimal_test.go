package client

import (
	"encoding/json"
	"testing"
)

func TestExtraIntIntegralDecimal(t *testing.T) {
	for _, in := range []json.Number{"60.0", "6e1"} {
		if got, ok := extraInt(in); !ok || got != 60 {
			t.Fatalf("extraInt(%q) = (%d, %v)", in, got, ok)
		}
	}
	if _, ok := extraInt(json.Number("1.5")); ok {
		t.Fatal("1.5 must be rejected")
	}
}
