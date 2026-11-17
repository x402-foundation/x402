package client

import (
	"encoding/json"
	"testing"
)

func TestParseStatesAcceptIntegralDecimals(t *testing.T) {
	state, ok := parseChannelState(map[string]any{"channelId": "c", "withdrawRequestedAt": json.Number("1700000000.0")})
	if !ok || state.WithdrawRequestedAt != 1700000000 {
		t.Fatalf("channel state = (%+v, %v)", state, ok)
	}
	vs, ok := parseVoucherState(map[string]any{"signature": "s", "expiresAt": json.Number("1.9e9")})
	if !ok || vs.ExpiresAt != 1900000000 {
		t.Fatalf("voucher state = (%+v, %v)", vs, ok)
	}
}
