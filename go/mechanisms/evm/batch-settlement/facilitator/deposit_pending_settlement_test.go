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
)

// Exercises the PendingSettlementStore fast path wired into SettleDeposit (see
// deposit.go): a settle attempt whose receipt wait fails must populate the
// store keyed by the deposit authorization signature; a subsequent settle for
// the identical payload must hit that entry, skip verify/broadcast entirely,
// and reconcile against the already-broadcast transaction via
// reconcilePendingDeposit. Mirrors the TS/Python batch-settlement deposit
// pending-settlement test suites.

func pendingDepositPayload() (string, *batchsettlement.BatchSettlementDepositPayload) {
	channelId := testErc3009ChannelId
	auth := goodErc3009Auth()
	payload := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: goodErc3009Config(),
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          channelId,
			MaxClaimableAmount: "100",
			Signature:          "0x" + strings.Repeat("22", 65),
		},
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "100",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: auth,
			},
		},
	}
	return auth.Signature, payload
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
	sig, payload := pendingDepositPayload()
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

	resp, err := SettleDeposit(context.Background(), signer, payload, reqsFor(testNetwork), nil, nil, nil, nil, store)
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
	sig, payload := pendingDepositPayload()
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

	_, err := SettleDeposit(context.Background(), signer, payload, reqsFor(testNetwork), nil, nil, nil, nil, store)
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
	sig, payload := pendingDepositPayload()
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

	resp, err := SettleDeposit(context.Background(), signer, payload, reqsFor(testNetwork), nil, nil, nil, nil, store)
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
	sig, payload := pendingDepositPayload()
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

	_, err := SettleDeposit(context.Background(), signer, payload, reqsFor(testNetwork), nil, nil, nil, nil, store)
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
	_, payload := pendingDepositPayload()
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

	resp, err := SettleDeposit(context.Background(), signer, payload, reqsFor(testNetwork), nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success, got %+v", resp)
	}
}
