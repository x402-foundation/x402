package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

const afterClaimNetwork = "eip155:84532"

func afterClaimConfig() batchsettlement.ChannelConfig {
	return batchsettlement.ChannelConfig{
		Payer:              "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		PayerAuthorizer:    zeroAddress,
		Receiver:           "0x9876543210987654321098765432109876543210",
		ReceiverAuthorizer: "0x1111111111111111111111111111111111111111",
		Token:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		WithdrawDelay:      900,
		Salt:               managedSalt("00"),
	}
}

func afterClaimChannel(balance string, chargeCount int) *FacilitatorChannel {
	cfg := afterClaimConfig()
	channelId, err := batchsettlement.ComputeChannelId(cfg, afterClaimNetwork)
	if err != nil {
		panic(err)
	}
	return &FacilitatorChannel{
		Channel: storage.Channel{
			ChannelId:               channelId,
			ChannelConfig:           cfg,
			ChargedCumulativeAmount: "5000",
			SignedMaxClaimable:      "5000",
			Signature:               "0xdeadbeef",
			Balance:                 balance,
			TotalClaimed:            "0",
			LastRequestTimestamp:    time.Now().UnixMilli(),
			Network:                 afterClaimNetwork,
		},
		ChargeCount: chargeCount,
	}
}

func afterClaimVoucher(channel *FacilitatorChannel) batchsettlement.BatchSettlementVoucherClaim {
	claim := batchsettlement.BatchSettlementVoucherClaim{
		Signature:    "0xdeadbeef",
		TotalClaimed: "5000",
	}
	claim.Voucher.Channel = channel.ChannelConfig
	claim.Voucher.MaxClaimableAmount = "5000"
	return claim
}

func plantClaimMarker(channel *FacilitatorChannel, count int, claimedTo string) {
	channel.PendingClaim = &PendingClaim{
		AttestedCount: count,
		ClaimedTo:     claimedTo,
		StartedAt:     time.Now().UnixMilli(),
	}
}

func managedAfterClaimStores(t *testing.T) (*storage.InMemoryChannelStorage[*FacilitatorChannel], storage.SettleTargetStorage) {
	t.Helper()
	return storage.NewInMemoryChannelStorage[*FacilitatorChannel](), storage.NewInMemorySettleTargetStorage()
}

func TestAfterClaim_DoesNotDeleteWhenFullyClaimed(t *testing.T) {
	t.Parallel()
	store, targets := managedAfterClaimStores(t)
	channel := afterClaimChannel("5000", 0)
	if err := seedChannel(store, channel); err != nil {
		t.Fatal(err)
	}
	if err := AfterClaim(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, targets); err != nil {
		t.Fatalf("AfterClaim: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got == nil {
		t.Fatalf("row deleted: %v", err)
	}
	page, err := targets.ListSettleTargets(context.Background(), storage.SettleQuery{Network: afterClaimNetwork, Limit: intPtr(10)})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("settle target upsert: %v items=%d", err, len(page.Items))
	}
}

func TestAfterClaim_SubtractsAttestedChargeCount(t *testing.T) {
	t.Parallel()
	store, targets := managedAfterClaimStores(t)
	channel := afterClaimChannel("5000", 2)
	plantClaimMarker(channel, 2, "5000")
	if err := seedChannel(store, channel); err != nil {
		t.Fatal(err)
	}
	if err := AfterClaim(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, targets); err != nil {
		t.Fatalf("AfterClaim: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.ChargeCount != 0 {
		t.Fatalf("chargeCount=%d want 0", got.ChargeCount)
	}
}

func TestAfterClaim_RecordsTargetsBeforeFinishingChannels(t *testing.T) {
	t.Parallel()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	log := make([]string, 0)
	channels := orderLogStore{InMemoryChannelStorage: inner, log: &log}
	targets := &orderLogTargets{InMemorySettleTargetStorage: storage.NewInMemorySettleTargetStorage(), log: &log}
	first := afterClaimChannel("5000", 2)
	plantClaimMarker(first, 2, "5000")
	secondCfg := afterClaimConfig()
	secondCfg.Salt = managedSalt("02")
	secondID, err := batchsettlement.ComputeChannelId(secondCfg, afterClaimNetwork)
	if err != nil {
		t.Fatal(err)
	}
	second := afterClaimChannel("5000", 1)
	second.ChannelId = secondID
	second.ChannelConfig = secondCfg
	second.ChargedCumulativeAmount = "300"
	second.TotalClaimed = "100"
	plantClaimMarker(second, 1, "300")
	claimSecond := afterClaimVoucher(second)
	claimSecond.TotalClaimed = "300"
	if err := seedChannel(&channels, first); err != nil {
		t.Fatal(err)
	}
	if err := seedChannel(&channels, second); err != nil {
		t.Fatal(err)
	}
	log = nil
	claims := []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(first), claimSecond}
	known := []*FacilitatorChannel{first, second}
	if err := afterClaim(context.Background(), &channels, claims, afterClaimNetwork, targets, known, nil, nil); err != nil {
		t.Fatal(err)
	}
	if len(log) != 3 || log[0] != "target" || log[1] != "channel" || log[2] != "channel" {
		t.Fatalf("ops = %v, want the target then one update per channel", log)
	}
	if len(targets.amounts) != 1 || targets.amounts[0] != "5200" {
		t.Fatalf("deltas = %v, want one aggregated 5200", targets.amounts)
	}
	got, err := inner.Get(context.Background(), first.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.TotalClaimed != "5000" || got.ChargeCount != 0 || got.PendingClaim != nil {
		t.Fatalf("first totalClaimed=%s chargeCount=%d marker=%v", got.TotalClaimed, got.ChargeCount, got.PendingClaim)
	}
}

type failRecordTargets struct {
	*storage.InMemorySettleTargetStorage
}

func (s *failRecordTargets) RecordClaimed(context.Context, storage.SettleTargetClaimDelta) error {
	return errors.New("record failed")
}

func TestAfterClaim_TargetWriteFailureLeavesWatermark(t *testing.T) {
	t.Parallel()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("5000", 2)
	plantClaimMarker(channel, 2, "5000")
	if err := seedChannel(store, channel); err != nil {
		t.Fatal(err)
	}
	targets := &failRecordTargets{InMemorySettleTargetStorage: storage.NewInMemorySettleTargetStorage()}
	err := AfterClaim(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, targets)
	if err == nil || err.Error() != "record failed" {
		t.Fatalf("err = %v", err)
	}
	got, getErr := store.Get(context.Background(), channel.ChannelId)
	if getErr != nil || got.TotalClaimed != "0" || got.ChargeCount != 2 || got.PendingClaim == nil {
		t.Fatalf("watermark moved: %+v %v", got, getErr)
	}
}

func TestAfterClaim_DoesNotSubtractTwice(t *testing.T) {
	t.Parallel()
	store, targets := managedAfterClaimStores(t)
	channel := afterClaimChannel("8000", 80)
	plantClaimMarker(channel, 50, "5000")
	if err := seedChannel(store, channel); err != nil {
		t.Fatal(err)
	}
	claims := []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}
	if err := AfterClaim(context.Background(), store, claims, afterClaimNetwork, targets); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got.ChargeCount != 30 || got.PendingClaim != nil {
		t.Fatalf("after finish: %+v %v", got, err)
	}
	if err := AfterClaim(context.Background(), store, claims, afterClaimNetwork, targets); err != nil {
		t.Fatal(err)
	}
	got, err = store.Get(context.Background(), channel.ChannelId)
	if err != nil || got.ChargeCount != 30 {
		t.Fatalf("replay chargeCount=%d err=%v", got.ChargeCount, err)
	}
}

type conflictChannelStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	calls int
}

func (s *conflictChannelStore) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	s.calls++
	return &storage.ChannelUpdateResult[*FacilitatorChannel]{Status: storage.ChannelConflict}, nil
}

func TestAfterClaim_ConflictRetries(t *testing.T) {
	t.Parallel()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("5000", 2)
	plantClaimMarker(channel, 2, "5000")
	if err := seedChannel(inner, channel); err != nil {
		t.Fatal(err)
	}
	store := &conflictChannelStore{InMemoryChannelStorage: inner}
	err := AfterClaim(context.Background(), store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, storage.NewInMemorySettleTargetStorage())
	if !errors.Is(err, errChannelConflict) {
		t.Fatalf("err = %v", err)
	}
	if store.calls < 2 {
		t.Fatalf("update calls = %d, want a retry", store.calls)
	}
	got, err := inner.Get(context.Background(), channel.ChannelId)
	if err != nil || got.ChargeCount != 2 || got.PendingClaim == nil {
		t.Fatalf("row changed: %+v %v", got, err)
	}
}

type orderLogStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	log *[]string
	mu  sync.Mutex
}

func (s *orderLogStore) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	s.mu.Lock()
	*s.log = append(*s.log, "channel")
	s.mu.Unlock()
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelID, update)
}

type orderLogTargets struct {
	*storage.InMemorySettleTargetStorage
	log     *[]string
	amounts []string
}

func (s *orderLogTargets) RecordClaimed(ctx context.Context, delta storage.SettleTargetClaimDelta) error {
	*s.log = append(*s.log, "target")
	if delta.Amount != nil {
		s.amounts = append(s.amounts, delta.Amount.String())
	}
	return s.InMemorySettleTargetStorage.RecordClaimed(ctx, delta)
}

func seedChannel(store storage.ChannelStorage[*FacilitatorChannel], channel *FacilitatorChannel) error {
	_, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current != nil {
			return current
		}
		return channel.Clone()
	})
	return err
}

func intPtr(v int) *int {
	return &v
}

func TestUnreconciledClaimDelta(t *testing.T) {
	t.Parallel()
	channel := &FacilitatorChannel{}
	if !unreconciledClaimDelta(channel, big.NewInt(1)) {
		t.Fatal("onchain ahead of a zero watermark is unreconciled")
	}
	channel.PendingClaim = &PendingClaim{AttestedCount: 1, ClaimedTo: "1", StartedAt: 1}
	if unreconciledClaimDelta(channel, big.NewInt(1)) {
		t.Fatal("a live marker is resolved by preflight, not this warning")
	}
	channel.PendingClaim = nil
	channel.TotalClaimed = "5"
	if unreconciledClaimDelta(channel, big.NewInt(5)) {
		t.Fatal("equal totals are reconciled")
	}
}

func TestAttestedChannelIDs_MatchesRowsByChannelAndTotal(t *testing.T) {
	t.Parallel()
	channel := afterClaimChannel("10000", 3)
	row := func(total string) batchsettlement.BatchSettlementVoucherClaim {
		claim := afterClaimVoucher(channel)
		claim.TotalClaimed = total
		return claim
	}
	id := channel.ChannelId
	key := strings.ToLower(id)

	cases := []struct {
		name    string
		claims  []batchsettlement.BatchSettlementVoucherClaim
		claimed map[string]struct{}
		want    bool
	}{
		{"nil claimed attests every row", []batchsettlement.BatchSettlementVoucherClaim{row("5")}, nil, true},
		{"event for the row total attests", []batchsettlement.BatchSettlementVoucherClaim{row("5")}, map[string]struct{}{batchsettlement.ClaimRowKey(id, "5"): {}}, true},
		{"event for another total does not attest", []batchsettlement.BatchSettlementVoucherClaim{row("5")}, map[string]struct{}{batchsettlement.ClaimRowKey(id, "8"): {}}, false},
		{"no events attests nothing", []batchsettlement.BatchSettlementVoucherClaim{row("5")}, map[string]struct{}{}, false},
		{"no-op duplicate row does not hide the applied row", []batchsettlement.BatchSettlementVoucherClaim{row("5"), row("8")}, map[string]struct{}{batchsettlement.ClaimRowKey(id, "8"): {}}, true},
	}
	for _, tc := range cases {
		got := attestedChannelIDs(tc.claims, afterClaimNetwork, tc.claimed)[key]
		if got != tc.want {
			t.Errorf("%s: attested = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestAfterClaim_SubtractsSnapshotOnceWhenChannelRepeats(t *testing.T) {
	t.Parallel()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	targets := storage.NewInMemorySettleTargetStorage()
	channel := afterClaimChannel("10000", 6)
	plantClaimMarker(channel, 6, "8000")
	if err := seedChannel(store, channel); err != nil {
		t.Fatal(err)
	}
	row := func(total string) batchsettlement.BatchSettlementVoucherClaim {
		claim := afterClaimVoucher(channel)
		claim.TotalClaimed = total
		return claim
	}
	claimed := map[string]struct{}{
		batchsettlement.ClaimRowKey(channel.ChannelId, "5000"): {},
		batchsettlement.ClaimRowKey(channel.ChannelId, "8000"): {},
	}
	claims := []batchsettlement.BatchSettlementVoucherClaim{row("5000"), row("8000")}
	if err := afterClaim(context.Background(), store, claims, afterClaimNetwork, targets, nil, nil, claimed); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.ChargeCount != 0 || got.PendingClaim != nil || got.TotalClaimed != "8000" {
		t.Fatalf("chargeCount=%d marker=%v totalClaimed=%s, want 0, nil, 8000", got.ChargeCount, got.PendingClaim, got.TotalClaimed)
	}
}
