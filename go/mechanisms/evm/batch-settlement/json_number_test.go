package batchsettlement

import (
	"encoding/json"
	"testing"
)

func TestExtraIntJSONNumber(t *testing.T) {
	cases := []struct {
		in   json.Number
		want int
		ok   bool
	}{
		{"900", 900, true},
		{"60.0", 60, true},
		{"abc", 0, false},
	}
	for _, tc := range cases {
		got, ok := ExtraInt(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Fatalf("ExtraInt(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestChannelConfigFromMapJSONNumberWithdrawDelay(t *testing.T) {
	m := validChannelConfigMap()
	m["withdrawDelay"] = json.Number("900")
	cc, err := ChannelConfigFromMap(m)
	if err != nil {
		t.Fatal(err)
	}
	if cc.WithdrawDelay != 900 {
		t.Fatalf("withdrawDelay = %d", cc.WithdrawDelay)
	}
}

func TestChannelStateRequirementsFromMapJSONNumber(t *testing.T) {
	cs := ChannelStateRequirementsFromMap(map[string]interface{}{
		"channelId":           "0x01",
		"withdrawRequestedAt": json.Number("1700000000"),
	})
	if cs == nil || cs.WithdrawRequestedAt != 1700000000 {
		t.Fatalf("got %+v", cs)
	}
}
