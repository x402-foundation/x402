package paymentchannels

import (
	"encoding/json"
	"testing"
)

func TestParseU64RejectsNearInteger(t *testing.T) {
	if got, err := ParseU64(json.Number("60.0000000000000000001"), "x"); err == nil {
		t.Fatalf("accepted as %d", got)
	}
}
