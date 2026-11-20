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

// refundChain is a channel holding 10000 at refund nonce 0. The first broadcast lands a
// 1000 refund, after which a refund simulation reverts as the consumed nonce would onchain.
type refundChain struct {
	signer      *fakeFacilitatorSigner
	simulations int
	receipts    []receiptOutcome
}

func newRefundChain(t *testing.T, receipts ...receiptOutcome) *refundChain {
	t.Helper()
	channelId := refundPendingChannelId(t)
	chain := &refundChain{receipts: receipts}
	landed := false
	chain.signer = &fakeFacilitatorSigner{
		addresses: []string{validConfig().ReceiverAuthorizer},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			switch functionName {
			case evm.FunctionTryAggregate:
				if landed {
					return multicallChannelStateResult(t, big.NewInt(9000), big.NewInt(0), 0, big.NewInt(1)), nil
				}
				return multicallChannelStateResult(t, big.NewInt(10000), big.NewInt(0), 0, big.NewInt(0)), nil
			case "refund", "refundWithSignature":
				chain.simulations++
				if landed {
					return nil, errors.New("execution reverted")
				}
				return nil, nil
			default:
				return nil, errors.New("unexpected rpc " + functionName)
			}
		},
		writeContract: func(string, ...interface{}) (string, error) {
			landed = true
			return refundPendingTxHash, nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
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
					Logs: []*goethtypes.Log{refundedReceiptLog(t, channelId, big.NewInt(1000))}}, nil
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
// relay mode, and as the authorizer submitter in direct mode.
func refundPendingScheme(t *testing.T, mode SubmitMode, chain *refundChain, store x402.PendingSettlementStore) *BatchSettlementEvmScheme {
	t.Helper()
	authorizer := &fakeAuthorizerSigner{addr: validConfig().ReceiverAuthorizer}
	signer := chain.signer
	config := &BatchSettlementEvmSchemeConfig{SubmitMode: mode, PendingSettlementStore: store}
	if mode == SubmitModeDirect {
		signer = &fakeFacilitatorSigner{addresses: []string{"0xfacilitator"}}
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

// recordedRefundTx returns the transaction stored under the single key the refund recorded.
func recordedRefundTx(t *testing.T, store *recordingPendingStore) (string, bool) {
	t.Helper()
	if len(store.setKeys) != 1 {
		t.Fatalf("pending store keys written = %v, want exactly one", store.setKeys)
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

func TestRefundPendingSettlement_ReceiptWaitFailureRecordsTx(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)

			resp, err := settleRefund(scheme, refundPendingPayload(t, "1000", "0"))
			requireRefundPending(t, resp, err)
			txHash, ok := recordedRefundTx(t, store)
			if !ok || txHash != refundPendingTxHash {
				t.Fatalf("recorded tx = %q ok=%v, want %q", txHash, ok, refundPendingTxHash)
			}
		})
	}
}

func TestRefundPendingSettlement_RetryReconcilesWithoutResimulating(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout, receiptConfirmed)
			store := newRecordingPendingStore()
			scheme := refundPendingScheme(t, mode, chain, store)
			payload := refundPendingPayload(t, "1000", "0")

			resp, err := settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)

			resp, err = settleRefund(scheme, payload)
			if err != nil {
				t.Fatalf("retry: %v", err)
			}
			if !resp.Success || resp.Transaction != refundPendingTxHash || resp.Amount != "1000" {
				t.Fatalf("retry resp = %+v, want success for %q refunding 1000", resp, refundPendingTxHash)
			}
			if resp.Payer != validConfig().Payer {
				t.Fatalf("payer = %q, want %q", resp.Payer, validConfig().Payer)
			}
			state, _ := resp.Extra["channelState"].(map[string]interface{})
			if state["channelId"] != refundPendingChannelId(t) || state["balance"] != "9000" ||
				state["totalClaimed"] != "0" || state["refundNonce"] != "1" || state["withdrawRequestedAt"] != 0 {
				t.Fatalf("channelState = %+v, want the post-refund onchain state", state)
			}
			if chain.simulations != 1 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want 1 each across both attempts", chain.simulations, chain.signer.writeCalls)
			}
			if _, ok := recordedRefundTx(t, store); ok {
				t.Fatal("confirmed reconcile must clear the pending entry")
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
			store.setKeys = nil

			resp, err = settleRefund(scheme, payload)
			requireRefundPending(t, resp, err)
			if chain.simulations != 1 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want 1 each across both attempts", chain.simulations, chain.signer.writeCalls)
			}
			txHash, ok := recordedRefundTx(t, store)
			if !ok || txHash != refundPendingTxHash {
				t.Fatalf("re-recorded tx = %q ok=%v, want %q", txHash, ok, refundPendingTxHash)
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

func TestRefundPendingSettlement_NilStoreKeepsResimulatingOnRetry(t *testing.T) {
	for _, mode := range refundSubmitModes {
		t.Run(string(mode), func(t *testing.T) {
			chain := newRefundChain(t, receiptTimeout)
			submitCtx := SubmitContext{
				SubmitMode:          mode,
				Signer:              chain.signer,
				AuthorizerSigner:    &fakeAuthorizerSigner{addr: validConfig().ReceiverAuthorizer},
				AuthorizerSubmitter: chain.signer,
			}
			input := SubmitRefundInput{Network: testNetwork, Payload: refundPendingPayload(t, "1000", "0")}

			resp, err := SubmitRefund(context.Background(), input, submitCtx)
			requireRefundPending(t, resp, err)

			resp, err = SubmitRefund(context.Background(), input, submitCtx)
			if err != nil {
				t.Fatalf("retry: %v", err)
			}
			if resp.Success || resp.ErrorReason != ErrRefundSimulationFailed {
				t.Fatalf("retry resp = %+v, want %s", resp, ErrRefundSimulationFailed)
			}
			if chain.simulations != 2 || chain.signer.writeCalls != 1 {
				t.Fatalf("simulations=%d writes=%d, want 2 and 1", chain.simulations, chain.signer.writeCalls)
			}
		})
	}
}

func TestRefundPendingSettlement_DifferentRefundMissesRecordedTx(t *testing.T) {
	cases := []struct {
		name        string
		amount      string
		refundNonce string
	}{
		{name: "amount", amount: "500", refundNonce: "0"},
		{name: "refundNonce", amount: "1000", refundNonce: "1"},
	}
	for _, mode := range refundSubmitModes {
		for _, tc := range cases {
			t.Run(string(mode)+"/"+tc.name, func(t *testing.T) {
				chain := newRefundChain(t, receiptTimeout)
				store := newRecordingPendingStore()
				scheme := refundPendingScheme(t, mode, chain, store)

				resp, err := settleRefund(scheme, refundPendingPayload(t, "1000", "0"))
				requireRefundPending(t, resp, err)

				resp, err = settleRefund(scheme, refundPendingPayload(t, tc.amount, tc.refundNonce))
				if err != nil {
					t.Fatalf("different refund: %v", err)
				}
				if resp.Success || resp.ErrorReason != ErrRefundSimulationFailed {
					t.Fatalf("different refund resp = %+v, want %s from the normal path", resp, ErrRefundSimulationFailed)
				}
				if chain.simulations != 2 {
					t.Fatalf("simulations = %d, want 2", chain.simulations)
				}
				txHash, ok := recordedRefundTx(t, store)
				if !ok || txHash != refundPendingTxHash {
					t.Fatalf("original entry = %q ok=%v, want it kept for its own retry", txHash, ok)
				}
			})
		}
	}
}
