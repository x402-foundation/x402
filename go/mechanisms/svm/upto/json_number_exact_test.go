package upto

import (
	"encoding/json"
	"testing"
)

func TestParseExtraUint64ExactDecimal(t *testing.T) {
	if got, ok := ParseExtraUint64(json.Number("9007199254740993.0")); !ok || got != 9007199254740993 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	if got, ok := ParseExtraUint64(json.Number("1e20")); ok {
		t.Fatalf("1e20 accepted as %d", got)
	}
	if _, err := ParseWithdrawDelay(json.Number("60.0000000000000000001")); err == nil {
		t.Fatal("near-integer withdrawDelay accepted")
	}
}
