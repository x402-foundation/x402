package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"

	goethtypes "github.com/ethereum/go-ethereum/core/types"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

// Exercises the PendingSettlementStore fast path wired into SubmitRefund: a refund whose
// receipt wait fails records its transaction, and a retry of the same refund reconciles
// against it instead of simulating a refund that already landed.

var refundPendingTxHash = "0x" + strings.Repeat("ef", 32)

var refundSubmitModes = []SubmitMode{SubmitModeRelay, SubmitModeDirect}

type receiptOutcome int

const (
	receiptTimeout receiptOutcome = iota
	receiptConfirmed
	receiptReverted
	receiptWithoutRefunded
)

// refundChain is a channel holding 10000 at refund nonce 0. Each refund broadcast lands
// at once and advances the nonce. refundWithSignature simulations revert on a consumed
// nonce; refund() has no nonce and simulates fine, as onchain. staleReads post-refund
// channel reads still return the initial state, as a lagging RPC node would.
type refundChain struct {
	signer      *fakeFacilitatorSigner
	simulations int
	staleReads  int
	receipts    []receiptOutcome
	// onWait runs at the start of each receipt wait.
	onWait func()
}

func newRefundChain(t *testing.T, receipts ...receiptOutcome) *refundChain {
	t.Helper()
	channelId := refundPendingChannelId(t)
	chain := &refundChain{receipts: receipts}
	balance := big.NewInt(10000)
	refundNonce := big.NewInt(0)
	refunded := big.NewInt(0)
	chain.signer = &fakeFacilitatorSigner{
		addresses: []string{validConfig().ReceiverAuthorizer},
		readContract: func(functionName string, args ...interface{}) (interface{}, error) {
			switch functionName {
			case evm.FunctionTryAggregate:
				if refundNonce.Sign() > 0 && chain.staleReads > 0 {
					chain.staleReads--
					return multicallChannelStateResult(t, big.NewInt(10000), big.NewInt(0), 0, big.NewInt(0)), nil
				}
				return multicallChannelStateResult(t, balance, big.NewInt(0), 0, refundNonce), nil
			case "refundWithSignature":
				chain.simulations++
				if nonce, _ := args[2].(*big.Int); nonce == nil || nonce.Cmp(refundNonce) != 0 {
					return nil, errors.New("execution reverted: InvalidRefundNonce")
				}
				return nil, nil
			case "refund":
				chain.simulations++
				return nil, nil
			default:
				return nil, errors.New("unexpected rpc " + functionName)
			}
		},
		writeContract: func(_ string, args ...interface{}) (string, error) {
			_, amount, ok := refundCallFromArgs(args)
			if !ok {
				t.Fatalf("unexpected refund write args %v", args)
			}
			refunded = amount
			balance = new(big.Int).Sub(balance, amount)
			refundNonce = new(big.Int).Add(refundNonce, big.NewInt(1))
			return refundPendingTxHash, nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			if chain.onWait != nil {
				chain.onWait()
			}
			if len(chain.receipts) == 0 {
				t.Fatal("unexpected receipt wait")
			}
			outcome := chain.receipts[0]
			chain.receipts = chain.receipts[1:]
			switch outcome {
			case receiptTimeout:
				return nil, errors.New("rpc: timeout waiting for receipt")
			case receiptConfirmed:
				return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash,
					Logs: []*goethtypes.Log{refundedReceiptLog(t, channelId, refunded)}}, nil
			case receiptReverted:
				return &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: txHash}, nil
			case receiptWithoutRefunded:
				return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
			}
			t.Fatalf("unknown receipt outcome %d", outcome)
			return nil, nil
		},
	}
	return chain
}

func refundPendingChannelId(t *testing.T) string {
	t.Helper()
	channelId, err := batchsettlement.ComputeChannelId(validConfig(), testNetwork)
	if err != nil {
		t.Fatalf("channel id: %v", err)
	}
	return channelId
}

func refundPendingPayload(t *testing.T, amount, refundNonce string) *batchsettlement.BatchSettlementEnrichedRefundPayload {
	t.Helper()
	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: validConfig(),
		Amount:        amount,
		RefundNonce:   refundNonce,
	}
	payload.Voucher.ChannelId = refundPendingChannelId(t)
	return payload
}

// refundPendingScheme submits refunds through chain.signer: as the facilitator signer in
// relay mode, and as the authorizer submitter in direct mode, where the facilitator signer
// reads the same chain but cannot broadcast.
func refundPendingScheme(t *testing.T, mode SubmitMode, chain *refundChain, store x402.PendingSettlementStore) *BatchSettlementEvmScheme {
	t.Helper()
	authorizer := &fakeAuthorizerSigner{addr: validConfig().ReceiverAuthorizer}
	signer := chain.signer
	config := &BatchSettlementEvmSchemeConfig{SubmitMode: mode, PendingSettlementStore: store}
	if mode == SubmitModeDirect {
		signer = &fakeFacilitatorSigner{
			addresses:      []string{"0xfacilitator"},
			readContract:   chain.signer.readContract,
			waitForReceipt: chain.signer.waitForReceipt,
		}
		config.AuthorizerSubmitter = chain.signer
	}
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, authorizer, config)
	if err != nil {
		t.Fatalf("new scheme: %v", err)
	}
	return scheme
}

func settleRefund(scheme *BatchSettlementEvmScheme, payload *batchsettlement.BatchSettlementEnrichedRefundPayload) (*x402.SettleResponse, error) {
	return scheme.Settle(context.Background(), payloadEnvelope(testNetwork, payload.ToMap()), reqsFor(testNetwork), nil)
}

func newRecordingPendingStore() *recordingPendingStore {
	return &recordingPendingStore{PendingSettlementStore: x402.NewInMemoryPendingSettlementStore()}
}

// recordedRefundTx returns the transaction stored under the first key a refund recorded.
func recordedRefundTx(t *testing.T, store *recordingPendingStore) (string, bool) {
	t.Helper()
	if len(store.setKeys) == 0 {
		t.Fatal("no refund was recorded in the pending store")
	}
	txHash, ok, err := store.Get(context.Background(), store.setKeys[0])
	if err != nil {
		t.Fatalf("store.Get: %v", err)
	}
	return txHash, ok
}

func requireRefundPending(t *testing.T, resp *x402.SettleResponse, err error) {
	t.Helper()
	se := requireSettleErrorReason(t, err, ErrSettlementPending)
	if resp != nil {
		t.Fatalf("resp = %+v, want nil with settlement_pending", resp)
	}
	if se.Transaction != refundPendingTxHash {
		t.Fatalf("transaction = %q, want %q", se.Transaction, refundPendingTxHash)
	}
}

func requireRefundReconciled(t *testing.T, resp *x402.SettleResponse, err error, amount, balance string) {
	t.Helper()
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !resp.Success || resp.Transaction != refundPendingTxHash || resp.Amount != amount || resp.Payer != validConfig().Payer {
		t.Fatalf("retry resp = %+v, want success for %q refunding %s", resp, refundPendingTxHash, amount)
	}
	state, _ := resp.Extra["channelState"].(map[string]interface{})
	if state["channelId"] != refundPendingChannelId(t) || state["balance"] != balance ||
		state["totalClaimed"] != "0" || state["refundNonce"] != "1" || state["withdrawRequestedAt"] != 0 {
		t.Fatalf("channelState = %+v, want the post-refund onchain state with balance %s", state, balance)
	}
}

func TestRefundPendingSettlement_ReceiptWaitFailureRecordsTx(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)

			resp, err := settleRefund(scheme, refundPendingPayload(t, "1000", "0"))
			requireRefundPending(t, resp, err)
			if len(store.setKeys) != 1 {
				t.Fatalf("pending store keys written = %v, want exactly one", store.setKeys)
			}
			txHash, ok := recordedRefundTx(t, store)
			if !ok || txHash != refundPendingTxHash {
				t.Fatalf("recorded tx = %q ok=%v, want %q", txHash, ok, refundPendingTxHash)
			}
		})
	}
}

func TestRefundPendingSettlement_RetryReconcilesWithoutResimulating(t *testing.T) {
	cases := []struct {
		name    string
		amount  string
		balance string
	}{
		{name: "partial", amount: "1000", balance: "9000"},
		{name: "full", amount: "10000", balance: "0"},
	}
	for _, mode := range refundSubmitModes {
		for _, tc := range cases {
			t.Run(string(mode)+"/"+tc.name, func(t *testing.T) {
				chain := newRefundChain(t, receiptTimeout, receiptConfirmed)
				store := newRecordingPendingStore()
				scheme := refundPendingScheme(t, mode, chain, store)
				payload := refundPendingPayload(t, tc.amount, "0")

				resp, err := settleRefund(scheme, payload)
				requireRefundPending(t, resp, err)

				resp, err = settleRefund(scheme, payload)
				requireRefundReconciled(t, resp, err, tc.amount, tc.balance)
				if chain.simulations != 1 || chain.signer.writeCalls != 1 {
					t.Fatalf("simulations=%d writes=%d, want 1 each across both attempts", chain.simulations, chain.signer.writeCalls)
				}
				if _, ok := recordedRefundTx(t, store); ok {
					t.Fatal("confirmed reconcile must clear the pending entry")
				}
			})
		}
	}
}

func TestRefundPendingSettlement_ConcurrentRetryWaitsOnSameTx(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptConfirmed, receiptConfirmed)
			scheme := refundPendingScheme(t, mode, chain, newRecordingPendingStore())
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)

			var concurrent *x402.SettleResponse
			var concurrentErr error
			chain.onWait = func() {
				chain.onWait = nil
				concurrent, concurrentErr = settleRefund(scheme, payload)
			}
			resp, err = settleRefund(scheme, payload)
			requireRefundReconciled(t, resp, err, "1000", "9000")
			requireRefundReconciled(t, concurrent, concurrentErr, "1000", "9000")
			if chain.signer.writeCalls != 1 {
				t.Fatalf("writes = %d, want the first broadcast only", chain.signer.writeCalls)
			}
		})
	}
}

func TestRefundPendingSettlement_RetryWaitsOutLaggingChannelRead(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptConfirmed)
			scheme := refundPendingScheme(t, mode, chain, newRecordingPendingStore())
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)

			chain.staleReads = 1
			resp, err = settleRefund(scheme, payload)
			requireRefundReconciled(t, resp, err, "1000", "9000")
		})
	}
}

func TestRefundPendingSettlement_RetryWithUnobservedRefundStaysPending(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptConfirmed, receiptConfirmed)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)

			chain.staleReads = 1 << 20
			resp, err = settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)
			if _, ok := recordedRefundTx(t, store); !ok {
				t.Fatal("a refund whose post-state is not visible must stay recorded")
			}

			chain.staleReads = 0
			resp, err = settleRefund(scheme, payload)
			requireRefundReconciled(t, resp, err, "1000", "9000")
			if chain.signer.writeCalls != 1 {
				t.Fatalf("writes = %d, want the first broadcast only", chain.signer.writeCalls)
			}
		})
	}
}

func TestRefundPendingSettlement_RetryStillUnconfirmedStaysPending(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptTimeout)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)
			recorded := store.setKeys
			store.setKeys = nil

			resp, err = settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)
			if chain.simulations != 1 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want 1 each across both attempts", chain.simulations, chain.signer.writeCalls)
			}
			if len(store.setKeys) != 0 {
				t.Fatalf("pending store keys rewritten = %v, want the recorded entry left as is", store.setKeys)
			}
			store.setKeys = recorded
			if txHash, ok := recordedRefundTx(t, store); !ok || txHash != refundPendingTxHash {
				t.Fatalf("recorded tx = %q ok=%v, want %q kept", txHash, ok, refundPendingTxHash)
			}
		})
	}
}

func TestRefundPendingSettlement_RetryRevertedIsTerminal(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptReverted)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)

			_, err = settleRefund(scheme, payload)
			se := requireSettleErrorReason(t, err, ErrTransactionReverted)
			if se.Transaction != refundPendingTxHash {
				t.Fatalf("transaction = %q, want %q", se.Transaction, refundPendingTxHash)
			}
			if chain.simulations != 1 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want 1 each across both attempts", chain.simulations, chain.signer.writeCalls)
			}
			if _, ok := recordedRefundTx(t, store); ok {
				t.Fatal("reverted reconcile must clear the pending entry")
			}
		})
	}
}

func TestRefundPendingSettlement_RetryWithoutRefundedEventFailsClosed(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptWithoutRefunded)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)

			resp, err = settleRefund(scheme, payload)
			if err != nil {
				t.Fatalf("retry: %v", err)
			}
			if resp.Success || resp.ErrorReason != ErrRefundedEventMismatch || resp.Transaction != refundPendingTxHash {
				t.Fatalf("retry resp = %+v, want %s for %q", resp, ErrRefundedEventMismatch, refundPendingTxHash)
			}
			if _, ok := recordedRefundTx(t, store); ok {
				t.Fatal("confirmed receipt must clear the pending entry")
			}
		})
	}
}

func TestRefundPendingSettlement_NilStoreResimulatesOnRetry(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptTimeout)
			submitCtx := SubmitContext{
				SubmitMode:          mode,
				Signer:              chain.signer,
				AuthorizerSigner:    &fakeAuthorizerSigner{addr: validConfig().ReceiverAuthorizer},
				AuthorizerSubmitter: chain.signer,
			}
			input := SubmitRefundInput{Network: testNetwork, Payload: refundPendingPayload(t, "1000", "0")}

			resp, err := SubmitRefund(context.Background(), input, submitCtx)
			requireRefundPending(t, resp, err)

			_, _ = SubmitRefund(context.Background(), input, submitCtx)
			if chain.simulations != 2 {
				t.Fatalf("simulations = %d, want the retry to simulate again", chain.simulations)
			}
		})
	}
}

// The managed channel holds 10000 with 5000 charged, so a refund is capped at 5000. Once the
// first refund lands, the retry's fresh cap is the same, lower, or exhausted.
func TestRefundPendingSettlement_ManagedRetryReconcilesRecomputedAmount(t *testing.T) {
	cases := []struct {
		name   string
		amount string
	}{
		{name: "cap unchanged", amount: "100"},
		{name: "cap lowered", amount: "4000"},
		{name: "cap exhausted", amount: "5000"},
	}
	for _, mode := range refundSubmitModes {
		for _, tc := range cases {
			t.Run(string(mode)+"/"+tc.name, func(t *testing.T) {
				h := newHotRefund(t, unclaimedFields(), workerMarker(), nil)
				rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(1000)}
				signer := newManagedSigner(t, rpc)
				write := signer.writeContract
				signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
					_, amount, ok := refundCallFromArgs(args)
					if !ok {
						t.Fatalf("unexpected refund write args %v", args)
					}
					landed := new(big.Int).Sub(rpc.balance, amount)
					txHash, err := write(functionName, args...)
					rpc.balance = landed
					// The consumed refund nonce reverts refundWithSignature; refund() has no nonce check.
					rpc.simFail = "refundWithSignature"
					return txHash, err
				}
				wait := signer.waitForReceipt
				waits := 0
				signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
					waits++
					if waits == 1 {
						return nil, errors.New("rpc: timeout waiting for receipt")
					}
					return wait(txHash)
				}
				h.deps.Signer = signer
				h.deps.SubmitMode = mode
				h.deps.AuthorizerSubmitter = signer

				_, err := h.settle(tc.amount)
				requireSettleErrorReason(t, err, ErrSettlementPending)

				reads := rpc.tryAggregate
				resp, err := h.settle(tc.amount)
				if err != nil || !resp.Success || resp.Transaction != successTxHash || resp.Amount != tc.amount {
					t.Fatalf("retry resp = %+v err = %v, want success for %q refunding %s", resp, err, successTxHash, tc.amount)
				}
				if signer.writeCalls != 1 {
					t.Fatalf("writes = %d, want the first broadcast only", signer.writeCalls)
				}
				if got := rpc.tryAggregate - reads; got != 1 {
					t.Fatalf("retry channel reads = %d, want only the post-refund read", got)
				}
				if entries := h.deps.PendingStore.(*x402.InMemoryPendingSettlementStore).Entries(); len(entries) != 0 {
					t.Fatalf("pending entries = %v, want the reconciled refund cleared", entries)
				}
			})
		}
	}
}

func TestRefundPendingSettlement_NewRefundNonceMissesRecordedTx(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptTimeout)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)

			resp, err := settleRefund(scheme, refundPendingPayload(t, "1000", "0"))
			requireRefundPending(t, resp, err)

			_, _ = settleRefund(scheme, refundPendingPayload(t, "1000", "1"))
			if chain.simulations != 2 {
				t.Fatalf("simulations = %d, want the next refund to simulate", chain.simulations)
			}
			txHash, ok := recordedRefundTx(t, store)
			if !ok || txHash != refundPendingTxHash {
				t.Fatalf("original entry = %q ok=%v, want it kept for its own retry", txHash, ok)
			}
		})
	}
}

// refundWithSignature consumes the refund nonce, so a retry at the same nonce can only ever
// resolve to the recorded refund, whatever amount it asks for.
func TestRefundPendingSettlement_SameRefundNonceReconcilesRecordedRefund(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptConfirmed)
			scheme := refundPendingScheme(t, mode, chain, newRecordingPendingStore())

			resp, err := settleRefund(scheme, refundPendingPayload(t, "1000", "0"))
			requireRefundPending(t, resp, err)

			resp, err = settleRefund(scheme, refundPendingPayload(t, "500", "0"))
			requireRefundReconciled(t, resp, err, "1000", "9000")
			if chain.simulations != 1 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want 1 each across both attempts", chain.simulations, chain.signer.writeCalls)
			}
		})
	}
}

type failingGetPendingStore struct {
	x402.PendingSettlementStore
	getErr error
}

func (s *failingGetPendingStore) Get(ctx context.Context, key string) (string, bool, error) {
	if s.getErr != nil {
		return "", false, s.getErr
	}
	return s.PendingSettlementStore.Get(ctx, key)
}

func TestRefundPendingSettlement_StoreGetErrorFailsClosed(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptConfirmed)
			inner := newRecordingPendingStore()
			store := &failingGetPendingStore{PendingSettlementStore: inner}
			scheme := refundPendingScheme(t, mode, chain, store)
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)

			store.getErr = errors.New("pending store unavailable")
			resp, err = settleRefund(scheme, payload)
			se := requireSettleErrorReason(t, err, ErrRefundTransactionFailed)
			if resp != nil || se.Transaction != "" {
				t.Fatalf("resp = %+v tx = %q, want nil response and empty transaction", resp, se.Transaction)
			}
			if chain.simulations != 1 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want no second simulate or broadcast", chain.simulations, chain.signer.writeCalls)
			}

			store.getErr = nil
			resp, err = settleRefund(scheme, payload)
			requireRefundReconciled(t, resp, err, "1000", "9000")
			if chain.simulations != 1 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want 1 each across all attempts", chain.simulations, chain.signer.writeCalls)
			}
		})
	}
}

func TestRefundPendingSettlement_ManagedStoreGetErrorFailsClosed(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			h := newHotRefund(t, unclaimedFields(), workerMarker(), nil)
			rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(1000)}
			signer := newManagedSigner(t, rpc)
			wait := signer.waitForReceipt
			waits := 0
			signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
				waits++
				if waits == 1 {
					return nil, errors.New("rpc: timeout waiting for receipt")
				}
				return wait(txHash)
			}
			store := &failingGetPendingStore{PendingSettlementStore: x402.NewInMemoryPendingSettlementStore()}
			h.deps.Signer = signer
			h.deps.SubmitMode = mode
			h.deps.AuthorizerSubmitter = signer
			h.deps.PendingStore = store

			_, err := h.settle("100")
			requireSettleErrorReason(t, err, ErrSettlementPending)

			store.getErr = errors.New("pending store unavailable")
			reads := rpc.tryAggregate
			resp, err := h.settle("100")
			se := requireSettleErrorReason(t, err, ErrRefundTransactionFailed)
			if resp != nil || se.Transaction != "" {
				t.Fatalf("resp = %+v tx = %q, want nil response and empty transaction", resp, se.Transaction)
			}
			if rpc.tryAggregate != reads || signer.writeCalls != 1 {
				t.Fatalf("reads=%d->%d writes=%d, want no channel read or second broadcast", reads, rpc.tryAggregate, signer.writeCalls)
			}

			store.getErr = nil
			resp, err = h.settle("100")
			if err != nil || !resp.Success || resp.Transaction != successTxHash || resp.Amount != "100" {
				t.Fatalf("retry resp = %+v err = %v, want success for %q refunding 100", resp, err, successTxHash)
			}
			if signer.writeCalls != 1 {
				t.Fatalf("writes = %d, want the first broadcast only", signer.writeCalls)
			}
		})
	}
}

type spySettleTargets struct {
	*storage.InMemorySettleTargetStorage
	deltas []storage.SettleTargetClaimDelta
}

func newSpySettleTargets() *spySettleTargets {
	return &spySettleTargets{InMemorySettleTargetStorage: storage.NewInMemorySettleTargetStorage()}
}

func (s *spySettleTargets) RecordClaimed(ctx context.Context, delta storage.SettleTargetClaimDelta) error {
	s.deltas = append(s.deltas, delta)
	return s.InMemorySettleTargetStorage.RecordClaimed(ctx, delta)
}

func TestRefundPendingSettlement_ManagedBundledClaimRetryFinalizesBookkeeping(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			h := newHotRefund(t, unclaimedFields(), nil, nil)
			rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(1000)}
			signer := newManagedSigner(t, rpc)
			wait := signer.waitForReceipt
			waits := 0
			signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
				waits++
				if waits == 1 {
					return nil, errors.New("rpc: timeout waiting for receipt")
				}
				rpc.totalClaimed = big.NewInt(5000)
				rpc.balance = big.NewInt(5000)
				return wait(txHash)
			}
			targets := newSpySettleTargets()
			h.deps.Signer = signer
			h.deps.SubmitMode = mode
			h.deps.AuthorizerSubmitter = signer
			h.deps.SettleTargetStorage = targets

			_, err := h.settle("5000")
			requireSettleErrorReason(t, err, ErrSettlementPending)
			if len(signer.writeFns) != 1 || signer.writeFns[0] != "multicall" {
				t.Fatalf("writes = %v, want one bundled multicall", signer.writeFns)
			}
			if got := h.row(); got.PendingClaim == nil || got.PendingClaim.TxHash != successTxHash || got.ChargeCount != 6 {
				t.Fatalf("after timeout: row = %+v, want pending claim with tx %q and chargeCount 6", got, successTxHash)
			}
			if len(targets.deltas) != 0 {
				t.Fatalf("settle target deltas before confirm = %v, want none", targets.deltas)
			}

			resp, err := h.settle("5000")
			if err != nil || !resp.Success || resp.Transaction != successTxHash || resp.Amount != "5000" {
				t.Fatalf("retry resp = %+v err = %v, want success for %q refunding 5000", resp, err, successTxHash)
			}
			if signer.writeCalls != 1 {
				t.Fatalf("writes = %d, want the first broadcast only", signer.writeCalls)
			}
			if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 0 || got.TotalClaimed != "5000" {
				t.Fatalf("after retry: row = %+v, want cleared pending claim, chargeCount 0, totalClaimed 5000", got)
			}
			if got := extraInt(resp, "chargeCount"); got != 0 {
				t.Fatalf("response chargeCount = %d, want 0", got)
			}
			if len(targets.deltas) != 1 || targets.deltas[0].Amount.String() != "4000" {
				t.Fatalf("settle target deltas = %+v, want one delta of 4000", targets.deltas)
			}
			page, err := targets.ListSettleTargets(context.Background(), storage.SettleQuery{Network: managedNetwork, Limit: intPtr(10)})
			if err != nil || len(page.Items) != 1 {
				t.Fatalf("settle targets = %+v err = %v, want 1 target", page, err)
			}
			if entries := h.deps.PendingStore.(*x402.InMemoryPendingSettlementStore).Entries(); len(entries) != 0 {
				t.Fatalf("pending entries = %v, want cleared", entries)
			}
		})
	}
}

func TestRefundPendingSettlement_ManagedBundledClaimRetryNoOpAndRevert(t *testing.T) {
	t.Run("noop claim leg keeps charge count pending", func(t *testing.T) {
		for _, mode := range refundSubmitModes {
			t.Run(string(mode), func(t *testing.T) {
				h := newHotRefund(t, unclaimedFields(), nil, nil)
				rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(1000)}
				signer := newManagedSigner(t, rpc)
				wait := signer.waitForReceipt
				waits := 0
				signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
					waits++
					if waits == 1 {
						return nil, errors.New("rpc: timeout waiting for receipt")
					}
					rpc.totalClaimed = big.NewInt(5000)
					rpc.balance = big.NewInt(5000)
					receipt, recErr := wait(txHash)
					if receipt == nil {
						return receipt, recErr
					}
					return withoutClaimedLogs(receipt), recErr
				}
				targets := newSpySettleTargets()
				h.deps.Signer = signer
				h.deps.SubmitMode = mode
				h.deps.AuthorizerSubmitter = signer
				h.deps.SettleTargetStorage = targets

				_, err := h.settle("5000")
				requireSettleErrorReason(t, err, ErrSettlementPending)

				resp, err := h.settle("5000")
				if err != nil || !resp.Success {
					t.Fatalf("retry resp = %+v err = %v, want success", resp, err)
				}
				if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 6 || got.TotalClaimed != "5000" {
					t.Fatalf("after no-op retry: row = %+v, want cleared pending claim and chargeCount 6", got)
				}
				if len(targets.deltas) != 1 || targets.deltas[0].Amount.String() != "4000" {
					t.Fatalf("settle target deltas = %+v, want one delta of 4000", targets.deltas)
				}
			})
		}
	})

	t.Run("reverted retry clears pending claim marker", func(t *testing.T) {
		for _, mode := range refundSubmitModes {
			t.Run(string(mode), func(t *testing.T) {
				h := newHotRefund(t, unclaimedFields(), nil, nil)
				rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(1000)}
				signer := newManagedSigner(t, rpc)
				waits := 0
				signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
					waits++
					if waits == 1 {
						return nil, errors.New("rpc: timeout waiting for receipt")
					}
					return &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: txHash}, nil
				}
				targets := newSpySettleTargets()
				h.deps.Signer = signer
				h.deps.SubmitMode = mode
				h.deps.AuthorizerSubmitter = signer
				h.deps.SettleTargetStorage = targets

				_, err := h.settle("5000")
				requireSettleErrorReason(t, err, ErrSettlementPending)

				_, err = h.settle("5000")
				requireSettleErrorReason(t, err, ErrTransactionReverted)
				if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 6 || got.TotalClaimed != "1000" {
					t.Fatalf("after reverted retry: row = %+v, want cleared pending claim and untouched counts", got)
				}
				if len(targets.deltas) != 0 {
					t.Fatalf("settle target deltas = %+v, want none on revert", targets.deltas)
				}
			})
		}
	})

	t.Run("refund-only retry does not touch worker marker or start a new claim", func(t *testing.T) {
		for _, mode := range refundSubmitModes {
			t.Run(string(mode), func(t *testing.T) {
				marker := workerMarker()
				h := newHotRefund(t, unclaimedFields(), marker, nil)
				rpc := &managedRPC{balance: big.NewInt(10000), totalClaimed: big.NewInt(1000)}
				signer := newManagedSigner(t, rpc)
				wait := signer.waitForReceipt
				waits := 0
				var markerOnRetry *PendingClaim
				signer.waitForReceipt = func(txHash string) (*evm.TransactionReceipt, error) {
					waits++
					if waits == 1 {
						return nil, errors.New("rpc: timeout waiting for receipt")
					}
					markerOnRetry = h.row().PendingClaim
					return wait(txHash)
				}
				targets := newSpySettleTargets()
				h.deps.Signer = signer
				h.deps.SubmitMode = mode
				h.deps.AuthorizerSubmitter = signer
				h.deps.SettleTargetStorage = targets

				_, err := h.settle("5000")
				requireSettleErrorReason(t, err, ErrSettlementPending)

				// Worker finishes between attempt 1 and attempt 2, leaving unclaimed charges behind.
				item := attestedClaim{ChannelID: h.channelID, Count: marker.AttestedCount, ClaimedTo: marker.ClaimedTo, StartedAt: marker.StartedAt}
				if finishErr := finishAttestedClaim(context.Background(), h.inner, h.channelID, "3000", item, true); finishErr != nil {
					t.Fatal(finishErr)
				}

				resp, err := h.settle("5000")
				if err != nil || !resp.Success {
					t.Fatalf("retry resp = %+v err = %v, want success", resp, err)
				}
				if markerOnRetry != nil {
					t.Fatalf("retry wrote a new pending claim marker %+v for a refund-only tx", markerOnRetry)
				}
				if got := h.row(); got.PendingClaim != nil || got.ChargeCount != 2 || got.TotalClaimed != "3000" {
					t.Fatalf("after refund-only retry: row = %+v, want worker result untouched", got)
				}
				if len(targets.deltas) != 0 {
					t.Fatalf("settle target deltas = %+v, want none for refund-only tx", targets.deltas)
				}
			})
		}
	})
}
