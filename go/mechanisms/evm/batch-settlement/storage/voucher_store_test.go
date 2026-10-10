package storage

import (
	"context"
	"math/big"
	"testing"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

const voucherChannelId = "0xabc1230000000000000000000000000000000000000000000000000000000001"

func voucherBaseChannel(overrides *Channel) *Channel {
	out := &Channel{
		ChannelId: voucherChannelId,
		ChannelConfig: batchsettlement.ChannelConfig{
			Payer:              "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
			PayerAuthorizer:    "0x0000000000000000000000000000000000000000",
			Receiver:           "0x9876543210987654321098765432109876543210",
			ReceiverAuthorizer: "0x1111111111111111111111111111111111111111",
			Token:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			WithdrawDelay:      900,
			Salt:               "0x0000000000000000000000000000000000000000000000000000000000000000",
		},
		ChargedCumulativeAmount: "2000",
		SignedMaxClaimable:      "3000",
		Signature:               "0xaaa",
		Balance:                 "10000",
		TotalClaimed:            "0",
		WithdrawRequestedAt:     0,
		RefundNonce:             0,
		LastRequestTimestamp:    1,
	}
	if overrides == nil {
		return out
	}
	if overrides.ChargedCumulativeAmount != "" {
		out.ChargedCumulativeAmount = overrides.ChargedCumulativeAmount
	}
	if overrides.Balance != "" {
		out.Balance = overrides.Balance
	}
	if overrides.TotalClaimed != "" {
		out.TotalClaimed = overrides.TotalClaimed
	}
	if overrides.RefundNonce != 0 {
		out.RefundNonce = overrides.RefundNonce
	}
	if overrides.WithdrawRequestedAt != 0 {
		out.WithdrawRequestedAt = overrides.WithdrawRequestedAt
	}
	return out
}

func TestPendingTtlMs_ClampsZeroToMinimum(t *testing.T) {
	if got := PendingTtlMs(0); got != 5_000 {
		t.Fatalf("got %d", got)
	}
}

func TestPendingTtlMs_ClampsOversizedToTenMinutes(t *testing.T) {
	if got := PendingTtlMs(3600); got != 600_000 {
		t.Fatalf("got %d", got)
	}
}

func TestPendingTtlMs_HonoursMidRange(t *testing.T) {
	if got := PendingTtlMs(120); got != 120_000 {
		t.Fatalf("got %d", got)
	}
}

func TestDefaultOnchainStateTtlMs_ClampsShortDelay(t *testing.T) {
	if got := DefaultOnchainStateTtlMs(30); got != 30_000 {
		t.Fatalf("got %d", got)
	}
}

func TestDefaultOnchainStateTtlMs_UsesOneThird(t *testing.T) {
	if got := DefaultOnchainStateTtlMs(180); got != 60_000 {
		t.Fatalf("got %d", got)
	}
}

func TestDefaultOnchainStateTtlMs_ClampsLongDelay(t *testing.T) {
	if got := DefaultOnchainStateTtlMs(900); got != 300_000 {
		t.Fatalf("got %d", got)
	}
}

func TestAdmissionOwner_StableForSameInputs(t *testing.T) {
	voucher := batchsettlement.BatchSettlementVoucherFields{
		ChannelId:          voucherChannelId,
		MaxClaimableAmount: "1000",
		Signature:          "0xfeedface",
	}
	first := AdmissionOwner("0xpending", voucher)
	second := AdmissionOwner("0xpending", voucher)
	if first != second {
		t.Fatal("expected stable owner")
	}
}

func TestAdmissionOwner_ChangesWithVoucher(t *testing.T) {
	voucher := batchsettlement.BatchSettlementVoucherFields{
		ChannelId:          voucherChannelId,
		MaxClaimableAmount: "1000",
		Signature:          "0xfeedface",
	}
	owner := AdmissionOwner("0xpending", voucher)
	changedSig := voucher
	changedSig.Signature = "0xdeadbeef"
	changedCap := voucher
	changedCap.MaxClaimableAmount = "2000"
	if AdmissionOwner("0xpending", changedSig) == owner {
		t.Fatal("signature change should change owner")
	}
	if AdmissionOwner("0xpending", changedCap) == owner {
		t.Fatal("cap change should change owner")
	}
}

func TestAdmissionOwner_NormalizesLowercase(t *testing.T) {
	voucher := batchsettlement.BatchSettlementVoucherFields{
		ChannelId:          voucherChannelId,
		MaxClaimableAmount: "1000",
		Signature:          "0xfeedface",
	}
	upper := voucher
	upper.Signature = "0xFEEDFACE"
	if AdmissionOwner("0xPENDING", upper) != AdmissionOwner("0xpending", voucher) {
		t.Fatal("owner should be case-insensitive")
	}
}

func TestAdvertisedVoucherManagers(t *testing.T) {
	cases := []struct {
		name  string
		extra map[string]interface{}
		want  []string
	}{
		{"omitted means server", map[string]interface{}{}, []string{"server"}},
		{"nil extra means server", nil, []string{"server"}},
		{"string slice", map[string]interface{}{"voucherManager": []string{"server", "facilitator"}}, []string{"server", "facilitator"}},
		{"interface slice", map[string]interface{}{"voucherManager": []interface{}{"facilitator"}}, []string{"facilitator"}},
		{"unknown values dropped", map[string]interface{}{"voucherManager": []interface{}{"server", "bogus", 1}}, []string{"server"}},
		{"non-array advertises nothing", map[string]interface{}{"voucherManager": "facilitator"}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := AdvertisedVoucherManagers(tc.extra)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestAdvertisesVoucherManager(t *testing.T) {
	if !AdvertisesVoucherManager(map[string]interface{}{}, "server") {
		t.Fatal("omitted advertises server")
	}
	if AdvertisesVoucherManager(map[string]interface{}{}, "facilitator") {
		t.Fatal("omitted does not advertise facilitator")
	}
	both := map[string]interface{}{"voucherManager": []interface{}{"server", "facilitator"}}
	if !AdvertisesVoucherManager(both, "facilitator") || !AdvertisesVoucherManager(both, "server") {
		t.Fatal("both advertised")
	}
	if AdvertisesVoucherManager(map[string]interface{}{"voucherManager": []interface{}{"facilitator"}}, "server") {
		t.Fatal("facilitator-only does not advertise server")
	}
}

func TestIsFacilitatorManaged_OnlyExplicitFacilitator(t *testing.T) {
	if !IsFacilitatorManaged(map[string]interface{}{"voucherManager": "facilitator"}) {
		t.Fatal("facilitator should be managed")
	}
	if IsFacilitatorManaged(map[string]interface{}{"voucherManager": "server"}) {
		t.Fatal("server should not be managed")
	}
	if IsFacilitatorManaged(map[string]interface{}{"voucherManager": true}) {
		t.Fatal("non-string should not be managed")
	}
	if IsFacilitatorManaged(map[string]interface{}{"voucherStore": true}) {
		t.Fatal("legacy voucherStore flag must be ignored")
	}
	if IsFacilitatorManaged(map[string]interface{}{}) {
		t.Fatal("empty extra should not be managed")
	}
	if VoucherStoreModeOf(types.PaymentRequirements{Extra: map[string]interface{}{"voucherManager": "facilitator"}}) != VoucherStoreModeFacilitator {
		t.Fatal("expected facilitator mode")
	}
	if VoucherStoreModeOf(types.PaymentRequirements{Extra: map[string]interface{}{}}) != VoucherStoreModeSelf {
		t.Fatal("expected self mode")
	}
}

func TestCommitVoucherCharge_MissingWithoutSnapshot(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(1000),
		SignedCap: big.NewInt(5000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"},
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitMissing {
		t.Fatalf("status = %q", result.Status)
	}
}

func TestCommitVoucherCharge_CapExceededDoesNotMutate(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel { return voucherBaseChannel(nil) }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(2000),
		SignedCap: big.NewInt(3000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "3000", Signature: "0xbbb"},
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitCapExceeded || result.Charged != "4000" {
		t.Fatalf("result = %+v", result)
	}
	got, _ := store.Get(context.Background(), voucherChannelId)
	if got.ChargedCumulativeAmount != "2000" {
		t.Fatalf("charged = %q", got.ChargedCumulativeAmount)
	}
}

func TestCommitVoucherCharge_ExpectedCharged(t *testing.T) {
	voucher := batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"}

	t.Run("match commits", func(t *testing.T) {
		store := NewInMemoryChannelStorage[*Channel]()
		if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel { return voucherBaseChannel(nil) }); err != nil {
			t.Fatalf("seed: %v", err)
		}
		result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
			Increment:       big.NewInt(500),
			SignedCap:       big.NewInt(5000),
			ExpectedCharged: big.NewInt(2000),
			Voucher:         voucher,
		})
		if err != nil {
			t.Fatalf("CommitVoucherCharge: %v", err)
		}
		if result.Status != CommitCommitted || result.Current.ChargedCumulativeAmount != "2500" {
			t.Fatalf("result = %+v", result)
		}
	})

	t.Run("mismatch leaves the row unchanged", func(t *testing.T) {
		store := NewInMemoryChannelStorage[*Channel]()
		if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel { return voucherBaseChannel(nil) }); err != nil {
			t.Fatalf("seed: %v", err)
		}
		result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
			Increment:       big.NewInt(500),
			SignedCap:       big.NewInt(5000),
			ExpectedCharged: big.NewInt(0),
			Voucher:         voucher,
		})
		if err != nil {
			t.Fatalf("CommitVoucherCharge: %v", err)
		}
		if result.Status != CommitWatermarkMismatch || result.Charged != "2000" {
			t.Fatalf("result = %+v", result)
		}
		got, _ := store.Get(context.Background(), voucherChannelId)
		if got.ChargedCumulativeAmount != "2000" || got.Signature != "0xaaa" {
			t.Fatalf("row changed: %+v", got)
		}
	})

	t.Run("nil skips the check", func(t *testing.T) {
		store := NewInMemoryChannelStorage[*Channel]()
		if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel { return voucherBaseChannel(nil) }); err != nil {
			t.Fatalf("seed: %v", err)
		}
		result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
			Increment: big.NewInt(500),
			SignedCap: big.NewInt(5000),
			Voucher:   voucher,
		})
		if err != nil {
			t.Fatalf("CommitVoucherCharge: %v", err)
		}
		if result.Status != CommitCommitted || result.Current.ChargedCumulativeAmount != "2500" {
			t.Fatalf("result = %+v", result)
		}
	})

	t.Run("recovered snapshot must match", func(t *testing.T) {
		store := NewInMemoryChannelStorage[*Channel]()
		snapshot := voucherBaseChannel(&Channel{ChargedCumulativeAmount: "1000"})
		matched, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
			Increment:       big.NewInt(500),
			SignedCap:       big.NewInt(5000),
			ExpectedCharged: big.NewInt(1000),
			Voucher:         voucher,
			Snapshot:        snapshot,
		})
		if err != nil {
			t.Fatalf("CommitVoucherCharge: %v", err)
		}
		if matched.Status != CommitCommitted || matched.Current.ChargedCumulativeAmount != "1500" {
			t.Fatalf("match = %+v", matched)
		}

		empty := NewInMemoryChannelStorage[*Channel]()
		miss, err := CommitVoucherCharge(context.Background(), empty, voucherChannelId, CommitVoucherChargeInput[*Channel]{
			Increment:       big.NewInt(500),
			SignedCap:       big.NewInt(5000),
			ExpectedCharged: big.NewInt(0),
			Voucher:         voucher,
			Snapshot:        snapshot,
		})
		if err != nil {
			t.Fatalf("CommitVoucherCharge: %v", err)
		}
		if miss.Status != CommitWatermarkMismatch {
			t.Fatalf("status = %q", miss.Status)
		}
		if got, _ := empty.Get(context.Background(), voucherChannelId); got != nil {
			t.Fatalf("mismatch created a row: %+v", got)
		}
	})
}

func TestCommitVoucherCharge_CorruptWatermarkIsConflictWithoutWrite(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	seed := voucherBaseChannel(nil)
	seed.ChargedCumulativeAmount = "not-a-number"
	if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel { return seed }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(100),
		SignedCap: big.NewInt(100),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "100", Signature: "0xbbb"},
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitConflict {
		t.Fatalf("status = %q, want conflict", result.Status)
	}
	got, _ := store.Get(context.Background(), voucherChannelId)
	if got.ChargedCumulativeAmount != "not-a-number" {
		t.Fatalf("corrupt watermark was overwritten: %q", got.ChargedCumulativeAmount)
	}
}

func TestCommitVoucherCharge_AppliesMapAfterCommit(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel { return voucherBaseChannel(nil) }); err != nil {
		t.Fatalf("seed: %v", err)
	}
	result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(500),
		SignedCap: big.NewInt(3000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "2500", Signature: "0xccc"},
		Map: func(channel *Channel) *Channel {
			cp := *channel
			cp.ChargedCumulativeAmount = "9999"
			return &cp
		},
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitCommitted || result.Current.ChargedCumulativeAmount != "9999" {
		t.Fatalf("result = %+v", result)
	}
}

func TestCommitVoucherCharge_CreatesFromSnapshot(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	snapshot := voucherBaseChannel(&Channel{ChargedCumulativeAmount: "1000", Balance: "9000"})
	result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(500),
		SignedCap: big.NewInt(5000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"},
		Snapshot:  snapshot,
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitCommitted || result.Current.ChargedCumulativeAmount != "1500" || result.Current.Balance != "9000" {
		t.Fatalf("result = %+v", result)
	}
	got, _ := store.Get(context.Background(), voucherChannelId)
	if got == nil {
		t.Fatal("expected stored row")
	}
}

type unchangedChargeStore struct {
	*InMemoryChannelStorage[*Channel]
}

func (s unchangedChargeStore) UpdateChannel(context.Context, string, func(*Channel) *Channel) (*ChannelUpdateResult[*Channel], error) {
	return &ChannelUpdateResult[*Channel]{Channel: voucherBaseChannel(nil), Status: ChannelUnchanged}, nil
}

func TestCommitVoucherCharge_ConflictWhenUpdateNotApplied(t *testing.T) {
	store := unchangedChargeStore{InMemoryChannelStorage: NewInMemoryChannelStorage[*Channel]()}
	result, err := CommitVoucherCharge[*Channel](context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(500),
		SignedCap: big.NewInt(5000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"},
		Snapshot:  voucherBaseChannel(nil),
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitConflict {
		t.Fatalf("status = %q", result.Status)
	}
}

func TestCommitVoucherCharge_LocalVerifyKeepsStoredEscrow(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel {
		seed := voucherBaseChannel(&Channel{Balance: "7777", TotalClaimed: "3"})
		seed.OnchainSyncedAt = 500
		return seed
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	snapshot := voucherBaseChannel(&Channel{Balance: "10000", TotalClaimed: "0"})
	snapshot.OnchainSyncedAt = 900
	result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment:   big.NewInt(100),
		SignedCap:   big.NewInt(5000),
		Voucher:     batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"},
		Snapshot:    snapshot,
		LocalVerify: true,
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitCommitted || result.Current.Balance != "7777" || result.Current.TotalClaimed != "3" || result.Current.OnchainSyncedAt != 500 {
		t.Fatalf("result = %+v", result)
	}
}

func TestCommitVoucherCharge_OnchainSyncedAtMovesOnlyForward(t *testing.T) {
	cases := []struct {
		name         string
		snapshotAt   int64
		wantSyncedAt int64
	}{
		{name: "newer snapshot stamp replaces row stamp", snapshotAt: 2_000, wantSyncedAt: 2_000},
		{name: "zero snapshot stamp keeps row stamp", snapshotAt: 0, wantSyncedAt: 1_000},
		{name: "older snapshot stamp keeps row stamp", snapshotAt: 400, wantSyncedAt: 1_000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := NewInMemoryChannelStorage[*Channel]()
			if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel {
				seed := voucherBaseChannel(&Channel{Balance: "1"})
				seed.OnchainSyncedAt = 1_000
				return seed
			}); err != nil {
				t.Fatalf("seed: %v", err)
			}
			snapshot := voucherBaseChannel(&Channel{Balance: "4242"})
			snapshot.OnchainSyncedAt = tc.snapshotAt
			result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
				Increment: big.NewInt(100),
				SignedCap: big.NewInt(5000),
				Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"},
				Snapshot:  snapshot,
				Now:       9_999,
			})
			if err != nil {
				t.Fatalf("CommitVoucherCharge: %v", err)
			}
			if result.Status != CommitCommitted {
				t.Fatalf("status = %q", result.Status)
			}
			got, _ := store.Get(context.Background(), voucherChannelId)
			if got.OnchainSyncedAt != tc.wantSyncedAt || got.Balance != "4242" || got.LastRequestTimestamp != 9_999 {
				t.Fatalf("stored onchainSyncedAt=%d balance=%q lastRequestTimestamp=%d", got.OnchainSyncedAt, got.Balance, got.LastRequestTimestamp)
			}
		})
	}
}

func TestCommitVoucherCharge_RefreshesEscrowFromSnapshot(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel {
		return voucherBaseChannel(&Channel{Balance: "1", TotalClaimed: "9", RefundNonce: 1, WithdrawRequestedAt: 2})
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	result, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(1000),
		SignedCap: big.NewInt(5000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"},
		Snapshot:  voucherBaseChannel(&Channel{Balance: "10000", TotalClaimed: "0", RefundNonce: 0, WithdrawRequestedAt: 0}),
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if result.Status != CommitCommitted {
		t.Fatalf("status = %q", result.Status)
	}
	if result.Current.Balance != "10000" || result.Current.TotalClaimed != "9" || result.Current.ChargedCumulativeAmount != "3000" {
		t.Fatalf("current = %+v", result.Current)
	}
}

func TestCommitVoucherCharge_DoesNotLowerTotalClaimed(t *testing.T) {
	store := NewInMemoryChannelStorage[*Channel]()
	if _, err := store.UpdateChannel(context.Background(), voucherChannelId, func(*Channel) *Channel {
		return voucherBaseChannel(&Channel{Balance: "1", TotalClaimed: "50", RefundNonce: 1, WithdrawRequestedAt: 2})
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	lower, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(1),
		SignedCap: big.NewInt(5000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xbbb"},
		Snapshot:  voucherBaseChannel(&Channel{Balance: "10000", TotalClaimed: "10"}),
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if lower.Status != CommitCommitted || lower.Current.TotalClaimed != "50" || lower.Current.Balance != "10000" {
		t.Fatalf("lower snapshot = %+v", lower.Current)
	}
	higher, err := CommitVoucherCharge(context.Background(), store, voucherChannelId, CommitVoucherChargeInput[*Channel]{
		Increment: big.NewInt(1),
		SignedCap: big.NewInt(5000),
		Voucher:   batchsettlement.BatchSettlementVoucherFields{MaxClaimableAmount: "5000", Signature: "0xccc"},
		Snapshot:  voucherBaseChannel(&Channel{Balance: "10000", TotalClaimed: "80"}),
	})
	if err != nil {
		t.Fatalf("CommitVoucherCharge: %v", err)
	}
	if higher.Status != CommitCommitted || higher.Current.TotalClaimed != "80" {
		t.Fatalf("higher snapshot = %+v", higher.Current)
	}
}

func TestChannelStateExtra_OmitsChargedWhenMissing(t *testing.T) {
	extra := ChannelStateExtra(voucherBaseChannel(nil), nil)
	if extra.ChargedCumulativeAmount != "" {
		t.Fatalf("chargedCumulativeAmount = %q", extra.ChargedCumulativeAmount)
	}
}

func TestPaymentResponseExtra_IncludesChargeCountOnlyWhenSet(t *testing.T) {
	snapshot := ChannelStateExtra(voucherBaseChannel(nil), strPtr("2500"))
	channelOnly := PaymentResponseExtra(snapshot, nil, nil)
	if channelOnly.ChargedAmount != "" || channelOnly.ChargeCount != nil || channelOnly.ChannelState == nil {
		t.Fatalf("channelOnly = %+v", channelOnly)
	}
	count := 2
	charged := "500"
	paid := PaymentResponseExtra(snapshot, &charged, &count)
	if paid.ChargedAmount != "500" || paid.ChargeCount == nil || *paid.ChargeCount != 2 {
		t.Fatalf("paid = %+v", paid)
	}
	zero := 0
	refund := PaymentResponseExtra(snapshot, nil, &zero)
	if refund.ChargedAmount != "" || refund.ChargeCount == nil || *refund.ChargeCount != 0 {
		t.Fatalf("refund = %+v", refund)
	}
}

func strPtr(s string) *string { return &s }
