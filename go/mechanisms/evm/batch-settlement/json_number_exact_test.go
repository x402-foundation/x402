package batchsettlement

import (
	"encoding/json"
	"testing"
)

func TestExtraIntRejectsNearInteger(t *testing.T) {
	if n, ok := ExtraInt(json.Number("60.0000000000000000001")); ok {
		t.Fatalf("accepted as %d", n)
	}
	if n, ok := ExtraInt(json.Number("6e1")); !ok || n != 60 {
		t.Fatalf("6e1 = (%d, %v)", n, ok)
	}
}
