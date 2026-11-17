package authcapture

import (
	"encoding/json"
	"testing"
)

func TestJSONNumberToUint64ExactDecimal(t *testing.T) {
	if got, ok := JSONNumberToUint64(json.Number("9007199254740993.0")); !ok || got != 9007199254740993 {
		t.Fatalf("got (%d, %v)", got, ok)
	}
	if got, ok := JSONNumberToUint64(json.Number("60.0000000000000000001")); ok {
		t.Fatalf("near-integer accepted as %d", got)
	}
}
