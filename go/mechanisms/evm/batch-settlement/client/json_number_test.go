package client

import (
	"encoding/json"
	"testing"
)

func TestBuildChannelConfigJSONNumberWithdrawDelay(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0xSIGNER"}, nil)
	req := defaultRequirements()
	req.Extra["withdrawDelay"] = json.Number("1234")
	config, err := scheme.BuildChannelConfig(req)
	if err != nil {
		t.Fatal(err)
	}
	if config.WithdrawDelay != 1234 {
		t.Fatalf("withdrawDelay = %d, want 1234", config.WithdrawDelay)
	}
}
