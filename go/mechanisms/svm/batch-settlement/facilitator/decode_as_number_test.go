package facilitator

import (
	"encoding/json"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

func decodedBatchPayload(t *testing.T, inner string) map[string]any {
	t.Helper()
	body := `{"x402Version":2,"accepted":{"scheme":"batch-settlement","network":"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1","amount":"1","asset":"a","payTo":"b","maxTimeoutSeconds":60},"payload":` + inner + `}`
	p, err := types.ToPaymentPayload([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return p.Payload
}

func TestDecodeAsAcceptsIntegralDecimals(t *testing.T) {
	for _, delay := range []string{"60", "60.0", "6e1"} {
		record := decodedBatchPayload(t, `{"type":"seal","channelId":"c","channelConfig":{"withdrawDelay":`+delay+`}}`)
		seal, err := decodeAs[batchsettlement.BatchSealPayload](record)
		if err != nil {
			t.Fatalf("withdrawDelay %s: %v", delay, err)
		}
		if seal.ChannelConfig.WithdrawDelay != 60 {
			t.Fatalf("withdrawDelay %s decoded as %d", delay, seal.ChannelConfig.WithdrawDelay)
		}
		if _, err := decodeAs[batchsettlement.BatchClaimPayload](decodedBatchPayload(t, `{"type":"claim","claims":[{"channelId":"c","channelConfig":{"withdrawDelay":`+delay+`}}]}`)); err != nil {
			t.Fatalf("claim withdrawDelay %s: %v", delay, err)
		}
	}
}

func TestDecodeAsRejectsFractionalInteger(t *testing.T) {
	record := decodedBatchPayload(t, `{"type":"seal","channelId":"c","channelConfig":{"withdrawDelay":60.5}}`)
	if _, err := decodeAs[batchsettlement.BatchSealPayload](record); err == nil {
		t.Fatal("60.5 accepted for an int field")
	}
}

func TestDecodeAsLeavesRecordUnchanged(t *testing.T) {
	record := decodedBatchPayload(t, `{"type":"seal","channelId":"c","channelConfig":{"withdrawDelay":60.0}}`)
	if _, err := decodeAs[batchsettlement.BatchSealPayload](record); err != nil {
		t.Fatal(err)
	}
	if got := record["channelConfig"].(map[string]any)["withdrawDelay"]; got != any(json.Number("60.0")) {
		t.Fatalf("record mutated: %#v", got)
	}
}
