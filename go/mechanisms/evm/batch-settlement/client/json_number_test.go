package client

import (
	"encoding/json"
	"testing"

	"github.com/x402-foundation/x402/go/v2/types"
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

func TestBuildChannelConfigFromDecodedRequirements(t *testing.T) {
	req := defaultRequirements()
	req.Extra["withdrawDelay"] = 1234
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := types.ToPaymentRequirements(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded.Extra["withdrawDelay"].(json.Number); !ok {
		t.Fatalf("withdrawDelay decoded as %T, want json.Number", decoded.Extra["withdrawDelay"])
	}
	scheme := NewBatchSettlementEvmScheme(&mockSigner{address: "0xSIGNER"}, nil)
	config, err := scheme.BuildChannelConfig(*decoded)
	if err != nil {
		t.Fatal(err)
	}
	if config.WithdrawDelay != 1234 {
		t.Fatalf("withdrawDelay = %d, want 1234", config.WithdrawDelay)
	}
}
