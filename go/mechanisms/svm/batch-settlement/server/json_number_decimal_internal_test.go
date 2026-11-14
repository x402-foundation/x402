package server

import (
	"encoding/json"
	"testing"
)

func TestAsRequirementIntIntegralDecimal(t *testing.T) {
	for _, in := range []json.Number{"60.0", "6e1"} {
		if got, ok := asRequirementInt(in); !ok || got != 60 {
			t.Fatalf("asRequirementInt(%q) = (%d, %v)", in, got, ok)
		}
	}
	if _, ok := asRequirementInt(json.Number("1.5")); ok {
		t.Fatal("1.5 must be rejected")
	}
}

func TestAdvertisedCapacityIntegralDecimal(t *testing.T) {
	if got := advertisedCapacity(json.Number("7.0")); got != 7 {
		t.Fatalf("advertisedCapacity(7.0) = %d", got)
	}
}
