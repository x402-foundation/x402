package facilitator

import (
	"encoding/json"
	"testing"
)

func TestOptionalUintStringExactDecimal(t *testing.T) {
	if got := optionalUintString(json.Number("9007199254740993.0")); got == nil || *got != "9007199254740993" {
		t.Fatalf("got %v", got)
	}
	if got := optionalUintString(json.Number("1.0000000000000000001")); got != nil {
		t.Fatalf("near-integer accepted as %q", *got)
	}
	if n, ok := extraNumber(json.Number("1.0000000000000000001")); ok {
		t.Fatalf("extraNumber accepted near-integer as %d", n)
	}
}
