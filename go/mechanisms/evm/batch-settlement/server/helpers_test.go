package server

import (
	"context"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const (
	testChA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testChB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testChC = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

func sampleSession(id, charged string) *ChannelSession {
	return &ChannelSession{
		ChannelId:               id,
		ChannelConfig:           batchsettlement.ChannelConfig{Payer: "0x1", Receiver: "0x2"},
		ChargedCumulativeAmount: charged,
		SignedMaxClaimable:      "1000",
		Signature:               "0xsig",
		Balance:                 "900",
		TotalClaimed:            "100",
		WithdrawRequestedAt:     0,
		RefundNonce:             0,
		LastRequestTimestamp:    1,
	}
}

// seedSession upserts sess via UpdateChannel CAS so tests never use blind writes.
func seedSession(t *testing.T, s *BatchSettlementEvmScheme, channelId string, sess *ChannelSession) {
	t.Helper()
	if _, err := s.GetStorage().UpdateChannel(context.Background(), channelId, func(*ChannelSession) *ChannelSession {
		return sess.Clone()
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

// seedStore upserts sess directly on a SessionStorage via UpdateChannel CAS.
func seedStore(t *testing.T, store SessionStorage, channelId string, sess *ChannelSession) {
	t.Helper()
	if _, err := store.UpdateChannel(context.Background(), channelId, func(*ChannelSession) *ChannelSession {
		return sess.Clone()
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
}
