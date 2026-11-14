package upto

import (
	"encoding/json"
	"math"
	"testing"
)

func TestParseWithdrawDelayJSONNumber(t *testing.T) {
	for in, want := range map[json.Number]uint32{"900": 900, "60.0": 60, "6e1": 60} {
		got, err := ParseWithdrawDelay(in)
		if err != nil || got != want {
			t.Fatalf("ParseWithdrawDelay(%q) = (%d, %v), want %d", in, got, err, want)
		}
	}
	for _, bad := range []json.Number{"1.5", "0", "-1", "4294967296"} {
		if _, err := ParseWithdrawDelay(bad); err == nil || err.Error() != "withdrawDelay must be an integer greater than zero" {
			t.Fatalf("ParseWithdrawDelay(%q) err = %v", bad, err)
		}
	}
}

func TestParseExtraUint64JSONNumber(t *testing.T) {
	if got, ok := ParseExtraUint64(json.Number("18446744073709551615")); !ok || got != math.MaxUint64 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	if got, ok := ParseExtraUint64(json.Number("12345")); !ok || got != 12345 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	for _, bad := range []json.Number{"-1", "1.5"} {
		if got, ok := ParseExtraUint64(bad); ok {
			t.Fatalf("ParseExtraUint64(%q) = %d, want ok=false", bad, got)
		}
	}
}
