package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Exercises the PendingSettlementStore fast path wired into SettleDeposit (see
// deposit.go): a settle attempt whose receipt wait fails must populate the
// store keyed by the deposit authorization signature; a subsequent settle for
// the identical payload must hit that entry, skip verify/broadcast entirely,
// and reconcile against the already-broadcast transaction via
// reconcilePendingDeposit. Mirrors the TS/Python batch-settlement deposit
// pending-settlement test suites.

func pendingDepositPayload(t *testing.T) (string, *batchsettlement.BatchSettlementDepositPayload, types.PaymentRequirements) {
	t.Helper()
	payload, reqs := signedErc3009Deposit(t, testNetwork, "100", "100")
	return payload.Deposit.Authorization.Erc3009Authorization.Signature, payload, reqs
}

// depositConfirmedChannelStateReader reports an empty channel pre-broadcast and
// a balance reflecting the deposit amount once broadcast (tracked via
// writeSeen), so finishDepositSettle's post-receipt poll (see deposit.go)
// observes the expected balance on its first read instead of spinning until
// channelStatePollDeadline. Reconciliation (reconcilePendingDeposit) has no
// pre-broadcast snapshot of its own and exits its poll on the first
// successful read regardless of balance, so this also satisfies that path.
func depositConfirmedChannelStateReader(t *testing.T, writeSeen *bool) func(functionName string, _ ...interface{}) (interface{}, error) {
	return func(functionName string, _ ...interface{}) (interface{}, error) {
		if functionName == "deposit" {
			return nil, nil
		}
		if functionName != evm.FunctionTryAggregate {
			return nil, errors.New("unexpected rpc")
		}
		balance := big.NewInt(0)
		if writeSeen == nil || *writeSeen {
			balance = big.NewInt(100)
		}
		return multicallChannelStateResult(t, balance, big.NewInt(0), 0, big.NewInt(0)), nil
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheMissSuccessLeavesNoEntry(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	writeSeen := false
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, &writeSeen),
		writeContract: func(string, ...interface{}) (string, error) {
			writeSeen = true
			return "0x" + strings.Repeat("ab", 32), nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }

	resp, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil)
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got %+v", resp)
	}

	if _, ok, _ := store.Get(context.Background(), sig); ok {
		t.Error("successful settlement must not leave a pending entry")
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheMissReceiptFailurePopulatesStore(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	wantTxHash := "0x" + strings.Repeat("ab", 32)
	signer := &fakeFacilitatorSigner{
		addresses:     []string{"0xfacilitator"},
		readContract:  depositConfirmedChannelStateReader(t, nil),
		writeContract: func(string, ...interface{}) (string, error) { return wantTxHash, nil },
		waitForReceipt: func(string) (*evm.TransactionReceipt, error) {
			return nil, errors.New("rpc: timeout waiting for receipt")
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }

	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrSettlementPending {
		t.Fatalf("got err = %v, want settlement_pending", err)
	}
	if se.Transaction != wantTxHash {
		t.Fatalf("transaction = %q, want %q", se.Transaction, wantTxHash)
	}

	txHash, ok, _ := store.Get(context.Background(), sig)
	if !ok {
		t.Fatal("receipt-wait failure must populate the pending-settlement store")
	}
	if txHash != wantTxHash {
		t.Errorf("stored tx hash = %q, want %q", txHash, wantTxHash)
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheHitReconcilesWithoutRebroadcast(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	if err := store.Set(context.Background(), sig, priorTxHash); err != nil {
		t.Fatalf("store.Set: %v", err)
	}
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, nil),
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}

	resp, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil)
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success || resp.Transaction != priorTxHash {
		t.Fatalf("expected reconciled success with tx %q, got %+v", priorTxHash, resp)
	}
	if signer.writeCalls != 0 {
		t.Errorf("reconciliation fast path must never re-broadcast, got %d WriteContract calls", signer.writeCalls)
	}

	if _, ok, _ := store.Get(context.Background(), sig); ok {
		t.Error("successful reconciliation must clear the pending entry")
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheHitStillPendingReturnsAgainWithoutRebroadcast(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	if err := store.Set(context.Background(), sig, priorTxHash); err != nil {
		t.Fatalf("store.Set: %v", err)
	}
	signer := &fakeFacilitatorSigner{
		addresses:      []string{"0xfacilitator"},
		readContract:   depositConfirmedChannelStateReader(t, nil),
		waitForReceipt: func(string) (*evm.TransactionReceipt, error) { return nil, errors.New("rpc: still pending") },
	}

	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil)
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrSettlementPending {
		t.Fatalf("got err = %v, want settlement_pending", err)
	}
	if se.Transaction != priorTxHash {
		t.Fatalf("transaction = %q, want %q", se.Transaction, priorTxHash)
	}
	if signer.writeCalls != 0 {
		t.Errorf("reconciliation fast path must never re-broadcast, got %d WriteContract calls", signer.writeCalls)
	}

	txHash, ok, _ := store.Get(context.Background(), sig)
	if !ok || txHash != priorTxHash {
		t.Errorf("expected pending entry to persist with tx %q, got ok=%v tx=%q", priorTxHash, ok, txHash)
	}
}

func TestSettleDeposit_PendingSettlementStore_NilStoreDisablesFastPath(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	writeSeen := false
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, &writeSeen),
		writeContract: func(string, ...interface{}) (string, error) {
			writeSeen = true
			return "0x" + strings.Repeat("ab", 32), nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }

	resp, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success, got %+v", resp)
	}
}

// spyDelegatedAuth records bound and reverted open tokens and can inject failures.
type spyDelegatedAuth struct {
	*storage.InMemoryDelegatedAuthStore
	bindErr        error
	revertErr      error
	boundTokens    []string
	boundReceivers []string
	revertedToken  []string
}

func newSpyDelegatedAuth() *spyDelegatedAuth {
	return &spyDelegatedAuth{InMemoryDelegatedAuthStore: storage.NewInMemoryDelegatedAuthStore()}
}

func (s *spyDelegatedAuth) Bind(ctx context.Context, binding storage.DelegatedAuthBinding) (bool, error) {
	if s.bindErr != nil {
		return false, s.bindErr
	}
	s.boundTokens = append(s.boundTokens, binding.OpenToken)
	s.boundReceivers = append(s.boundReceivers, binding.Receiver)
	return s.InMemoryDelegatedAuthStore.Bind(ctx, binding)
}

func (s *spyDelegatedAuth) RevertBind(ctx context.Context, channelId, network, openToken string) error {
	s.revertedToken = append(s.revertedToken, openToken)
	if s.revertErr != nil {
		return s.revertErr
	}
	return s.InMemoryDelegatedAuthStore.RevertBind(ctx, channelId, network, openToken)
}

// recordingPendingStore records every key written to the wrapped store.
type recordingPendingStore struct {
	x402.PendingSettlementStore
	setKeys []string
}

func (s *recordingPendingStore) Set(ctx context.Context, key, value string) error {
	s.setKeys = append(s.setKeys, key)
	return s.PendingSettlementStore.Set(ctx, key, value)
}

func delegatedBinding(store storage.DelegatedAuthStore) *DelegatedDepositBinding {
	return &DelegatedDepositBinding{Store: store, CallerIdentity: "svc"}
}

func delegatedDepositSigner(t *testing.T, write func(string, ...interface{}) (string, error), wait func(string) (*evm.TransactionReceipt, error)) *fakeFacilitatorSigner {
	t.Helper()
	return &fakeFacilitatorSigner{
		addresses: []string{"0xfacilitator"},
		getBalance: func(string, string) (*big.Int, error) {
			return big.NewInt(1000), nil
		},
		readContract:   depositConfirmedChannelStateReader(t, nil),
		writeContract:  write,
		waitForReceipt: wait,
	}
}

func requireDelegatedBinding(t *testing.T, store storage.DelegatedAuthStore, channelId, identity string) {
	t.Helper()
	got, err := store.Get(context.Background(), channelId, testNetwork)
	if err != nil {
		t.Fatal(err)
	}
	if identity == "" {
		if got != nil {
			t.Fatalf("binding = %+v, want none", got)
		}
		return
	}
	if got == nil || got.CallerIdentity != identity {
		t.Fatalf("binding = %+v, want %s", got, identity)
	}
}

// pendingThenRevertedSigner times out the first receipt wait, then reports a revert.
func pendingThenRevertedSigner(t *testing.T, txHash string) *fakeFacilitatorSigner {
	t.Helper()
	waits := 0
	return delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return txHash, nil },
		func(hash string) (*evm.TransactionReceipt, error) {
			waits++
			if waits == 1 {
				return nil, errors.New("rpc: timeout")
			}
			return &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: hash}, nil
		},
	)
}

func requireSettleErrorReason(t *testing.T, err error, reason string) *x402.SettleError {
	t.Helper()
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != reason {
		t.Fatalf("got err = %v, want %s", err, reason)
	}
	return se
}

func TestSettleDeposit_DelegatedBindErrorDoesNotBroadcast(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	auth.bindErr = errors.New("mongo down")
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		func(string) (*evm.TransactionReceipt, error) { return nil, errors.New("unused") },
	)
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrVoucherStoreUnavailable)
	if signer.writeCalls != 0 || signer.sendCalls != 0 {
		t.Fatalf("bind error must not broadcast, writes=%d sends=%d", signer.writeCalls, signer.sendCalls)
	}
	if len(auth.revertedToken) != 0 {
		t.Fatalf("a failed bind has nothing to revert, got %v", auth.revertedToken)
	}
}

func TestSettleDeposit_DelegatedIdentityConflictDoesNotBroadcastOrTouchBinding(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	if _, err := auth.InMemoryDelegatedAuthStore.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: payload.Voucher.ChannelId, Network: testNetwork, CallerIdentity: "other", OpenToken: "creator-token",
	}); err != nil {
		t.Fatal(err)
	}
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		nil,
	)
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrDelegatedSettleUnauthenticated)
	if signer.writeCalls != 0 {
		t.Fatalf("conflict must not broadcast, writes=%d", signer.writeCalls)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "other")
	// The creator can still revert after the conflict.
	if err := auth.InMemoryDelegatedAuthStore.RevertBind(context.Background(), payload.Voucher.ChannelId, testNetwork, "creator-token"); err != nil {
		t.Fatal(err)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
}

func TestSettleDeposit_BroadcastFailureRevertsCreatedBinding(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "", errors.New("rpc down") },
		nil,
	)
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrDepositTransactionFailed)
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
	if len(auth.boundTokens) != 1 || auth.boundTokens[0] != depositOpenToken(sig) {
		t.Fatalf("bound tokens = %v, want derived token for the authorization", auth.boundTokens)
	}
	wantReceiver := payload.ChannelConfig.Receiver
	if len(auth.boundReceivers) != 1 || wantReceiver == "" || auth.boundReceivers[0] != wantReceiver {
		t.Fatalf("bound receivers = %v, want %q", auth.boundReceivers, wantReceiver)
	}
}

func TestSettleDeposit_ExistingBindingSurvivesBroadcastFailure(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	if _, err := auth.InMemoryDelegatedAuthStore.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: payload.Voucher.ChannelId, Network: testNetwork, CallerIdentity: "svc",
	}); err != nil {
		t.Fatal(err)
	}
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "", errors.New("rpc down") },
		nil,
	)
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrDepositTransactionFailed)
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
	if len(auth.revertedToken) != 0 {
		t.Fatalf("an existing binding must not be reverted, got %v", auth.revertedToken)
	}
}

func TestSettleDeposit_RevertFailureIsReportedToOnStorageError(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	auth.revertErr = errors.New("mongo down")
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "", errors.New("rpc down") },
		nil,
	)
	var reportedErr error
	var reportedNetwork, reportedChannel string
	binding := delegatedBinding(auth)
	binding.OnStorageError = func(err error, network, channelId string) {
		reportedErr, reportedNetwork, reportedChannel = err, network, channelId
	}
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, binding)
	requireSettleErrorReason(t, err, ErrDepositTransactionFailed)
	if !errors.Is(reportedErr, auth.revertErr) || reportedNetwork != testNetwork || reportedChannel != payload.Voucher.ChannelId {
		t.Fatalf("OnStorageError got (%v, %q, %q)", reportedErr, reportedNetwork, reportedChannel)
	}
}

func TestSettleDeposit_SettlementPendingKeepsBindingAndWritesOnlyTheTxEntry(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	pending := &recordingPendingStore{PendingSettlementStore: x402.NewInMemoryPendingSettlementStore()}
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		func(string) (*evm.TransactionReceipt, error) { return nil, errors.New("rpc: timeout") },
	)
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrSettlementPending)
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
	if len(pending.setKeys) != 1 || pending.setKeys[0] != sig {
		t.Fatalf("pending store keys written = %v, want only the authorization key", pending.setKeys)
	}
	if len(auth.revertedToken) != 0 {
		t.Fatalf("pending must not revert, got %v", auth.revertedToken)
	}
}

func TestSettleDeposit_ReconcileTerminalFailureRevertsCreatedBinding(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	pending := x402.NewInMemoryPendingSettlementStore()
	signer := pendingThenRevertedSigner(t, "0x"+strings.Repeat("ab", 32))

	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrSettlementPending)

	_, _, err = SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrTransactionReverted)
	if signer.writeCalls != 1 {
		t.Fatalf("reconcile writes = %d, want 1", signer.writeCalls)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
	if len(auth.revertedToken) != 1 || auth.revertedToken[0] != depositOpenToken(sig) {
		t.Fatalf("reverted tokens = %v, want the derived token", auth.revertedToken)
	}
}

func TestSettleDeposit_ReconcileTerminalFailureKeepsBindingAfterSameIdentityRebind(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	pending := x402.NewInMemoryPendingSettlementStore()
	signer := pendingThenRevertedSigner(t, "0x"+strings.Repeat("ab", 32))

	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrSettlementPending)

	// A second deposit by the same identity depends on the binding.
	created, err := auth.InMemoryDelegatedAuthStore.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: payload.Voucher.ChannelId, Network: testNetwork, CallerIdentity: "svc", OpenToken: "second",
	})
	if err != nil || created {
		t.Fatalf("second bind: created=%v err=%v", created, err)
	}

	_, _, err = SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrTransactionReverted)
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
}

func TestSettleDeposit_ReconcileConfirmedKeepsBindingAndClearsPendingEntry(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	pending := x402.NewInMemoryPendingSettlementStore()
	txHash := "0x" + strings.Repeat("ab", 32)
	waits := 0
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return txHash, nil },
		func(hash string) (*evm.TransactionReceipt, error) {
			waits++
			if waits == 1 {
				return nil, errors.New("rpc: timeout")
			}
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: hash}, nil
		},
	)
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	requireSettleErrorReason(t, err, ErrSettlementPending)

	resp, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	if err != nil || !resp.Success || resp.Transaction != txHash {
		t.Fatalf("reconcile resp=%+v err=%v", resp, err)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
	if _, ok, _ := pending.Get(context.Background(), sig); ok {
		t.Fatal("confirmed reconcile must clear the pending entry")
	}
	if len(auth.revertedToken) != 0 {
		t.Fatalf("confirmed reconcile must not revert, got %v", auth.revertedToken)
	}
}

func TestSettleDeposit_SuccessKeepsBinding(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := newSpyDelegatedAuth()
	pending := &recordingPendingStore{PendingSettlementStore: x402.NewInMemoryPendingSettlementStore()}
	writeSeen := false
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, &writeSeen),
		writeContract: func(string, ...interface{}) (string, error) {
			writeSeen = true
			return "0x" + strings.Repeat("ab", 32), nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }
	resp, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, delegatedBinding(auth))
	if err != nil || !resp.Success {
		t.Fatalf("got resp=%+v err=%v", resp, err)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
	if len(pending.setKeys) != 0 {
		t.Fatalf("success must not write pending-store keys, got %v", pending.setKeys)
	}
}

func TestSettleDeposit_InvalidVerifyDoesNotBindOrBroadcast(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	payload.Voucher.Signature = "0x" + strings.Repeat("11", 65)
	auth := newSpyDelegatedAuth()
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		nil,
	)
	_, _, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, delegatedBinding(auth))
	var se *x402.SettleError
	if !errors.As(err, &se) {
		t.Fatalf("got err = %v, want settle error", err)
	}
	if signer.writeCalls != 0 || signer.sendCalls != 0 {
		t.Fatalf("invalid deposit must not broadcast, writes=%d sends=%d", signer.writeCalls, signer.sendCalls)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
	if len(auth.boundTokens) != 0 {
		t.Fatalf("invalid deposit must not bind, got %v", auth.boundTokens)
	}
}
