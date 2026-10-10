package storage

import (
	"context"
	"testing"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const claimsNetwork = "eip155:84532"

func claimsBaseChannel(overrides *Channel) *Channel {
	channelConfig := batchsettlement.ChannelConfig{
		Payer:              "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		PayerAuthorizer:    "0x0000000000000000000000000000000000000000",
		Receiver:           "0x9876543210987654321098765432109876543210",
		ReceiverAuthorizer: "0x1111111111111111111111111111111111111111",
		Token:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		WithdrawDelay:      900,
		Salt:               "0x0000000000000000000000000000000000000000000000000000000000000000",
	}
	if overrides != nil && overrides.ChannelConfig.Salt != "" {
		channelConfig = overrides.ChannelConfig
		if channelConfig.Payer == "" {
			channelConfig.Payer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
			channelConfig.PayerAuthorizer = "0x0000000000000000000000000000000000000000"
			channelConfig.Receiver = "0x9876543210987654321098765432109876543210"
			channelConfig.ReceiverAuthorizer = "0x1111111111111111111111111111111111111111"
			channelConfig.Token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
			channelConfig.WithdrawDelay = 900
		}
	}
	channelId, err := batchsettlement.ComputeChannelId(channelConfig, claimsNetwork)
	if err != nil {
		panic(err)
	}
	out := &Channel{
		ChannelId:               channelId,
		ChannelConfig:           channelConfig,
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Signature:               "0xdeadbeef",
		Balance:                 "10000",
		TotalClaimed:            "0",
		WithdrawRequestedAt:     0,
		RefundNonce:             0,
		LastRequestTimestamp:    time.Now().UnixMilli(),
	}
	if overrides == nil {
		return out
	}
	if overrides.ChargedCumulativeAmount != "" {
		out.ChargedCumulativeAmount = overrides.ChargedCumulativeAmount
	}
	if overrides.TotalClaimed != "" {
		out.TotalClaimed = overrides.TotalClaimed
	}
	if overrides.LastRequestTimestamp != 0 {
		out.LastRequestTimestamp = overrides.LastRequestTimestamp
	}
	if overrides.SignedMaxClaimable != "" {
		out.SignedMaxClaimable = overrides.SignedMaxClaimable
	}
	return out
}

func TestSelectClaimableVouchers_AlreadyClaimed(t *testing.T) {
	channel := claimsBaseChannel(&Channel{ChargedCumulativeAmount: "1000", TotalClaimed: "1000"})
	if got := SelectClaimableVouchers([]*Channel{channel}, nil); len(got) != 0 {
		t.Fatalf("got %d claims", len(got))
	}
}

func TestSelectClaimableVouchers_IncludesFreshWhenIdleOmitted(t *testing.T) {
	fresh := claimsBaseChannel(&Channel{LastRequestTimestamp: time.Now().UnixMilli()})
	got := SelectClaimableVouchers([]*Channel{fresh}, nil)
	if len(got) != 1 {
		t.Fatalf("got %d claims", len(got))
	}
	if got[0].TotalClaimed != fresh.ChargedCumulativeAmount {
		t.Fatalf("totalClaimed = %q", got[0].TotalClaimed)
	}
}

func TestSelectClaimableVouchers_SkipsInsideIdleWindow(t *testing.T) {
	now := int64(1_000_000)
	fresh := claimsBaseChannel(&Channel{LastRequestTimestamp: now - 30_000})
	idleCfg := claimsBaseChannel(nil).ChannelConfig
	idleCfg.Salt = "0x0000000000000000000000000000000000000000000000000000000000000001"
	idle := claimsBaseChannel(&Channel{ChannelConfig: idleCfg, LastRequestTimestamp: now - 120_000})
	idleSecs := 60
	got := SelectClaimableVouchers([]*Channel{fresh, idle}, &SelectClaimableOptions{Now: now, IdleSecs: &idleSecs})
	if len(got) != 1 {
		t.Fatalf("got %d claims", len(got))
	}
	if got[0].TotalClaimed != idle.ChargedCumulativeAmount {
		t.Fatalf("selected %q", got[0].TotalClaimed)
	}
}

func TestSelectClaimableVouchers_SkipsCorruptWatermarks(t *testing.T) {
	corruptCharged := claimsBaseChannel(&Channel{ChargedCumulativeAmount: "not-a-number", TotalClaimed: "0"})
	if got := SelectClaimableVouchers([]*Channel{corruptCharged}, nil); len(got) != 0 {
		t.Fatalf("corrupt charged: got %d claims, want 0", len(got))
	}
	corruptClaimed := claimsBaseChannel(&Channel{ChargedCumulativeAmount: "5000", TotalClaimed: "not-a-number"})
	if got := SelectClaimableVouchers([]*Channel{corruptClaimed}, nil); len(got) != 0 {
		t.Fatalf("corrupt claimed: got %d claims, want 0", len(got))
	}
}

func TestApplyClaimedTotals_SkipsCorruptClaimAndCorruptRow(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	channel := claimsBaseChannel(&Channel{TotalClaimed: "1000"})
	if _, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(*Channel) *Channel { return channel }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := ApplyClaimedTotals(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{voucherClaim(channel, "not-a-number")}, claimsNetwork); err != nil {
		t.Fatalf("ApplyClaimedTotals: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got.TotalClaimed != "1000" {
		t.Fatalf("corrupt claim must not write: totalClaimed = %+v err=%v", got, err)
	}

	corruptCfg := claimsBaseChannel(nil).ChannelConfig
	corruptCfg.Salt = "0x0000000000000000000000000000000000000000000000000000000000000002"
	corruptRow := claimsBaseChannel(&Channel{ChannelConfig: corruptCfg, TotalClaimed: "not-a-number"})
	if _, err := store.UpdateChannel(context.Background(), corruptRow.ChannelId, func(*Channel) *Channel { return corruptRow }); err != nil {
		t.Fatalf("seed corrupt: %v", err)
	}
	if err := ApplyClaimedTotals(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{voucherClaim(corruptRow, "5000")}, claimsNetwork); err != nil {
		t.Fatalf("ApplyClaimedTotals: %v", err)
	}
	gotCorrupt, err := store.Get(context.Background(), corruptRow.ChannelId)
	if err != nil || gotCorrupt.TotalClaimed != "not-a-number" {
		t.Fatalf("corrupt row must stay unchanged: totalClaimed = %+v err=%v", gotCorrupt, err)
	}
}

func voucherClaim(channel *Channel, totalClaimed string) batchsettlement.BatchSettlementVoucherClaim {
	claim := batchsettlement.BatchSettlementVoucherClaim{
		Signature:    "0xdeadbeef",
		TotalClaimed: totalClaimed,
	}
	claim.Voucher.Channel = channel.ChannelConfig
	claim.Voucher.MaxClaimableAmount = "5000"
	return claim
}

func TestApplyClaimedTotals_IgnoresMissingChannels(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	channel := claimsBaseChannel(nil)
	if err := ApplyClaimedTotals(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{voucherClaim(channel, "5000")}, claimsNetwork); err != nil {
		t.Fatalf("ApplyClaimedTotals: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got != nil {
		t.Fatalf("Get: %+v err=%v", got, err)
	}
}

func TestApplyClaimedTotals_IgnoresClaimsThatDoNotAdvance(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	channel := claimsBaseChannel(&Channel{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	if _, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(*Channel) *Channel { return channel }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := ApplyClaimedTotals(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{voucherClaim(channel, "5000")}, claimsNetwork); err != nil {
		t.Fatalf("ApplyClaimedTotals: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got.TotalClaimed != "5000" {
		t.Fatalf("totalClaimed = %+v err=%v", got, err)
	}
}

func TestApplyClaimedTotals_DoesNotRegressStaleBatch(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	channel := claimsBaseChannel(&Channel{TotalClaimed: "4000"})
	if _, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(*Channel) *Channel { return channel }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := ApplyClaimedTotals(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{voucherClaim(channel, "3000")}, claimsNetwork); err != nil {
		t.Fatalf("ApplyClaimedTotals: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got.TotalClaimed != "4000" {
		t.Fatalf("totalClaimed = %+v err=%v", got, err)
	}
}

func TestApplyClaimedTotals_AdvancesWatermark(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	channel := claimsBaseChannel(&Channel{TotalClaimed: "1000"})
	if _, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(*Channel) *Channel { return channel }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := ApplyClaimedTotals(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{voucherClaim(channel, "5000")}, claimsNetwork); err != nil {
		t.Fatalf("ApplyClaimedTotals: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got.TotalClaimed != "5000" {
		t.Fatalf("totalClaimed = %+v err=%v", got, err)
	}
}

type advancingStore struct {
	*InMemoryChannelStorage[*Channel]
}

func (s advancingStore) UpdateChannel(ctx context.Context, channelId string, update func(*Channel) *Channel) (*ChannelUpdateResult[*Channel], error) {
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelId, func(current *Channel) *Channel {
		if current == nil {
			return update(current)
		}
		cp := *current
		cp.TotalClaimed = "6000"
		return update(&cp)
	})
}

func TestApplyClaimedTotals_DoesNotLowerWhenStorageAdvanced(t *testing.T) {
	base := NewInMemoryChannelStorage[*Channel]()
	channel := claimsBaseChannel(&Channel{TotalClaimed: "1000"})
	if _, err := base.UpdateChannel(context.Background(), channel.ChannelId, func(*Channel) *Channel { return channel }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store := advancingStore{InMemoryChannelStorage: base}
	if err := ApplyClaimedTotals[*Channel](context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{voucherClaim(channel, "5000")}, claimsNetwork); err != nil {
		t.Fatalf("ApplyClaimedTotals: %v", err)
	}
	got, err := base.Get(context.Background(), channel.ChannelId)
	if err != nil || got.TotalClaimed != "6000" {
		t.Fatalf("totalClaimed = %+v err=%v", got, err)
	}
}
