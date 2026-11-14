package server

import (
	"encoding/json"
	"testing"
)

func TestMapUintStringFieldJSONNumber(t *testing.T) {
	got, ok := mapUintStringField(map[string]interface{}{"k": json.Number("9007199254740993")}, "k")
	if !ok || got != "9007199254740993" {
		t.Fatalf("got (%q, %v)", got, ok)
	}
	for _, bad := range []json.Number{"-5", "1.5"} {
		if got, ok := mapUintStringField(map[string]interface{}{"k": bad}, "k"); ok {
			t.Fatalf("mapUintStringField(%q) = %q, want ok=false", bad, got)
		}
	}
}

func TestMapIntFieldJSONNumber(t *testing.T) {
	if got := mapIntField(map[string]interface{}{"k": json.Number("7")}, "k", -1); got != 7 {
		t.Fatalf("got %d", got)
	}
	if got := mapIntField(map[string]interface{}{"k": json.Number("x")}, "k", -1); got != -1 {
		t.Fatalf("got %d, want default", got)
	}
}

func TestMapStringFieldJSONNumber(t *testing.T) {
	if got := mapStringField(map[string]interface{}{"k": json.Number("9007199254740993")}, "k", "d"); got != "9007199254740993" {
		t.Fatalf("got %q", got)
	}
}

func TestReadChannelStateFromExtraJSONNumber(t *testing.T) {
	cs := readChannelStateFromExtra(map[string]interface{}{
		"channelState": map[string]interface{}{
			"channelId":               "0x01",
			"balance":                 json.Number("9007199254740993"),
			"totalClaimed":            json.Number("9007199254740995"),
			"withdrawRequestedAt":     json.Number("1700000000"),
			"refundNonce":             json.Number("3"),
			"chargedCumulativeAmount": json.Number("12"),
		},
	})
	if cs == nil || cs.Balance != "9007199254740993" || cs.TotalClaimed != "9007199254740995" ||
		cs.WithdrawRequestedAt != 1700000000 || cs.RefundNonce != "3" || cs.ChargedCumulativeAmount != "12" {
		t.Fatalf("got %+v", cs)
	}
}

func TestReadCorrectiveChannelStateJSONNumber(t *testing.T) {
	cs := readCorrectiveChannelState(map[string]interface{}{
		"channelState": map[string]interface{}{
			"channelId":           "0x01",
			"refundNonce":         json.Number("4"),
			"withdrawRequestedAt": json.Number("5"),
		},
	})
	if cs == nil || cs.RefundNonce != "4" || cs.WithdrawRequestedAt != 5 {
		t.Fatalf("got %+v", cs)
	}
}
