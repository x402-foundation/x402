package facilitator

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

func managerChannel(t *testing.T, auth *fakeAuthorizerSigner, saltSuffix string, overrides *channelFields) *FacilitatorChannel {
	t.Helper()
	cfg := managedConfig(auth.addr, saltSuffix)
	id := mustChannelId(t, cfg)
	ch := storedManagedChannel(cfg, id, overrides)
	if ch.ChargedCumulativeAmount == "1000" && (overrides == nil || overrides.ChargedCumulativeAmount == "") {
		ch.ChargedCumulativeAmount = "1000"
	}
	if overrides == nil {
		ch.ChargedCumulativeAmount = "1000"
		ch.SignedMaxClaimable = "1000"
		ch.ChargeCount = 2
	}
	return ch
}

func refundIdle(mgr *FacilitatorChannelManager) ([]FacilitatorRefundResult, error) {
	return mgr.RefundIdleChannels(context.Background(), FacilitatorRefundOptions{IdleSecs: 60})
}

func seedManagerSettleTarget(t *testing.T, mgr *FacilitatorChannelManager, ch *FacilitatorChannel) {
	t.Helper()
	if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: ch.ChannelConfig.Receiver,
		Token:    ch.ChannelConfig.Token,
		Amount:   bigInt(1),
	}); err != nil {
		t.Fatal(err)
	}
}

func seedSettleReceivers(t *testing.T, mgr *FacilitatorChannelManager, n int) {
	t.Helper()
	mgr.settleTargetStorage = storage.NewInMemorySettleTargetStorage()
	for i := 0; i < n; i++ {
		if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
			Network:  managedNetwork,
			Receiver: fmt.Sprintf("0x%040x", i+1),
			Token:    managedToken,
			Amount:   bigInt(1),
		}); err != nil {
			t.Fatal(err)
		}
	}
}

type settleRPCEvent struct {
	kind      string
	receivers []string
}

func watchSettleRPC(t *testing.T, signer *fakeFacilitatorSigner) *[]settleRPCEvent {
	t.Helper()
	events := &[]settleRPCEvent{}
	innerRead := signer.readContract
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			if calls, ok := multicallArgCalls(args); ok && calls.Len() > 0 && bytes.Equal(multicallSelector(calls.Index(0)), receiversSelector()) {
				*events = append(*events, settleRPCEvent{kind: "read", receivers: receiversFromAggregate(calls)})
			}
		}
		return innerRead(functionName, args...)
	}
	innerWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		if functionName == "multicall" {
			*events = append(*events, settleRPCEvent{kind: "write", receivers: receiversFromSettleCalls(t, args)})
		}
		return innerWrite(functionName, args...)
	}
	return events
}

func receiversFromAggregate(calls reflect.Value) []string {
	out := make([]string, 0, calls.Len())
	for i := 0; i < calls.Len(); i++ {
		receiver, ok := receiverForCall(calls.Index(i))
		if !ok {
			continue
		}
		out = append(out, receiver)
	}
	return out
}

func receiversFromSettleCalls(t *testing.T, args []interface{}) []string {
	t.Helper()
	if len(args) == 0 {
		t.Fatal("missing settle calls")
	}
	calls, ok := args[0].([][]byte)
	if !ok {
		t.Fatalf("settle calls type %T", args[0])
	}
	sel := mustMethodID(batchsettlement.BatchSettlementSettleABI, "settle")
	out := make([]string, 0, len(calls))
	for _, call := range calls {
		if len(call) < 36 || !bytes.Equal(call[:4], sel) {
			t.Fatalf("settle calldata %x", call)
		}
		out = append(out, strings.ToLower(common.BytesToAddress(call[4:36]).Hex()))
	}
	return out
}

func assertSettleWriteMatchesPreviousRead(t *testing.T, events []settleRPCEvent) {
	t.Helper()
	writes := 0
	for i, ev := range events {
		if ev.kind != "write" {
			continue
		}
		writes++
		if i == 0 || events[i-1].kind != "read" || !reflect.DeepEqual(events[i-1].receivers, ev.receivers) {
			t.Fatalf("write %v is not the previous read in %+v", ev.receivers, events)
		}
	}
	if writes == 0 {
		t.Fatal("no settle tx")
	}
}

func containsString(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func newTestManager(t *testing.T, signer evm.FacilitatorEvmSigner, store storage.ChannelStorage[*FacilitatorChannel], auth *fakeAuthorizerSigner, keepFinishedRows bool, fctx *x402.FacilitatorContext) *FacilitatorChannelManager {
	t.Helper()
	if auth == nil {
		auth = managedAuthorizer()
	}
	if signer == nil {
		signer = newManagedSigner(t, nil)
	}
	if store == nil {
		store = storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	}
	if fctx == nil {
		// Charge counts only reach the chain through the registered builder-code extension. The
		// stub adds no suffix bytes but records the metadata it was asked to encode.
		fctx = builderContext(nil)
	}
	mgr, err := NewFacilitatorChannelManager(FacilitatorChannelManagerConfig{
		Storage:          store,
		Signer:           signer,
		AuthorizerSigner: auth,
		KeepFinishedRows: keepFinishedRows,
		Context:          fctx,
	})
	if err != nil {
		t.Fatal(err)
	}
	return mgr
}

func TestFacilitatorChannelManager_ClaimEmpty(t *testing.T) {
	mgr := newTestManager(t, newManagedSigner(t, nil), nil, nil, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %d", len(results))
	}
}

func TestFacilitatorChannelManager_ClaimAppliesTotals(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)

	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "1000" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
	if got.ChargeCount != 0 {
		t.Fatalf("chargeCount = %d", got.ChargeCount)
	}
}

func TestFacilitatorChannelManager_ClaimAppendsBuilderSuffix(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	suffix := []byte{0x80, 0x21, 0xab, 0xcd}
	mgr := newTestManager(t, signer, store, auth, false, builderContext(suffix))

	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(signer.lastDataSuffix, suffix) {
		t.Fatalf("suffix = %x, want %x", signer.lastDataSuffix, suffix)
	}
	counts := managerChargeCounts(t, mgr)
	if len(counts) != 1 || counts[0] != 2 {
		t.Fatalf("counts = %v", counts)
	}
}

// managerChargeCounts returns the charge counts the manager last asked the builder-code
// extension to encode into ERC-8021 `m`.
func managerChargeCounts(t *testing.T, mgr *FacilitatorChannelManager) []uint64 {
	t.Helper()
	return contextStub(t, mgr.context).chargeCounts()
}

func TestFacilitatorChannelManager_ClaimPreservesInFlightChargeCount(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             3,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	origWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		if _, err := store.UpdateChannel(context.Background(), ch.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
			if current == nil {
				return current
			}
			next := current.Clone()
			next.ChargeCount = current.ChargeCount + 2
			return next
		}); err != nil {
			t.Fatal(err)
		}
		if origWrite != nil {
			return origWrite(functionName, args...)
		}
		return successTxHash, nil
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 2 {
		t.Fatalf("chargeCount = %d, want 2", got.ChargeCount)
	}
	counts := managerChargeCounts(t, mgr)
	if len(counts) != 1 || counts[0] != 3 {
		t.Fatalf("attested counts = %v", counts)
	}
}

func TestFacilitatorChannelManager_ClaimBatches(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	for _, suffix := range []string{"01", "02", "03"} {
		ch := managerChannel(t, auth, suffix, &channelFields{
			ChargedCumulativeAmount: "1000",
			SignedMaxClaimable:      "1000",
			ChargeCount:             1,
		})
		seedManagedChannel(t, store, ch)
	}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	// Claim is capacity-capped per run: Limit == MaxClaimsPerBatch so the
	// worker query early-stops. With 3 claimable and Max=2 the first run
	// claims 2 in one batch; the remainder is picked up on the next run.
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{MaxClaimsPerBatch: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("batches = %d, want 1 (capacity-capped)", len(results))
	}
	if results[0].Vouchers != 2 {
		t.Fatalf("vouchers = %d, want 2", results[0].Vouchers)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d, want 1", signer.writeCalls)
	}
	results, err = mgr.Claim(context.Background(), &FacilitatorClaimOptions{MaxClaimsPerBatch: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("second run results = %+v, want 1 batch of 1", results)
	}
}

func TestFacilitatorChannelManager_ClaimSkipsNonIdle(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, false, nil)
	idle := 3600
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{IdleSecs: &idle})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_ClaimUsesQuery(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	skipped := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	selected := managerChannel(t, auth, "02", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	seedManagedChannel(t, inner, skipped)
	seedManagedChannel(t, inner, selected)
	store := &hookStore{inner: inner, useQuery: true, queryItems: []*FacilitatorChannel{selected}}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)

	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if store.queryCalls == 0 {
		t.Fatal("expected Query")
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
}

func TestFacilitatorChannelManager_ClaimSimulationFailureLeavesStore(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		ChargeCount:             3,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{simFail: "claimWithSignature"})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("results = %+v", results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 3 || got.TotalClaimed != "0" || got.PendingClaim != nil {
		t.Fatalf("store mutated: %+v", got)
	}
}

func TestFacilitatorChannelManager_ClaimContinuesAfterBatchFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channels := make([]*FacilitatorChannel, 0, 2)
	for _, suffix := range []string{"01", "02"} {
		ch := managerChannel(t, auth, suffix, &channelFields{
			ChargedCumulativeAmount: "1000",
			SignedMaxClaimable:      "1000",
			ChargeCount:             1,
		})
		seedManagedChannel(t, store, ch)
		channels = append(channels, ch)
	}
	signer := newManagedSigner(t, nil)
	innerRead := signer.readContract
	claimSims := 0
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == "claimWithSignature" {
			claimSims++
			if claimSims == 1 {
				return nil, fmt.Errorf("execution reverted")
			}
		}
		return innerRead(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v, want the successful batch", results)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d, want 1", signer.writeCalls)
	}
	claimed := 0
	untouched := 0
	for _, ch := range channels {
		got, getErr := store.Get(context.Background(), ch.ChannelId)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if got.TotalClaimed == "1000" {
			claimed++
		} else if got.TotalClaimed == "0" && got.ChargeCount == 1 {
			untouched++
		} else {
			t.Fatalf("channel %s totalClaimed=%s chargeCount=%d", ch.ChannelId, got.TotalClaimed, got.ChargeCount)
		}
	}
	if claimed != 1 || untouched != 1 {
		t.Fatalf("claimed=%d untouched=%d", claimed, untouched)
	}
}

func TestFacilitatorChannelManager_SettleSimulationFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{simFail: "multicall", receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedManagerSettleTarget(t, mgr, ch)
	var reported []string
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		OnError: func(err error, target *storage.SettleTarget) {
			if target != nil {
				reported = append(reported, target.Receiver)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("results = %+v", results)
	}
	if len(reported) != 1 {
		t.Fatalf("reported = %v", reported)
	}
}

func TestFacilitatorChannelManager_ClaimAndSettleEmpty(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, false, nil)
	claims, settle, err := mgr.ClaimAndSettle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 0 || len(settle) != 0 {
		t.Fatalf("claims=%v settle=%v", claims, settle)
	}
}

func TestFacilitatorChannelManager_SettleAlreadySettledDoesNotThrow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(5000)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedManagerSettleTarget(t, mgr, ch)
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_SettleAppendsBuilderSuffix(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	suffix := []byte{0x80, 0x21, 0xaa, 0xbb}
	mgr := newTestManager(t, signer, store, auth, false, builderContext(suffix))
	seedManagerSettleTarget(t, mgr, ch)
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if !bytes.Equal(signer.lastDataSuffix, suffix) {
		t.Fatalf("suffix = %x", signer.lastDataSuffix)
	}
}

func TestFacilitatorChannelManager_SettleUsesSettleQuery(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000"})
	seedManagedChannel(t, inner, ch)
	targets := &recordingSettleTargets{}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, inner, auth, false, nil)
	mgr.settleTargetStorage = targets
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if targets.calls == 0 {
		t.Fatal("expected SettleQuery")
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%v writes=%d", results, signer.writeCalls)
	}
}

func TestFacilitatorChannelManager_RefundRemainingEscrow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "10000",
		ChargeCount:             0,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, false, nil)
	results, err := refundIdle(mgr)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !strings.EqualFold(results[0].Channel, ch.ChannelId) {
		t.Fatalf("results = %+v", results)
	}
}

func TestFacilitatorChannelManager_RefundSkipsLiveLock(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		Balance:                 "10000",
		ChargeCount:             0,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	ok, err := store.Acquire(context.Background(), ch.ChannelId, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire: %v %v", ok, err)
	}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := refundIdle(mgr)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	held, err := store.IsHeld(context.Background(), ch.ChannelId, "pending")
	if err != nil || !held {
		t.Fatalf("original holder should remain: held=%v err=%v", held, err)
	}
}

func TestFacilitatorChannelManager_RefundReleasesLockOnSuccess(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "03", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "10000",
		ChargeCount:             0,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	heldDuring := false
	origWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		held, err := store.IsHeld(context.Background(), ch.ChannelId, "")
		if err != nil {
			t.Errorf("IsHeld during refund: %v", err)
		}
		heldDuring = held
		return origWrite(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, true, nil)
	results, err := refundIdle(mgr)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !heldDuring {
		t.Fatalf("results=%+v heldDuring=%v", results, heldDuring)
	}
	held, err := store.IsHeld(context.Background(), ch.ChannelId, "")
	if err != nil || held {
		t.Fatalf("lock should be released: held=%v err=%v", held, err)
	}
}

func TestFacilitatorChannelManager_RefundReleasesLockOnFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "04", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "10000",
		ChargeCount:             0,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	heldDuring := false
	signer.writeContract = func(string, ...interface{}) (string, error) {
		held, err := store.IsHeld(context.Background(), ch.ChannelId, "")
		if err != nil {
			t.Errorf("IsHeld during refund: %v", err)
		}
		heldDuring = held
		return "", errors.New("rpc down")
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := refundIdle(mgr)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || !heldDuring {
		t.Fatalf("results=%+v heldDuring=%v", results, heldDuring)
	}
	held, err := store.IsHeld(context.Background(), ch.ChannelId, "")
	if err != nil || held {
		t.Fatalf("lock should be released: held=%v err=%v", held, err)
	}
	got, err := store.Get(context.Background(), ch.ChannelId)
	if err != nil || got == nil || got.Balance != "10000" {
		t.Fatalf("row should be unchanged: %+v %v", got, err)
	}
}

func TestFacilitatorChannelManager_RefundSkipsRowDrainedBeforeLock(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "05", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "10000",
		ChargeCount:             0,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	locks := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	hook := acquireHookLock{
		ChannelLockStorage: locks,
		before: func() {
			_, err := store.UpdateChannel(context.Background(), ch.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
				if current == nil {
					return current
				}
				next := current.Clone()
				next.Balance = "0"
				return next
			})
			if err != nil {
				t.Errorf("drain row: %v", err)
			}
		},
	}
	signer := newManagedSigner(t, nil)
	mgr, err := NewFacilitatorChannelManager(FacilitatorChannelManagerConfig{
		Storage:          store,
		LockStorage:      hook,
		Signer:           signer,
		AuthorizerSigner: auth,
	})
	if err != nil {
		t.Fatal(err)
	}
	results, err := refundIdle(mgr)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	held, err := locks.IsHeld(context.Background(), ch.ChannelId, "")
	if err != nil || held {
		t.Fatalf("lock should be released: held=%v err=%v", held, err)
	}
}

type acquireHookLock struct {
	storage.ChannelLockStorage
	before func()
}

func (l acquireHookLock) Acquire(ctx context.Context, channelId, pendingId string, ttlMs int64) (bool, error) {
	if l.before != nil {
		l.before()
	}
	return l.ChannelLockStorage.Acquire(ctx, channelId, pendingId, ttlMs)
}

func TestFacilitatorChannelManager_RefundClaimsThenRefunds(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		TotalClaimed:            "0",
		ChargeCount:             2,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := refundIdle(mgr)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeCalls == 0 {
		t.Fatal("expected write")
	}
}

func TestFacilitatorChannelManager_RefundIdleIgnoresZeroBalance(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		Balance:                 "0",
		ChargedCumulativeAmount: "1000",
		TotalClaimed:            "1000",
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, false, nil)
	results, err := mgr.RefundIdleChannels(context.Background(), FacilitatorRefundOptions{IdleSecs: 60})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_KeepFinishedRows(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, true, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got == nil {
		t.Fatal("expected retained closed row")
	}
}

func TestFacilitatorChannelManager_ClaimOnlyWhenFullyEarmarked(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "10000",
		SignedMaxClaimable:      "10000",
		Balance:                 "10000",
		TotalClaimed:            "0",
		ChargeCount:             1,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := refundIdle(mgr)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if got := signer.writeFns; len(got) == 0 || (got[0] != "claimWithSignature" && got[0] != "claim") {
		t.Fatalf("writeFns = %v", got)
	}
}

func TestFacilitatorChannelManager_RefundIdleRespectsIdleWindow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		Balance:                 "10000",
		ChargedCumulativeAmount: "0",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		ChargeCount:             0,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, false, nil)
	results, err := mgr.RefundIdleChannels(context.Background(), FacilitatorRefundOptions{IdleSecs: 3600})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_StartStopDoesNotDoubleStart(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, false, nil)
	interval := 5
	mgr.Start(FacilitatorAutoConfig{ClaimIntervalSecs: &interval})
	mgr.Start(FacilitatorAutoConfig{ClaimIntervalSecs: &interval})
	if len(mgr.timers) != 1 {
		t.Fatalf("timers = %d", len(mgr.timers))
	}
	if err := mgr.Stop(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(mgr.timers) != 0 {
		t.Fatalf("timers after stop = %d", len(mgr.timers))
	}
}

func TestFacilitatorChannelManager_StopDoesNotEnqueue(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, false, nil)
	var called atomic.Int32
	interval := 1
	mgr.Start(FacilitatorAutoConfig{
		ClaimIntervalSecs: &interval,
		OnClaim:           func(FacilitatorClaimResult) { called.Add(1) },
	})
	if err := mgr.Stop(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond)
	if got := called.Load(); got != 0 {
		t.Fatalf("onClaim = %d", got)
	}
}

func TestFacilitatorChannelManager_AutoClaimError(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{readFail: true})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	saw := make(chan error, 1)
	interval := 1
	mgr.Start(FacilitatorAutoConfig{
		ClaimIntervalSecs: &interval,
		OnError: func(err error) {
			select {
			case saw <- err:
			default:
			}
		},
	})
	select {
	case <-saw:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for claim error")
	}
	_ = mgr.Stop(context.Background(), false)
}

func TestFacilitatorChannelManager_FlushOnStop(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(1000)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	interval := 60
	mgr.Start(FacilitatorAutoConfig{ClaimIntervalSecs: &interval, SettleIntervalSecs: &interval})
	if err := mgr.Stop(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got != nil && got.TotalClaimed != "1000" {
		t.Fatalf("expected claimed, got %+v", got)
	}
}

func TestFacilitatorChannelManager_PendingSettleSkipped(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		TotalClaimed:            "5000",
		ChargedCumulativeAmount: "5000",
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(5000)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	var settled atomic.Int32
	var errored atomic.Int32
	interval := 1
	mgr.Start(FacilitatorAutoConfig{
		SettleIntervalSecs: &interval,
		OnSettle:           func(FacilitatorSettleResult) { settled.Add(1) },
		OnError:            func(error) { errored.Add(1) },
	})
	time.Sleep(1500 * time.Millisecond)
	_ = mgr.Stop(context.Background(), false)
	if settled.Load() != 0 || errored.Load() != 0 || signer.writeCalls != 0 {
		t.Fatalf("settle=%d err=%d writes=%d", settled.Load(), errored.Load(), signer.writeCalls)
	}
}

func TestFacilitatorChannelManager_ClaimGateLeavesQueryMinUnset(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	seedManagedChannel(t, inner, ch)
	store := &hookStore{inner: inner, useQuery: true, queryItems: []*FacilitatorChannel{ch}}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)

	if _, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		MinUnclaimed:  TokenAmountGate{DefaultAssetAmount: "$0.001"},
		UnclaimedDesc: true,
	}); err != nil {
		t.Fatal(err)
	}
	if store.queryFilter.MinUnclaimed != nil {
		t.Fatalf("MinUnclaimed = %q, want nil", *store.queryFilter.MinUnclaimed)
	}
	if !store.queryFilter.UnclaimedDesc {
		t.Fatal("UnclaimedDesc not passed through")
	}
}

type claimQueryRecorder struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	calls   int
	filters []storage.ChannelQuery
}

func (s *claimQueryRecorder) Query(ctx context.Context, filter storage.ChannelQuery, opts *storage.ChannelStoreOptions) (*storage.QueryPage[*FacilitatorChannel], error) {
	s.calls++
	s.filters = append(s.filters, filter)
	return storage.QueryByScan[*FacilitatorChannel](ctx, s, filter)
}

func TestFacilitatorChannelManager_SelectClaimRowsHonored(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	first := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		ChargeCount:             1,
	})
	second := managerChannel(t, auth, "02", &channelFields{
		ChargedCumulativeAmount: "9000",
		SignedMaxClaimable:      "9000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, inner, first)
	seedManagedChannel(t, inner, second)
	store := &claimQueryRecorder{InMemoryChannelStorage: inner}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	_, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      2,
		MinUnclaimed: TokenAmountGate{Assets: []TokenAtomicAmount{{
			Network: managedNetwork,
			Asset:   managedToken,
			Amount:  "999999999",
		}}},
		SelectClaimRows: func(ctx context.Context, query func(storage.ChannelQuery) ([]*FacilitatorChannel, error), capacity int) ([]*FacilitatorChannel, error) {
			if capacity != 2 {
				t.Fatalf("capacity = %d, want 2", capacity)
			}
			rows, err := query(storage.ChannelQuery{OldestFirst: true, Limit: intPtr(capacity)})
			if err != nil {
				return nil, err
			}
			for _, row := range rows {
				if strings.EqualFold(row.ChannelId, second.ChannelId) {
					return []*FacilitatorChannel{row}, nil
				}
			}
			t.Fatal("selector did not see the second channel")
			return nil, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(store.filters) != 1 || !store.filters[0].OldestFirst {
		t.Fatalf("filters = %+v", store.filters)
	}
	gotFirst, err := inner.Get(context.Background(), first.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	gotSecond, err := inner.Get(context.Background(), second.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if gotFirst.TotalClaimed != "0" || gotSecond.TotalClaimed != "9000" {
		t.Fatalf("first=%s second=%s", gotFirst.TotalClaimed, gotSecond.TotalClaimed)
	}
}

func TestClaimRowQuery_UsesMinUnclaimedFromTheQuery(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &claimQueryRecorder{InMemoryChannelStorage: inner}
	mgr := newTestManager(t, nil, store, nil, false, nil)
	idle := 3600
	minUnclaimed := "1000"
	_, err := mgr.loadClaimRows(context.Background(), &FacilitatorClaimOptions{
		IdleSecs:          &idle,
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      1,
		SelectClaimRows: func(_ context.Context, query func(storage.ChannelQuery) ([]*FacilitatorChannel, error), _ int) ([]*FacilitatorChannel, error) {
			if _, err := query(storage.ChannelQuery{OldestFirst: true, Limit: intPtr(1)}); err != nil {
				return nil, err
			}
			return query(storage.ChannelQuery{UnclaimedDesc: true, MinUnclaimed: &minUnclaimed, Limit: intPtr(1)})
		},
	}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(store.filters) != 2 {
		t.Fatalf("filters = %d", len(store.filters))
	}
	if store.filters[0].MinUnclaimed != nil || store.filters[0].IdleAtOrBefore == nil || !store.filters[0].OldestFirst {
		t.Fatalf("idle probe = %+v", store.filters[0])
	}
	if store.filters[1].MinUnclaimed == nil || *store.filters[1].MinUnclaimed != minUnclaimed || !store.filters[1].UnclaimedDesc {
		t.Fatalf("amount query = %+v", store.filters[1])
	}
}

func TestFacilitatorChannelManager_ClaimPassesMaxTxsPerRunLimit(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, useQuery: true}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)

	if _, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{MaxClaimsPerBatch: 2, MaxTxsPerRun: 3}); err != nil {
		t.Fatal(err)
	}
	if store.queryFilter.Limit == nil || *store.queryFilter.Limit != 6 {
		t.Fatalf("Limit = %v, want 6", store.queryFilter.Limit)
	}
}

func TestFacilitatorChannelManager_SettleMulticall(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: ch.ChannelConfig.Receiver,
		Token:    ch.ChannelConfig.Token,
		Amount:   bigInt(2),
	}); err != nil {
		t.Fatal(err)
	}
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MinPending:      TokenAmountGate{DefaultAssetAmount: "$0.001"},
		MaxSettlesPerTx: 10,
		MaxTxsPerRun:    1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeFns[len(signer.writeFns)-1] != "multicall" {
		t.Fatalf("writeFns = %v, want multicall", signer.writeFns)
	}
}

func TestFacilitatorChannelManager_SettleAmountGate(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	usdcReceiver := "0x1111111111111111111111111111111111111111"
	otherReceiver := "0x2222222222222222222222222222222222222222"
	zeroReceiver := "0x3333333333333333333333333333333333333333"
	otherToken := "0x0000000000000000000000000000000000000001"
	signer := newManagedSigner(t, &managedRPC{
		receiverClaimed: big.NewInt(1_000_000),
		receiverSettled: big.NewInt(1_000_000),
		receiverSettledByAddr: map[string]*big.Int{
			usdcReceiver:  big.NewInt(0),
			otherReceiver: big.NewInt(999_999),
		},
	})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	mgr.settleTargetStorage = storage.NewInMemorySettleTargetStorage()
	for _, pair := range []struct{ receiver, token string }{
		{usdcReceiver, managedToken},
		{otherReceiver, otherToken},
		{zeroReceiver, managedToken},
	} {
		if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
			Network:  managedNetwork,
			Receiver: pair.receiver,
			Token:    pair.token,
			Amount:   bigInt(1),
		}); err != nil {
			t.Fatal(err)
		}
	}
	// RecordClaimed stamps updatedAt. A read in the same millisecond keeps the row.
	time.Sleep(2 * time.Millisecond)

	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MinPending: TokenAmountGate{DefaultAssetAmount: "$1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || signer.writeCalls != 1 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	if !strings.EqualFold(results[0].Receiver, otherReceiver) || !strings.EqualFold(results[0].Token, otherToken) {
		t.Fatalf("settled %+v, want ungated token", results[0])
	}
	page, err := mgr.settleTargetStorage.ListSettleTargets(context.Background(), storage.SettleQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if page == nil || len(page.Items) != 2 {
		t.Fatalf("remaining = %+v", page)
	}
	for _, item := range page.Items {
		if strings.EqualFold(item.Receiver, zeroReceiver) {
			t.Fatal("zero pending was not cleaned up")
		}
	}
}

func TestFacilitatorChannelManager_SettleRejectsDollarAssetAmount(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	mgr.settleTargetStorage = storage.NewInMemorySettleTargetStorage()
	if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
		Network:  managedNetwork,
		Receiver: managedReceiver,
		Token:    managedToken,
		Amount:   bigInt(1),
	}); err != nil {
		t.Fatal(err)
	}
	_, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MinPending: TokenAmountGate{Assets: []TokenAtomicAmount{{
			Network: managedNetwork,
			Asset:   managedToken,
			Amount:  "$1",
		}}},
	})
	if err == nil || !strings.Contains(err.Error(), "dollar") {
		t.Fatalf("err = %v", err)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
}

func TestFacilitatorChannelManager_ClaimAmountGate(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	dust := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "999",
		SignedMaxClaimable:      "999",
		ChargeCount:             1,
	})
	atThreshold := managerChannel(t, auth, "02", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	cfg := managedConfig(auth.addr, "03")
	cfg.Token = "0x0000000000000000000000000000000000000001"
	ungated := storedManagedChannel(cfg, mustChannelId(t, cfg), &channelFields{
		ChargedCumulativeAmount: "1",
		SignedMaxClaimable:      "1",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, dust)
	seedManagedChannel(t, store, atThreshold)
	seedManagedChannel(t, store, ungated)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)

	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		MinUnclaimed: TokenAmountGate{DefaultAssetAmount: "$0.001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 2 {
		t.Fatalf("results = %+v", results)
	}
	gotDust, _ := store.Get(context.Background(), dust.ChannelId)
	gotAt, _ := store.Get(context.Background(), atThreshold.ChannelId)
	gotUngated, _ := store.Get(context.Background(), ungated.ChannelId)
	if gotDust.TotalClaimed != "0" || gotAt.TotalClaimed != "1000" || gotUngated.TotalClaimed != "1" {
		t.Fatalf("dust=%s at=%s ungated=%s", gotDust.TotalClaimed, gotAt.TotalClaimed, gotUngated.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_SettleDropsFailedReceiverReads(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	good := finishedManagedChannel(t, auth, "61")
	bad := finishedManagedChannel(t, auth, "62")
	bad.ChannelConfig.Receiver = "0x1111111111111111111111111111111111111111"
	seedManagedChannel(t, store, good)
	seedManagedChannel(t, store, bad)
	signer := newManagedSigner(t, &managedRPC{
		receiverClaimed: bigInt(1000),
		receiverSettled: bigInt(1000),
		failReceivers: map[string]struct{}{
			strings.ToLower(bad.ChannelConfig.Receiver): {},
		},
	})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedManagerSettleTarget(t, mgr, good)
	seedManagerSettleTarget(t, mgr, bad)
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	if got, _ := store.Get(context.Background(), good.ChannelId); got != nil {
		t.Fatal("expected good receiver to be cleaned up")
	}
	if got, _ := store.Get(context.Background(), bad.ChannelId); got == nil {
		t.Fatal("expected failed receiver read to keep the row")
	}
}

func TestFacilitatorChannelManager_SettleRetriesReceiverMulticall(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "71", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			if attempts < multicallAttempts {
				return nil, fmt.Errorf("rpc down")
			}
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedManagerSettleTarget(t, mgr, ch)
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if attempts != multicallAttempts+1 || len(results) != 1 {
		t.Fatalf("attempts=%d results=%+v", attempts, results)
	}
}

func TestFacilitatorChannelManager_SettleReceiverReadGivesUpAfterRetries(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "72", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			return nil, fmt.Errorf("rpc down")
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedManagerSettleTarget(t, mgr, ch)
	_, err := mgr.Settle(context.Background(), nil)
	if err == nil {
		t.Fatal("expected receiver read failure")
	}
	if attempts != multicallAttempts || signer.writeCalls != 0 {
		t.Fatalf("attempts=%d writes=%d", attempts, signer.writeCalls)
	}
	if got, _ := store.Get(context.Background(), ch.ChannelId); got == nil {
		t.Fatal("expected the row to remain")
	}
}

func TestFacilitatorChannelManager_SettleChunksReceiverReads(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedSettleReceivers(t, mgr, 5)
	events := watchSettleRPC(t, signer)
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MaxSettlesPerTx: 2,
		MaxTxsPerRun:    3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 5 || signer.writeCalls != 3 {
		t.Fatalf("results=%d writes=%d", len(results), signer.writeCalls)
	}
	assertSettleWriteMatchesPreviousRead(t, *events)
	var sizes []int
	for _, ev := range *events {
		if ev.kind == "read" {
			sizes = append(sizes, len(ev.receivers))
		}
	}
	want := []int{2, 2, 2, 2, 1, 1}
	if !reflect.DeepEqual(sizes, want) {
		t.Fatalf("receiver reads = %v, want %v", sizes, want)
	}
}

func TestFacilitatorChannelManager_SettleReadDoesNotBorrowNextBatch(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	settled := fmt.Sprintf("0x%040x", 2)
	signer := newManagedSigner(t, &managedRPC{
		receiverClaimed: bigInt(5000),
		receiverSettled: bigInt(0),
		receiverSettledByAddr: map[string]*big.Int{
			settled: bigInt(5000),
		},
	})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedSettleReceivers(t, mgr, 4)
	events := watchSettleRPC(t, signer)
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MaxSettlesPerTx: 2,
		MaxTxsPerRun:    2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 || signer.writeCalls != 2 {
		t.Fatalf("results=%d writes=%d", len(results), signer.writeCalls)
	}
	var writes [][]string
	for i, ev := range *events {
		if ev.kind != "write" {
			continue
		}
		if i == 0 || (*events)[i-1].kind != "read" {
			t.Fatalf("write without a preceding read: %v", *events)
		}
		prev := (*events)[i-1].receivers
		for _, receiver := range ev.receivers {
			if !containsString(prev, receiver) {
				t.Fatalf("tx receiver %s was not in the preceding read %v", receiver, prev)
			}
		}
		writes = append(writes, ev.receivers)
	}
	if len(writes) != 2 || len(writes[0]) != 1 || len(writes[1]) != 2 {
		t.Fatalf("writes = %v", writes)
	}
	if containsString(writes[0], settled) || containsString(writes[1], settled) {
		t.Fatalf("settled receiver was submitted: %v", writes)
	}
	if containsString(writes[0], writes[1][0]) || containsString(writes[0], writes[1][1]) {
		t.Fatalf("tx borrowed the next batch: %v", writes)
	}
}

func TestFacilitatorChannelManager_SettleContinuesAfterReceiverChunkFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedSettleReceivers(t, mgr, 3)
	inner := signer.readContract
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			if calls, ok := multicallArgCalls(args); ok && calls.Len() > 1 {
				return nil, fmt.Errorf("rpc down")
			}
		}
		return inner(functionName, args...)
	}
	var reported int
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MaxSettlesPerTx: 2,
		MaxTxsPerRun:    2,
		OnError: func(err error, target *storage.SettleTarget) {
			if err == nil || target != nil {
				t.Fatalf("err=%v target=%v", err, target)
			}
			reported++
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || signer.writeCalls != 1 || reported != 1 {
		t.Fatalf("results=%d writes=%d reported=%d", len(results), signer.writeCalls, reported)
	}
}

func TestFacilitatorChannelManager_SettleReceiverReadFailureReturnsWhenEveryChunkFails(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	seedSettleReceivers(t, mgr, 3)
	inner := signer.readContract
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			return nil, fmt.Errorf("rpc down")
		}
		return inner(functionName, args...)
	}
	var reported int
	_, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MaxSettlesPerTx: 2,
		MaxTxsPerRun:    2,
		OnError: func(error, *storage.SettleTarget) {
			reported++
		},
	})
	if err == nil {
		t.Fatal("expected receiver read failure")
	}
	if signer.writeCalls != 0 || reported != 0 {
		t.Fatalf("writes=%d reported=%d", signer.writeCalls, reported)
	}
}

func TestFacilitatorChannelManager_ClaimDefaultOptionsUnchanged(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	seedManagedChannel(t, inner, ch)
	store := &hookStore{inner: inner, useQuery: true, queryItems: []*FacilitatorChannel{ch}}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)

	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if store.queryFilter.MinUnclaimed != nil {
		t.Fatalf("MinUnclaimed = %q, want nil", *store.queryFilter.MinUnclaimed)
	}
	if store.queryFilter.UnclaimedDesc {
		t.Fatal("UnclaimedDesc should default to false")
	}
	if store.queryFilter.IdleAtOrBefore != nil {
		t.Fatal("IdleAtOrBefore should default to nil")
	}
}

func TestFacilitatorChannelManager_ClaimSubmitsActiveAndIdleRows(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	recent := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		ChargeCount:             1,
	})
	idle := managerChannel(t, auth, "02", &channelFields{
		ChargedCumulativeAmount: "100",
		SignedMaxClaimable:      "100",
		LastRequestTimestamp:    time.Now().UnixMilli() - 48*60*60*1000,
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, recent)
	seedManagedChannel(t, store, idle)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	idleSecs := 86400
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		IdleSecs:     &idleSecs,
		MinUnclaimed: TokenAmountGate{DefaultAssetAmount: "$0.001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 2 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
	gotRecent, _ := store.Get(context.Background(), recent.ChannelId)
	gotIdle, _ := store.Get(context.Background(), idle.ChannelId)
	if gotRecent.TotalClaimed != "5000" || gotIdle.TotalClaimed != "100" {
		t.Fatalf("recent=%s idle=%s", gotRecent.TotalClaimed, gotIdle.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimSubmitsRecentWithdrawPendingBelowThreshold(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "03", &channelFields{
		ChargedCumulativeAmount: "100",
		SignedMaxClaimable:      "100",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		WithdrawRequestedAt:     10,
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	idleSecs := 86400
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		IdleSecs:     &idleSecs,
		MinUnclaimed: TokenAmountGate{DefaultAssetAmount: "$0.001"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "100" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimBisectsSimulationFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	good := managerChannel(t, auth, "11", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	bad := managerChannel(t, auth, "12", &channelFields{
		ChargedCumulativeAmount: "7777",
		SignedMaxClaimable:      "7777",
		ChargeCount:             4,
	})
	seedManagedChannel(t, store, good)
	seedManagedChannel(t, store, bad)
	rpc := &managedRPC{resyncView: &managedChainView{
		Balance:      big.NewInt(50),
		TotalClaimed: big.NewInt(50),
		WithdrawAt:   42,
	}}
	signer := newManagedSigner(t, rpc)
	innerRead := signer.readContract
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == "claimWithSignature" && claimBatchContains(args, "7777") {
			return nil, fmt.Errorf("execution reverted: ClaimExceedsBalance")
		}
		return innerRead(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	gotGood, _ := store.Get(context.Background(), good.ChannelId)
	gotBad, _ := store.Get(context.Background(), bad.ChannelId)
	if gotGood.TotalClaimed != "1000" || gotGood.ChargeCount != 0 {
		t.Fatalf("good = total %s count %d", gotGood.TotalClaimed, gotGood.ChargeCount)
	}
	if gotBad.TotalClaimed != "50" || gotBad.Balance != "50" || gotBad.WithdrawRequestedAt != 42 || gotBad.ChargeCount != 4 {
		t.Fatalf("bad = %+v", gotBad.Channel)
	}
}

func TestFacilitatorChannelManager_ClaimDropsFailedPreflightReads(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	good := managerChannel(t, auth, "61", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	bad := managerChannel(t, auth, "62", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             3,
	})
	seedManagedChannel(t, store, good)
	seedManagedChannel(t, store, bad)
	signer := newManagedSigner(t, &managedRPC{failReads: map[string]struct{}{
		strings.ToLower(bad.ChannelId): {},
	}})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 || signer.writeCalls != 1 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	gotGood, _ := store.Get(context.Background(), good.ChannelId)
	gotBad, _ := store.Get(context.Background(), bad.ChannelId)
	if gotGood.TotalClaimed != "1000" || gotGood.ChargeCount != 0 {
		t.Fatalf("good = total %s count %d", gotGood.TotalClaimed, gotGood.ChargeCount)
	}
	if gotBad.TotalClaimed != "0" || gotBad.ChargeCount != 3 {
		t.Fatalf("bad = total %s count %d", gotBad.TotalClaimed, gotBad.ChargeCount)
	}
}

func TestFacilitatorChannelManager_ClaimRetriesPreflightMulticall(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "71", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			if attempts < multicallAttempts {
				return nil, fmt.Errorf("rpc down")
			}
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if attempts != multicallAttempts || len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("attempts=%d results=%+v", attempts, results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "1000" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimPreflightGivesUpAfterRetries(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "72", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			return nil, fmt.Errorf("rpc down")
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	_, err := mgr.Claim(context.Background(), nil)
	if err == nil {
		t.Fatal("expected preflight failure")
	}
	if attempts != multicallAttempts {
		t.Fatalf("attempts = %d, want %d", attempts, multicallAttempts)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "0" || got.ChargeCount != 1 {
		t.Fatalf("totalClaimed=%s chargeCount=%d", got.TotalClaimed, got.ChargeCount)
	}
}

func TestFacilitatorChannelManager_ClaimSkipsDrainedRow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "21", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "10000",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	rpc := &managedRPC{chainViews: map[string]managedChainView{
		strings.ToLower(ch.ChannelId): {Balance: big.NewInt(40), TotalClaimed: big.NewInt(40), WithdrawAt: 7},
	}}
	signer := newManagedSigner(t, rpc)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.Balance != "40" || got.TotalClaimed != "40" || got.WithdrawRequestedAt != 7 || got.ChargeCount != 2 {
		t.Fatalf("resynced = balance %s claimed %s withdraw %d count %d", got.Balance, got.TotalClaimed, got.WithdrawRequestedAt, got.ChargeCount)
	}
	reads := rpc.tryAggregate
	results, err = mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 || rpc.tryAggregate != reads {
		t.Fatalf("reselected results=%+v writes=%d reads=%d want %d", results, signer.writeCalls, rpc.tryAggregate, reads)
	}
}

func TestFacilitatorChannelManager_ClaimPartialWithdrawUsesBalance(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "31", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	rpc := &managedRPC{chainViews: map[string]managedChainView{
		strings.ToLower(ch.ChannelId): {Balance: big.NewInt(400), TotalClaimed: big.NewInt(0)},
	}}
	signer := newManagedSigner(t, rpc)
	var submitted []string
	origWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		if functionName == "claimWithSignature" || functionName == "claim" {
			submitted = claimTotalsFromArgs(args)
		}
		if origWrite != nil {
			return origWrite(functionName, args...)
		}
		return successTxHash, nil
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	if len(submitted) != 1 || submitted[0] != "400" {
		t.Fatalf("submitted = %v, want 400", submitted)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "400" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimSkipsMismatchedAuthorizer(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	kept := managerChannel(t, auth, "41", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	skipped := managerChannel(t, auth, "42", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	skipped.ChannelConfig.ReceiverAuthorizer = "0x1111111111111111111111111111111111111111"
	seedManagedChannel(t, store, kept)
	seedManagedChannel(t, store, skipped)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 || signer.writeCalls != 1 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	gotKept, _ := store.Get(context.Background(), kept.ChannelId)
	gotSkipped, _ := store.Get(context.Background(), skipped.ChannelId)
	if gotKept.TotalClaimed != "1000" || gotSkipped.TotalClaimed != "0" {
		t.Fatalf("kept=%s skipped=%s", gotKept.TotalClaimed, gotSkipped.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_SettleCleanupMatchesLowercaseTarget(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "51")
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(1000), receiverSettled: bigInt(1000)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: strings.ToLower(ch.ChannelConfig.Receiver),
		Token:    strings.ToLower(ch.ChannelConfig.Token),
		Amount:   bigInt(1),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.Settle(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got != nil {
		t.Fatalf("expected cleanup, got %+v", got.Channel)
	}
}

func TestFacilitatorChannelManager_SettleCleanupDeletesDespiteLock(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "52")
	seedManagedChannel(t, store, ch)
	ok, err := store.Acquire(context.Background(), ch.ChannelId, "hot-path", 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire: ok=%v err=%v", ok, err)
	}
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(1000), receiverSettled: bigInt(1000)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: strings.ToLower(ch.ChannelConfig.Receiver),
		Token:    strings.ToLower(ch.ChannelConfig.Token),
		Amount:   bigInt(1),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.Settle(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), ch.ChannelId)
	if err != nil || got != nil {
		t.Fatalf("finished row should be deleted despite a live lock: %+v %v", got, err)
	}
}

func TestCleanupSettledPair_ScannerDeletesWithoutList(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "sc")
	seedManagedChannel(t, inner, ch)
	store := &cleanupScanStore{InMemoryChannelStorage: inner, yield: []*FacilitatorChannel{ch}}
	mgr := newTestManager(t, nil, store, auth, false, nil)
	targets := &countingRemoveTargets{recordingSettleTargets: &recordingSettleTargets{}}
	mgr.settleTargetStorage = targets

	if err := mgr.cleanupSettledPair(context.Background(), storage.SettleTarget{
		Network: ch.Network, Receiver: ch.ChannelConfig.Receiver, Token: ch.ChannelConfig.Token,
	}, 0); err != nil {
		t.Fatal(err)
	}
	if store.scans != 1 || store.lists != 0 || targets.removed != 1 {
		t.Fatalf("scans=%d lists=%d removed=%d", store.scans, store.lists, targets.removed)
	}
	got, err := inner.Get(context.Background(), ch.ChannelId)
	if err != nil || got != nil {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestCleanupSettledPair_ListFallbackDeletes(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "lf")
	seedManagedChannel(t, inner, ch)
	store := &cleanupListStore{InMemoryChannelStorage: inner}
	mgr := newTestManager(t, nil, store, auth, false, nil)
	targets := &countingRemoveTargets{recordingSettleTargets: &recordingSettleTargets{}}
	mgr.settleTargetStorage = targets

	if err := mgr.cleanupSettledPair(context.Background(), storage.SettleTarget{
		Network: ch.Network, Receiver: ch.ChannelConfig.Receiver, Token: ch.ChannelConfig.Token,
	}, 0); err != nil {
		t.Fatal(err)
	}
	if store.lists == 0 || targets.removed != 1 {
		t.Fatalf("lists=%d removed=%d", store.lists, targets.removed)
	}
	got, err := inner.Get(context.Background(), ch.ChannelId)
	if err != nil || got != nil {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestCleanupSettledPair_KeepFinishedRowsRemovesTargetOnly(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "kf")
	seedManagedChannel(t, inner, ch)
	store := &cleanupScanStore{InMemoryChannelStorage: inner, yield: []*FacilitatorChannel{ch}}
	mgr := newTestManager(t, nil, store, auth, true, nil)
	targets := &countingRemoveTargets{recordingSettleTargets: &recordingSettleTargets{}}
	mgr.settleTargetStorage = targets

	if err := mgr.cleanupSettledPair(context.Background(), storage.SettleTarget{
		Network: ch.Network, Receiver: ch.ChannelConfig.Receiver, Token: ch.ChannelConfig.Token,
	}, 0); err != nil {
		t.Fatal(err)
	}
	if store.scans != 0 || store.lists != 0 || targets.removed != 1 {
		t.Fatalf("scans=%d lists=%d removed=%d", store.scans, store.lists, targets.removed)
	}
	got, err := inner.Get(context.Background(), ch.ChannelId)
	if err != nil || got == nil {
		t.Fatalf("row = %+v %v", got, err)
	}
}

type cleanupScanStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	yield []*FacilitatorChannel
	scans int
	lists int
}

func (s *cleanupScanStore) List(context.Context) ([]*FacilitatorChannel, error) {
	s.lists++
	return nil, nil
}

func (s *cleanupScanStore) ScanByReceiverToken(_ context.Context, _, _, _ string, visit func(*FacilitatorChannel) error) error {
	s.scans++
	for _, row := range s.yield {
		if err := visit(row); err != nil {
			return err
		}
	}
	return nil
}

type cleanupListStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	lists int
}

func (s *cleanupListStore) List(ctx context.Context) ([]*FacilitatorChannel, error) {
	s.lists++
	return s.InMemoryChannelStorage.List(ctx)
}

type countingRemoveTargets struct {
	*recordingSettleTargets
	removed int
}

func (s *countingRemoveTargets) RemoveSettleTarget(ctx context.Context, target storage.SettleTarget, updatedBeforeMillis int64) error {
	s.removed++
	return s.recordingSettleTargets.RemoveSettleTarget(ctx, target, updatedBeforeMillis)
}

func TestShouldDeleteFinishedChannel_NoLockInput(t *testing.T) {
	finished := &FacilitatorChannel{Channel: storage.Channel{
		Balance:                 "1000",
		ChargedCumulativeAmount: "1000",
		TotalClaimed:            "1000",
	}}
	if !IsChannelFinished(finished, 0) {
		t.Fatal("expected finished")
	}
	if !ShouldDeleteFinishedChannelAtSettle(false, finished, 0) {
		t.Fatal("expected settle delete")
	}
	if ShouldDeleteFinishedChannelAtSettle(true, finished, 0) {
		t.Fatal("KeepFinishedRows must keep the row")
	}
	if ShouldDeleteNeverClaimedRefundRow(false, finished, 0, finished.TotalClaimed) {
		t.Fatal("a claimed row is not a never-claimed refund delete")
	}
	unclaimed := finished.Clone()
	unclaimed.TotalClaimed = "0"
	unclaimed.Balance = "0"
	unclaimed.ChargedCumulativeAmount = "0"
	if !ShouldDeleteNeverClaimedRefundRow(false, unclaimed, 0, "0") {
		t.Fatal("expected never-claimed refund delete")
	}
	if ShouldDeleteNeverClaimedRefundRow(true, unclaimed, 0, "0") {
		t.Fatal("KeepFinishedRows must keep a never-claimed row")
	}
}

func finishedManagedChannel(t *testing.T, auth *fakeAuthorizerSigner, salt string) *FacilitatorChannel {
	t.Helper()
	return managerChannel(t, auth, salt, &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "1000",
		TotalClaimed:            "1000",
	})
}

func claimBatchContains(args []interface{}, total string) bool {
	for _, got := range claimTotalsFromArgs(args) {
		if got == total {
			return true
		}
	}
	return false
}

func claimTotalsFromArgs(args []interface{}) []string {
	if len(args) == 0 {
		return nil
	}
	value := reflect.ValueOf(args[0])
	if value.Kind() != reflect.Slice {
		return nil
	}
	out := make([]string, 0, value.Len())
	for i := 0; i < value.Len(); i++ {
		total := value.Index(i).FieldByName("TotalClaimed")
		if !total.IsValid() || total.IsNil() {
			continue
		}
		out = append(out, total.Interface().(*big.Int).String())
	}
	return out
}

func TestFacilitatorChannelManager_SortsWithdrawPendingBeforeReservedIdle(t *testing.T) {
	t.Parallel()
	rows := []*FacilitatorChannel{
		{Channel: storage.Channel{ChannelId: "high", ChargedCumulativeAmount: "900", TotalClaimed: "0", LastRequestTimestamp: 3}},
		{Channel: storage.Channel{ChannelId: "late-withdraw", ChargedCumulativeAmount: "1", TotalClaimed: "0", WithdrawRequestedAt: 50}},
		{Channel: storage.Channel{ChannelId: "idle", ChargedCumulativeAmount: "10", TotalClaimed: "0", LastRequestTimestamp: 1}},
		{Channel: storage.Channel{ChannelId: "early-withdraw", ChargedCumulativeAmount: "1", TotalClaimed: "0", WithdrawRequestedAt: 10}},
		{Channel: storage.Channel{ChannelId: "mid", ChargedCumulativeAmount: "400", TotalClaimed: "0", LastRequestTimestamp: 2}},
	}
	sortClaimRows(rows, map[string]struct{}{"idle": {}})
	got := make([]string, len(rows))
	for i, row := range rows {
		got[i] = row.ChannelId
	}
	want := []string{"early-withdraw", "late-withdraw", "idle", "high", "mid"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

func TestFacilitatorChannelManager_RefundRequiresIdleSecs(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, false, nil)
	_, err := mgr.RefundIdleChannels(context.Background(), FacilitatorRefundOptions{})
	if err == nil {
		t.Fatal("expected idleSecs error")
	}
}

func TestFacilitatorChannelManager_ClaimStopsWhenContextCanceled(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	first := managerChannel(t, auth, "01", &channelFields{ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1, LastRequestTimestamp: 1})
	second := managerChannel(t, auth, "02", &channelFields{ChargedCumulativeAmount: "9000", SignedMaxClaimable: "9000", ChargeCount: 1, LastRequestTimestamp: 2})
	seedManagedChannel(t, inner, first)
	seedManagedChannel(t, inner, second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &cancelAfterUpdateStore{InMemoryChannelStorage: inner, cancel: cancel, after: 1}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	_, err := mgr.Claim(ctx, &FacilitatorClaimOptions{
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      2,
		UnclaimedDesc:     true,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want canceled", err)
	}
	gotFirst, err := inner.Get(context.Background(), first.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if gotFirst.TotalClaimed != "0" {
		t.Fatalf("lower unclaimed row was claimed: %s", gotFirst.TotalClaimed)
	}
	gotSecond, err := inner.Get(context.Background(), second.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if gotSecond.TotalClaimed != "9000" || gotSecond.ChargeCount != 0 {
		t.Fatalf("landed totalClaimed=%s chargeCount=%d", gotSecond.TotalClaimed, gotSecond.ChargeCount)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d, want 1", signer.writeCalls)
	}
}

type cancelAfterUpdateStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	cancel func()
	after  int
	calls  int
}

func (s *cancelAfterUpdateStore) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	s.calls++
	if s.calls == s.after {
		s.cancel()
	}
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelID, update)
}

func TestFacilitatorChannelManager_ClaimPreflightAppliesSettleTargetDelta(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "11", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		TotalClaimed:            "0",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{
		chainViews: map[string]managedChainView{
			strings.ToLower(ch.ChannelId): {Balance: bigInt(10000), TotalClaimed: bigInt(5000)},
		},
	})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%v writes=%d, want a skipped claim", results, signer.writeCalls)
	}
	page, err := mgr.settleTargetStorage.ListSettleTargets(context.Background(), storage.SettleQuery{Network: ch.Network, Limit: intPtr(10)})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("settle targets = %d, want the ahead delta", len(page.Items))
	}
	got, err := store.Get(context.Background(), ch.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.TotalClaimed != "5000" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_SettleSkipsOneSimulationFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	innerRead := signer.readContract
	sims := 0
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == "multicall" {
			sims++
			if sims <= 2 {
				return nil, errors.New("execution reverted")
			}
		}
		return innerRead(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	mgr.settleTargetStorage = storage.NewInMemorySettleTargetStorage()
	first := storage.SettleTarget{Network: managedNetwork, Receiver: "0x1111111111111111111111111111111111111111", Token: managedToken}
	second := storage.SettleTarget{Network: managedNetwork, Receiver: "0x2222222222222222222222222222222222222222", Token: managedToken}
	for _, target := range []storage.SettleTarget{first, second} {
		if err := mgr.settleTargetStorage.RecordClaimed(context.Background(), storage.SettleTargetClaimDelta{
			Network: target.Network, Receiver: target.Receiver, Token: target.Token, Amount: bigInt(5),
		}); err != nil {
			t.Fatal(err)
		}
	}
	var skipped []string
	var batchErrs int
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MaxSettlesPerTx: 2,
		OnError: func(err error, target *storage.SettleTarget) {
			if target == nil {
				batchErrs++
				return
			}
			skipped = append(skipped, target.Receiver)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if batchErrs != 0 || len(skipped) != 1 || len(results) != 1 {
		t.Fatalf("skipped=%v batchErrs=%d results=%v", skipped, batchErrs, results)
	}
	if results[0].Receiver != second.Receiver {
		t.Fatalf("settled %s, want %s", results[0].Receiver, second.Receiver)
	}
}

func TestFacilitatorChannelManager_SettleReportsBatchFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	signer.writeContract = func(string, ...interface{}) (string, error) {
		return "", errors.New("rpc down")
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	mgr.settleTargetStorage = storage.NewInMemorySettleTargetStorage()
	seedManagerSettleTarget(t, mgr, managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000"}))
	var got error
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		OnError: func(err error, target *storage.SettleTarget) {
			got = err
			if target != nil {
				t.Fatal("batch failure should not carry a target")
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(results) != 0 {
		t.Fatalf("onError=%v results=%v", got, results)
	}
}

func TestFacilitatorChannelManager_ClaimReportsBatchFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "03", &channelFields{ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	signer.writeContract = func(string, ...interface{}) (string, error) {
		return "", errors.New("rpc down")
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	var got error
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		OnError: func(err error, channelID string) {
			got = err
			if channelID != "" {
				t.Fatalf("batch failure channelID = %s", channelID)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(results) != 0 {
		t.Fatalf("onError=%v results=%v", got, results)
	}
}

func TestFacilitatorChannelManager_RefundClaimsApplySettleTargetDelta(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		TotalClaimed:            "1000",
		ChargeCount:             2,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if _, err := refundIdle(mgr); err != nil {
		t.Fatal(err)
	}
	page, err := mgr.settleTargetStorage.ListSettleTargets(context.Background(), storage.SettleQuery{Network: ch.Network, Limit: intPtr(10)})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("settle targets = %d", len(page.Items))
	}

	targets := storage.NewInMemorySettleTargetStorage()
	// The idle refund above drained the fake chain's balance, so the hot refund gets its own signer.
	deps := managedDeps(t, store, store, auth, newManagedSigner(t, nil))
	deps.SettleTargetStorage = targets
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("11", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := ch.ChannelConfig
	cfg.Salt = packed
	channelID := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelID, "1000", "0", managedNetwork)
	hot := storedManagedChannel(cfg, channelID, &channelFields{
		ChargedCumulativeAmount: "5000",
		Balance:                 "10000",
		TotalClaimed:            "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, hot)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth
	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelID, "5000", dummySig), "1000", "", sig),
		reqs, nil, nil)
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("hot refund %+v %v", resp, err)
	}
	hotPage, err := targets.ListSettleTargets(context.Background(), storage.SettleQuery{Network: managedNetwork, Limit: intPtr(10)})
	if err != nil {
		t.Fatal(err)
	}
	if len(hotPage.Items) != 1 {
		t.Fatalf("hot settle targets = %d", len(hotPage.Items))
	}
}

type chargeSnapStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	snaps []int
}

func (s *chargeSnapStore) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	res, err := s.InMemoryChannelStorage.UpdateChannel(ctx, channelID, update)
	if err == nil && res != nil && res.Status == storage.ChannelUpdated && res.Channel != nil {
		s.snaps = append(s.snaps, res.Channel.ChargeCount)
	}
	return res, err
}

type allowNUpdates struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	allow int
	calls int
}

func (s *allowNUpdates) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	s.calls++
	if s.calls > s.allow {
		return &storage.ChannelUpdateResult[*FacilitatorChannel]{Status: storage.ChannelConflict}, nil
	}
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelID, update)
}

func snapHas(snaps []int, want int) bool {
	for _, n := range snaps {
		if n == want {
			return true
		}
	}
	return false
}

func claimSuffixCount(t *testing.T, mgr *FacilitatorChannelManager) uint64 {
	t.Helper()
	counts := managerChargeCounts(t, mgr)
	if len(counts) != 1 {
		return ^uint64(0)
	}
	return counts[0]
}

// erc8021Marker is the 16-byte ERC-8021 marker that ends a builder-code suffix.
const erc8021Marker = "80218021802180218021802180218021"

// assertBareMulticallLegs fails when an inner multicall leg carries an ERC-8021 suffix:
// only the top-level calldata is read by indexers.
func assertBareMulticallLegs(t *testing.T, args []interface{}) {
	t.Helper()
	calls, ok := args[0].([][]byte)
	if !ok {
		t.Fatalf("multicall args[0] is %T", args[0])
	}
	for _, call := range calls {
		if strings.HasSuffix(hex.EncodeToString(call), erc8021Marker) {
			t.Fatalf("inner multicall leg carries an ERC-8021 suffix: %x", call)
		}
	}
}

func TestClaim_HotChannelRepairsSkippedFinish(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "h1", &channelFields{
		ChargedCumulativeAmount: "8000",
		SignedMaxClaimable:      "8000",
		Balance:                 "10000",
		ChargeCount:             80,
	})
	plantClaimMarker(ch, 50, "5000")
	seedManagedChannel(t, inner, ch)
	snaps := &chargeSnapStore{InMemoryChannelStorage: inner}
	rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(5000)}
	signer := newManagedSigner(t, rpc)
	var attested int
	orig := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		row, err := inner.Get(context.Background(), ch.ChannelId)
		if err != nil {
			t.Fatal(err)
		}
		if row.PendingClaim != nil {
			attested = row.PendingClaim.AttestedCount
		}
		return orig(functionName, args...)
	}
	mgr := newTestManager(t, signer, snaps, auth, false, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if attested != 30 || claimSuffixCount(t, mgr) != 30 {
		t.Fatalf("attested=%d suffix=%d snaps=%v", attested, claimSuffixCount(t, mgr), snaps.snaps)
	}
	if !snapHas(snaps.snaps, 30) || snaps.snaps[len(snaps.snaps)-1] != 0 {
		t.Fatalf("snaps=%v", snaps.snaps)
	}
	got, err := inner.Get(context.Background(), ch.ChannelId)
	if err != nil || got.ChargeCount != 0 || got.PendingClaim != nil || got.TotalClaimed != "8000" {
		t.Fatalf("stored %+v %v", got, err)
	}
}

func TestClaim_IdleSkippedFinishThenSettleDeletes(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "i1", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "1000",
		ChargeCount:             50,
	})
	plantClaimMarker(ch, 50, "1000")
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{
		balance:         big.NewInt(1000),
		totalClaimed:    big.NewInt(1000),
		receiverClaimed: big.NewInt(1000),
		receiverSettled: big.NewInt(1000),
	})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), ch.ChannelId)
	if err != nil || got.ChargeCount != 0 || got.PendingClaim != nil || !IsChannelFinished(got, got.ChargeCount) {
		t.Fatalf("after claim %+v %v", got, err)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
	if _, err := mgr.Settle(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, err = store.Get(context.Background(), ch.ChannelId)
	if err != nil || got != nil {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestClaim_KeepFinishedRowsSkipsSettleDelete(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "i2")
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{
		receiverClaimed: big.NewInt(1000),
		receiverSettled: big.NewInt(1000),
	})
	mgr := newTestManager(t, signer, store, auth, true, nil)
	seedManagerSettleTarget(t, mgr, ch)
	if _, err := mgr.Settle(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), ch.ChannelId)
	if err != nil || got == nil {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestClaim_YoungMarkerIsSkipped(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "y1", &channelFields{
		ChargedCumulativeAmount: "8000",
		SignedMaxClaimable:      "8000",
		Balance:                 "10000",
		ChargeCount:             80,
	})
	plantClaimMarker(ch, 50, "5000")
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil || len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%+v writes=%d err=%v", results, signer.writeCalls, err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 80 || got.PendingClaim == nil || got.PendingClaim.AttestedCount != 50 {
		t.Fatalf("stored %+v", got)
	}
}

func TestClaim_AgedMarkerClearsWithoutSubtract(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "a1", &channelFields{
		ChargedCumulativeAmount: "8000",
		SignedMaxClaimable:      "8000",
		Balance:                 "10000",
		ChargeCount:             80,
	})
	plantClaimMarker(ch, 50, "5000")
	ch.PendingClaim.StartedAt = time.Now().Add(-pendingClaimResolveAge - time.Second).UnixMilli()
	seedManagedChannel(t, inner, ch)
	snaps := &chargeSnapStore{InMemoryChannelStorage: inner}
	signer := newManagedSigner(t, &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(0)})
	mgr := newTestManager(t, signer, snaps, auth, false, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if claimSuffixCount(t, mgr) != 80 || snapHas(snaps.snaps, 30) {
		t.Fatalf("suffix=%d snaps=%v", claimSuffixCount(t, mgr), snaps.snaps)
	}
	got, _ := inner.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 0 || got.PendingClaim != nil {
		t.Fatalf("stored %+v", got)
	}
}

func TestClaim_RevertedReceiptClearsWithoutSubtract(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "r1", &channelFields{
		ChargedCumulativeAmount: "8000",
		SignedMaxClaimable:      "8000",
		Balance:                 "10000",
		ChargeCount:             80,
	})
	plantClaimMarker(ch, 50, "5000")
	ch.PendingClaim.TxHash = successTxHash
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(0)})
	lookups := 0
	defaultReceipt := signer.waitForReceipt
	signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
		lookups++
		if lookups == 1 {
			return &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: txHash}, nil
		}
		return defaultReceipt(txHash)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if claimSuffixCount(t, mgr) != 80 {
		t.Fatalf("suffix=%d", claimSuffixCount(t, mgr))
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 0 || got.PendingClaim != nil {
		t.Fatalf("stored %+v", got)
	}
}

func TestClaim_SuccessfulReceiptLandsWhenOnchainLags(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "s1", &channelFields{
		ChargedCumulativeAmount: "8000",
		SignedMaxClaimable:      "8000",
		Balance:                 "10000",
		ChargeCount:             80,
	})
	plantClaimMarker(ch, 50, "5000")
	ch.PendingClaim.TxHash = successTxHash
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(0)})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if claimSuffixCount(t, mgr) != 30 {
		t.Fatalf("suffix=%d", claimSuffixCount(t, mgr))
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 0 || got.PendingClaim != nil || got.TotalClaimed != "8000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestClaim_SettlementPendingKeepsMarkerUntilReceipt(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "p1", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             4,
	})
	seedManagedChannel(t, store, ch)
	rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(0)}
	signer := newManagedSigner(t, rpc)
	signer.waitForReceipt = func(string) (*evm.TransactionReceipt, error) {
		return nil, errors.New("still pending")
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	var reported error
	if _, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		OnError: func(err error, _ string) { reported = err },
	}); err != nil {
		t.Fatal(err)
	}
	var settleErr *x402.SettleError
	if !errors.As(reported, &settleErr) || settleErr.ErrorReason != ErrSettlementPending || settleErr.Transaction != successTxHash {
		t.Fatalf("reported = %v", reported)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 4 || got.PendingClaim == nil || got.PendingClaim.TxHash != successTxHash || got.PendingClaim.AttestedCount != 4 {
		t.Fatalf("marker = %+v", got)
	}

	signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
		return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
	}
	rpc.totalClaimed = big.NewInt(1000)
	writes := signer.writeCalls
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != writes {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	got, _ = store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 0 || got.PendingClaim != nil {
		t.Fatalf("repaired %+v", got)
	}
}

func TestClaim_FinishConflictReachesOnError(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "c1", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             4,
	})
	seedManagedChannel(t, inner, ch)
	store := &allowNUpdates{InMemoryChannelStorage: inner, allow: 2}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	var reported error
	if _, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		OnError: func(err error, _ string) { reported = err },
	}); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(reported, errChannelConflict) || store.calls < 4 {
		t.Fatalf("reported=%v calls=%d", reported, store.calls)
	}
	got, _ := inner.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 4 || got.PendingClaim == nil || got.PendingClaim.TxHash != successTxHash {
		t.Fatalf("marker = %+v", got)
	}
}

func TestBeginAttestedClaim_ConflictAndBusy(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "b1", nil)
	seedManagedChannel(t, inner, ch)
	blocked := &conflictChannelStore{InMemoryChannelStorage: inner}
	claim := claimFromRow(t, ch)
	_, _, err := beginAttestedClaim(context.Background(), blocked, ch.ChannelId, claim, time.Now().UnixMilli())
	if !errors.Is(err, errChannelConflict) {
		t.Fatalf("begin err = %v", err)
	}
	got, _ := inner.Get(context.Background(), ch.ChannelId)
	if got.PendingClaim != nil {
		t.Fatal("conflict wrote a marker")
	}

	one, result, err := beginAttestedClaim(context.Background(), inner, ch.ChannelId, claim, time.Now().UnixMilli())
	if err != nil || result != beginStarted || one.Count != got.ChargeCount {
		t.Fatalf("first begin %+v result=%v err=%v", one, result, err)
	}
	_, result, err = beginAttestedClaim(context.Background(), inner, ch.ChannelId, claim, time.Now().UnixMilli())
	if err != nil || result != beginBusy {
		t.Fatalf("second begin result=%v err=%v", result, err)
	}
}

func claimFromRow(t *testing.T, ch *FacilitatorChannel) batchsettlement.BatchSettlementVoucherClaim {
	t.Helper()
	claims := rebuildClaims(ch)
	if len(claims) != 1 {
		t.Fatalf("row has no claimable voucher: %+v", ch)
	}
	return claims[0]
}

func commitVoucher(t *testing.T, store storage.ChannelStorage[*FacilitatorChannel], channelID, charged, signature string) {
	t.Helper()
	_, err := store.UpdateChannel(context.Background(), channelID, func(current *FacilitatorChannel) *FacilitatorChannel {
		next := current.Clone()
		next.ChargedCumulativeAmount = charged
		next.SignedMaxClaimable = charged
		next.Signature = signature
		next.ChargeCount++
		return next
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestBeginAttestedClaim_StaleClaimedToAfterVoucherCommit(t *testing.T) {
	// The claim was built at charged=1000/count=4, then a voucher commit bumped the row to 1500/count=5.
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "b2", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "2000",
		ChargeCount:             4,
	})
	ch.Signature = "0xold"
	seedManagedChannel(t, store, ch)
	stale := claimFromRow(t, ch)

	commitVoucher(t, store, ch.ChannelId, "1500", "0xnew")

	_, result, err := beginAttestedClaim(context.Background(), store, ch.ChannelId, stale, time.Now().UnixMilli())
	if err != nil || result != beginSuperseded {
		t.Fatalf("stale begin result=%v err=%v", result, err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.PendingClaim != nil || got.ChargeCount != 5 {
		t.Fatalf("superseded begin changed the row: %+v", got)
	}

	fresh := claimFromRow(t, got)
	one, result, err := beginAttestedClaim(context.Background(), store, ch.ChannelId, fresh, time.Now().UnixMilli())
	if err != nil || result != beginStarted || one.Count != 5 {
		t.Fatalf("fresh begin %+v result=%v err=%v", one, result, err)
	}
	if err := finishAttestedClaim(context.Background(), store, ch.ChannelId, fresh.TotalClaimed, one, true); err != nil {
		t.Fatal(err)
	}
	got, _ = store.Get(context.Background(), ch.ChannelId)
	if got.PendingClaim != nil || got.ChargeCount != 0 || got.TotalClaimed != "1500" {
		t.Fatalf("after finish %+v", got)
	}
}

func TestBeginAttestedClaim_AlreadyClaimed(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "b3", &channelFields{ChargedCumulativeAmount: "1000", SignedMaxClaimable: "1000", ChargeCount: 3})
	seedManagedChannel(t, store, ch)
	claim := claimFromRow(t, ch)
	if _, err := store.UpdateChannel(context.Background(), ch.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		next := current.Clone()
		next.TotalClaimed = "1000"
		return next
	}); err != nil {
		t.Fatal(err)
	}
	_, result, err := beginAttestedClaim(context.Background(), store, ch.ChannelId, claim, time.Now().UnixMilli())
	if err != nil || result != beginAlreadyClaimed {
		t.Fatalf("result=%v err=%v", result, err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.PendingClaim != nil || got.ChargeCount != 3 {
		t.Fatalf("row changed: %+v", got)
	}
}

func TestBeginAttestedClaim_Missing(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "b4", nil)
	_, result, err := beginAttestedClaim(context.Background(), store, ch.ChannelId, claimFromRow(t, ch), time.Now().UnixMilli())
	if err != nil || result != beginMissing {
		t.Fatalf("result=%v err=%v", result, err)
	}
}

func TestFinishAttestedClaim_NonMatchingItemKeepsMarker(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "b5", &channelFields{ChargedCumulativeAmount: "1000", SignedMaxClaimable: "1000", ChargeCount: 4})
	plantClaimMarker(ch, 3, "900")
	seedManagedChannel(t, store, ch)
	stranger := attestedClaim{ChannelID: ch.ChannelId, Count: 4, ClaimedTo: "1000", StartedAt: ch.PendingClaim.StartedAt - 1}
	if err := finishAttestedClaim(context.Background(), store, ch.ChannelId, "1000", stranger, true); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.PendingClaim == nil || got.PendingClaim.AttestedCount != 3 || got.ChargeCount != 4 {
		t.Fatalf("other marker was touched: %+v", got)
	}
	if got.TotalClaimed != "1000" {
		t.Fatalf("totalClaimed = %s, want merged 1000", got.TotalClaimed)
	}
	owner := attestedClaim{ChannelID: ch.ChannelId, Count: 3, ClaimedTo: "900", StartedAt: ch.PendingClaim.StartedAt}
	if err := finishAttestedClaim(context.Background(), store, ch.ChannelId, "1000", owner, true); err != nil {
		t.Fatal(err)
	}
	got, _ = store.Get(context.Background(), ch.ChannelId)
	if got.PendingClaim != nil || got.ChargeCount != 1 {
		t.Fatalf("owner finish: %+v", got)
	}
}

func TestRefund_LiveMarkerBlocksBundle(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "rb", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		ChargeCount:             4,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	plantClaimMarker(ch, 4, "5000")
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	var reported error
	results, err := mgr.RefundIdleChannels(context.Background(), FacilitatorRefundOptions{
		IdleSecs: 60,
		OnError:  func(err error, _ string) { reported = err },
	})
	if err != nil || len(results) != 0 || signer.writeCalls != 0 || !errors.Is(reported, errAttestedClaimBusy) {
		t.Fatalf("results=%+v writes=%d reported=%v err=%v", results, signer.writeCalls, reported, err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 4 || got.PendingClaim == nil {
		t.Fatalf("stored %+v", got)
	}
}

func TestRefund_BundleCalldataMatchesMarker(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "rc", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		ChargeCount:             4,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	var attested int
	orig := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		row, err := store.Get(context.Background(), ch.ChannelId)
		if err != nil {
			t.Fatal(err)
		}
		if row.PendingClaim != nil {
			attested = row.PendingClaim.AttestedCount
		}
		if functionName == "multicall" {
			assertBareMulticallLegs(t, args)
		}
		return orig(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := refundIdle(mgr)
	if err != nil || len(results) != 1 {
		t.Fatalf("results=%+v err=%v", results, err)
	}
	counts := managerChargeCounts(t, mgr)
	if attested != 4 || len(counts) != 1 || counts[0] != 4 {
		t.Fatalf("attested=%d counts=%v", attested, counts)
	}
	if signer.writeFns[len(signer.writeFns)-1] != "multicall" {
		t.Fatalf("writes = %v, want a multicall of claim and refund", signer.writeFns)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 0 || got.PendingClaim != nil {
		t.Fatalf("stored %+v", got)
	}
}

type conflictOnChannelStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	conflictID string
}

func (s *conflictOnChannelStore) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	if strings.EqualFold(channelID, s.conflictID) {
		return &storage.ChannelUpdateResult[*FacilitatorChannel]{Status: storage.ChannelConflict}, nil
	}
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelID, update)
}

func claimBatchFixture(t *testing.T) (*FacilitatorChannel, *FacilitatorChannel, *storage.InMemoryChannelStorage[*FacilitatorChannel], *fakeAuthorizerSigner) {
	t.Helper()
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	fields := &channelFields{ChargedCumulativeAmount: "1000", SignedMaxClaimable: "1000", ChargeCount: 2}
	first := managerChannel(t, auth, "a1", fields)
	second := managerChannel(t, auth, "a2", fields)
	seedManagedChannel(t, store, first)
	seedManagedChannel(t, store, second)
	return first, second, store, auth
}

func assertClaimedAlone(t *testing.T, store storage.ChannelStorage[*FacilitatorChannel], claimed, skipped *FacilitatorChannel, results []FacilitatorClaimResult, signer *fakeFacilitatorSigner) {
	t.Helper()
	if len(results) != 1 || results[0].Vouchers != 1 || signer.writeCalls != 1 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	got, _ := store.Get(context.Background(), claimed.ChannelId)
	if got.TotalClaimed != "1000" || got.ChargeCount != 0 || got.PendingClaim != nil {
		t.Fatalf("claimed channel %+v", got)
	}
	got, _ = store.Get(context.Background(), skipped.ChannelId)
	if got.TotalClaimed != "0" || got.PendingClaim != nil {
		t.Fatalf("skipped channel %+v", got)
	}
}

func TestClaimSlice_SkipsSupersededChannel(t *testing.T) {
	first, second, store, auth := claimBatchFixture(t)
	claims := []batchsettlement.BatchSettlementVoucherClaim{claimFromRow(t, first), claimFromRow(t, second)}
	commitVoucher(t, store, second.ChannelId, "1500", "0xnew")
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.claimSlice(context.Background(), managedNetwork, claims, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertClaimedAlone(t, store, first, second, results, signer)
	if got, _ := store.Get(context.Background(), second.ChannelId); got.ChargeCount != 3 {
		t.Fatalf("superseded row chargeCount = %d, want 3", got.ChargeCount)
	}
}

func TestClaimSlice_SkipsBusyAndAlreadyClaimedChannels(t *testing.T) {
	first, second, store, auth := claimBatchFixture(t)
	claims := []batchsettlement.BatchSettlementVoucherClaim{claimFromRow(t, first), claimFromRow(t, second)}
	if _, err := store.UpdateChannel(context.Background(), second.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		next := current.Clone()
		plantClaimMarker(next, 2, "1000")
		return next
	}); err != nil {
		t.Fatal(err)
	}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.claimSlice(context.Background(), managedNetwork, claims, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results=%+v", results)
	}
	got, _ := store.Get(context.Background(), second.ChannelId)
	if got.PendingClaim == nil || got.ChargeCount != 2 {
		t.Fatalf("busy channel was touched: %+v", got)
	}
}

func TestClaimSlice_SkipsBeginConflict(t *testing.T) {
	first, second, inner, auth := claimBatchFixture(t)
	claims := []batchsettlement.BatchSettlementVoucherClaim{claimFromRow(t, first), claimFromRow(t, second)}
	store := &conflictOnChannelStore{InMemoryChannelStorage: inner, conflictID: second.ChannelId}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.claimSlice(context.Background(), managedNetwork, claims, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertClaimedAlone(t, inner, first, second, results, signer)
}

// threeChannelClaimFixture seeds channels A, B, C with charge counts 4, 2, 7 and returns the
// store, authorizer, rows, and claims in that order.
func threeChannelClaimFixture(t *testing.T) (storage.ChannelStorage[*FacilitatorChannel], *fakeAuthorizerSigner, []*FacilitatorChannel, []batchsettlement.BatchSettlementVoucherClaim) {
	t.Helper()
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	rows := make([]*FacilitatorChannel, 0, 3)
	claims := make([]batchsettlement.BatchSettlementVoucherClaim, 0, 3)
	for i, count := range []int{4, 2, 7} {
		row := managerChannel(t, auth, fmt.Sprintf("b%d", i), &channelFields{
			ChargedCumulativeAmount: "1000",
			SignedMaxClaimable:      "1000",
			ChargeCount:             count,
		})
		seedManagedChannel(t, store, row)
		rows = append(rows, row)
		claims = append(claims, claimFromRow(t, row))
	}
	return store, auth, rows, claims
}

func assertChargeCounts(t *testing.T, store storage.ChannelStorage[*FacilitatorChannel], rows []*FacilitatorChannel, want []int) {
	t.Helper()
	for i, row := range rows {
		got, err := store.Get(context.Background(), row.ChannelId)
		if err != nil || got == nil {
			t.Fatalf("row %d: %+v %v", i, got, err)
		}
		if got.ChargeCount != want[i] || got.PendingClaim != nil {
			t.Fatalf("row %d chargeCount = %d, marker = %+v, want count %d and no marker", i, got.ChargeCount, got.PendingClaim, want[i])
		}
	}
}

func TestClaimSlice_AttestsOneCountPerRowInCallOrder(t *testing.T) {
	store, auth, rows, claims := threeChannelClaimFixture(t)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if _, err := mgr.claimSlice(context.Background(), managedNetwork, claims, nil, nil); err != nil {
		t.Fatal(err)
	}
	if counts := managerChargeCounts(t, mgr); !reflect.DeepEqual(counts, []uint64{4, 2, 7}) {
		t.Fatalf("counts = %v, want [4 2 7]", counts)
	}
	assertChargeCounts(t, store, rows, []int{0, 0, 0})
}

func TestClaimSlice_NoOpRowKeepsOnlyItsOwnCountPending(t *testing.T) {
	store, auth, rows, claims := threeChannelClaimFixture(t)
	// Row B emits no Claimed event; A and C do. Only B's count stays pending for its next claim.
	signer := newManagedSigner(t, &managedRPC{noopChannels: map[string]struct{}{strings.ToLower(rows[1].ChannelId): {}}})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.claimSlice(context.Background(), managedNetwork, claims, nil, nil)
	if err != nil || len(results) != 1 {
		t.Fatalf("results=%+v err=%v", results, err)
	}
	if counts := managerChargeCounts(t, mgr); !reflect.DeepEqual(counts, []uint64{4, 2, 7}) {
		t.Fatalf("counts = %v, want [4 2 7]", counts)
	}
	assertChargeCounts(t, store, rows, []int{0, 2, 0})
}

func TestClaimSlice_RetriedBatchWithNoClaimedEventsSubtractsNothing(t *testing.T) {
	store, auth, rows, claims := threeChannelClaimFixture(t)
	signer := newManagedSigner(t, &managedRPC{suppressClaimed: true})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	if _, err := mgr.claimSlice(context.Background(), managedNetwork, claims, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertChargeCounts(t, store, rows, []int{4, 2, 7})
}

func TestRefund_NoOpClaimLegKeepsChargeCountPending(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "rn", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		ChargeCount:             4,
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{noopChannels: map[string]struct{}{strings.ToLower(ch.ChannelId): {}}})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := refundIdle(mgr)
	if err != nil || len(results) != 1 {
		t.Fatalf("results=%+v err=%v", results, err)
	}
	if counts := managerChargeCounts(t, mgr); !reflect.DeepEqual(counts, []uint64{4}) {
		t.Fatalf("counts = %v, want [4]", counts)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got == nil || got.ChargeCount != 4 || got.PendingClaim != nil {
		t.Fatalf("a no-op claim leg must keep its count pending: %+v", got)
	}
}

func TestClaimSlice_ResolvePendingConflictDoesNotFailPass(t *testing.T) {
	first, second, inner, auth := claimBatchFixture(t)
	claims := []batchsettlement.BatchSettlementVoucherClaim{claimFromRow(t, first), claimFromRow(t, second)}
	if _, err := inner.UpdateChannel(context.Background(), second.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		next := current.Clone()
		plantClaimMarker(next, 2, "1000")
		return next
	}); err != nil {
		t.Fatal(err)
	}
	store := &conflictOnChannelStore{InMemoryChannelStorage: inner, conflictID: second.ChannelId}
	signer := newManagedSigner(t, &managedRPC{chainViews: map[string]managedChainView{
		strings.ToLower(second.ChannelId): {Balance: big.NewInt(10000), TotalClaimed: big.NewInt(1000)},
	}})
	mgr := newTestManager(t, signer, store, auth, false, nil)
	results, err := mgr.claimSlice(context.Background(), managedNetwork, claims, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 || signer.writeCalls != 1 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	got, _ := inner.Get(context.Background(), first.ChannelId)
	if got.TotalClaimed != "1000" || got.ChargeCount != 0 {
		t.Fatalf("first channel %+v", got)
	}
}

func TestTokenAmountGateResolve(t *testing.T) {
	base := evm.DefaultAssets["eip155:8453"][0]
	sepolia := evm.DefaultAssets["eip155:84532"][0]
	mezo := evm.DefaultAssets["eip155:31611"][0]
	world := evm.DefaultAssets["eip155:480"][0]
	unknown := "0x0000000000000000000000000000000000000001"

	t.Run("dollar amount uses default asset decimals", func(t *testing.T) {
		gate := TokenAmountGate{DefaultAssetAmount: "$1"}
		got, ok, err := gate.Resolve("eip155:8453", base.Asset)
		if err != nil || !ok || got.Cmp(big.NewInt(1_000_000)) != 0 {
			t.Fatalf("base = %v ok=%v err=%v", got, ok, err)
		}
		got, ok, err = gate.Resolve("eip155:84532", strings.ToLower(sepolia.Asset))
		if err != nil || !ok || got.Cmp(big.NewInt(1_000_000)) != 0 {
			t.Fatalf("sepolia = %v ok=%v err=%v", got, ok, err)
		}
		got, ok, err = gate.Resolve("eip155:480", world.Asset)
		if err != nil || !ok || got.Cmp(big.NewInt(1_000_000)) != 0 {
			t.Fatalf("world = %v ok=%v err=%v", got, ok, err)
		}
		want, _ := new(big.Int).SetString("1000000000000000000", 10)
		got, ok, err = gate.Resolve("eip155:31611", mezo.Asset)
		if err != nil || !ok || got.Cmp(want) != 0 {
			t.Fatalf("mezo = %v ok=%v err=%v", got, ok, err)
		}
	})

	t.Run("explicit atomic amount beats the dollar amount", func(t *testing.T) {
		gate := TokenAmountGate{
			DefaultAssetAmount: "$1",
			Assets: []TokenAtomicAmount{{
				Network: "eip155:84532",
				Asset:   strings.ToLower(sepolia.Asset),
				Amount:  "42",
			}},
		}
		got, ok, err := gate.Resolve("eip155:84532", sepolia.Asset)
		if err != nil || !ok || got.Cmp(big.NewInt(42)) != 0 {
			t.Fatalf("explicit = %v ok=%v err=%v", got, ok, err)
		}
		got, ok, err = gate.Resolve("eip155:8453", base.Asset)
		if err != nil || !ok || got.Cmp(big.NewInt(1_000_000)) != 0 {
			t.Fatalf("other network = %v ok=%v err=%v", got, ok, err)
		}
	})

	t.Run("explicit symbol matches the default asset", func(t *testing.T) {
		gate := TokenAmountGate{
			DefaultAssetAmount: "$1",
			Assets: []TokenAtomicAmount{{
				Network: "eip155:84532",
				Asset:   "USDC",
				Amount:  "7",
			}},
		}
		got, ok, err := gate.Resolve("eip155:84532", sepolia.Asset)
		if err != nil || !ok || got.Cmp(big.NewInt(7)) != 0 {
			t.Fatalf("symbol = %v ok=%v err=%v", got, ok, err)
		}
	})

	t.Run("unknown token is ungated", func(t *testing.T) {
		gate := TokenAmountGate{DefaultAssetAmount: "$1"}
		got, ok, err := gate.Resolve("eip155:8453", unknown)
		if err != nil || ok || got != nil {
			t.Fatalf("unknown = %v ok=%v err=%v", got, ok, err)
		}
	})

	t.Run("empty dollar amount leaves default assets ungated", func(t *testing.T) {
		got, ok, err := (TokenAmountGate{}).Resolve("eip155:8453", base.Asset)
		if err != nil || ok || got != nil {
			t.Fatalf("zero gate = %v ok=%v err=%v", got, ok, err)
		}
	})

	t.Run("dollar string in an explicit amount is rejected", func(t *testing.T) {
		gate := TokenAmountGate{
			DefaultAssetAmount: "$1",
			Assets: []TokenAtomicAmount{{
				Network: "eip155:8453",
				Asset:   base.Asset,
				Amount:  "$1",
			}},
		}
		got, ok, err := gate.Resolve("eip155:8453", base.Asset)
		if err == nil || ok || got != nil || !strings.Contains(err.Error(), "dollar") {
			t.Fatalf("got %v ok=%v err=%v", got, ok, err)
		}
	})

	t.Run("invalid dollar amount errors for a default asset only", func(t *testing.T) {
		gate := TokenAmountGate{DefaultAssetAmount: "$nope"}
		if _, ok, err := gate.Resolve("eip155:8453", base.Asset); err == nil || ok {
			t.Fatalf("default asset err=%v ok=%v", err, ok)
		}
		got, ok, err := gate.Resolve("eip155:8453", unknown)
		if err != nil || ok || got != nil {
			t.Fatalf("unknown = %v ok=%v err=%v", got, ok, err)
		}
	})
}

func TestApplyRefundChannel_TotalClaimedIsMonotonic(t *testing.T) {
	auth := managedAuthorizer()
	ch := managerChannel(t, auth, "m1", &channelFields{ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", TotalClaimed: "4000", ChargeCount: 2})
	next := applyRefundChannel(ch, nil, map[string]interface{}{"balance": "6000", "totalClaimed": "1000"}, true)
	if next == nil || next.TotalClaimed != "4000" || next.Balance != "6000" {
		t.Fatalf("next = %+v", next)
	}
}
