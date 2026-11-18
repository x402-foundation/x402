package facilitator

import (
	"context"
	"sync"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func TestBatchSettlementPendingSettlement(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	const key = "batch:claim:test"
	payer := mustKey(t).PublicKey().String()
	recorded := solana.Signature{1}
	recordedSignature := recorded.String()

	facilitator := func(t *testing.T, store PendingSettlementStore) *BatchSvmScheme {
		t.Helper()
		signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 432}
		return NewBatchSvmScheme(context.Background(), signer, &Config{
			PendingSettlementStore: store,
		})
	}

	for _, kind := range []string{"redemption", "open"} {
		t.Run("does not repeat the successful confirmation RPC for "+kind, func(t *testing.T) {
			signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 432}
			scheme := NewBatchSvmScheme(context.Background(), signer, nil)
			instruction := solana.NewInstruction(
				solana.MustPublicKeyFromBase58(svm.MemoProgramAddress),
				nil,
				[]byte("RPC budget"),
			)
			result, err := scheme.submitRedemption(context.Background(), signer.feePayer().String(), network, []solana.Instruction{instruction}, "redemption", payer)
			require.NoError(t, err)
			require.True(t, result.OK)

			if kind == "open" {
				signer.mu.Lock()
				signer.calls = nil
				signer.mu.Unlock()
				sent := signer.sentTransactions()
				require.NotEmpty(t, sent)
				wire, err := svm.EncodeTransaction(sent[0])
				require.NoError(t, err)
				broadcast, err := scheme.broadcastDurably(context.Background(), "open", network, payer, func(onPrepared func(string, string) error) (string, error) {
					return paymentchannels.BroadcastOpen(context.Background(), scheme.signer, signer.feePayer(), network, wire, paymentchannels.ChannelBroadcastHooks{
						OnPrepared: onPrepared,
					})
				})
				require.NoError(t, err)
				require.True(t, broadcast.OK)
			}

			calls := signer.confirmCalls()
			require.Len(t, calls, 1)
			assert.Nil(t, calls[0].opts)

			_, err = scheme.readChannel(context.Background(), network, signer.feePayer().String())
			require.NoError(t, err)
			accountCalls := signer.accountCalls()
			require.NotEmpty(t, accountCalls)
			last := accountCalls[len(accountCalls)-1]
			require.NotNil(t, last.opts)
			require.NotNil(t, last.opts.MinContextSlot)
			assert.Equal(t, uint64(432), *last.opts.MinContextSlot)

			signer.mu.Lock()
			signer.calls = nil
			signer.mu.Unlock()
			recovered, err := scheme.reconcileBroadcast(context.Background(), kind, result.Signature, network, payer)
			require.NoError(t, err)
			require.True(t, recovered.OK)
			calls = signer.confirmCalls()
			require.Len(t, calls, 1)
			require.NotNil(t, calls[0].opts)
			assert.True(t, calls[0].opts.SearchTransactionHistory)
		})
	}

	t.Run("reconciles a recorded broadcast instead of repeating it", func(t *testing.T) {
		store := NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, recordedSignature))
		scheme := facilitator(t, store)
		broadcasts := 0
		result, err := scheme.broadcastDurably(context.Background(), key, network, payer, func(func(string, string) error) (string, error) {
			broadcasts++
			return "fresh-signature", nil
		})
		require.NoError(t, err)
		assert.True(t, result.OK)
		assert.Equal(t, recordedSignature, result.Signature)
		assert.Zero(t, broadcasts)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, recordedSignature, got)
	})

	t.Run("keeps the record until the reconcile knows the outcome", func(t *testing.T) {
		store := NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, recordedSignature))
		signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 1}
		var recordDuringConfirm string
		signer.confirmErr = nil
		scheme := NewBatchSvmScheme(context.Background(), signer, &Config{
			PendingSettlementStore: store,
		})
		wrapped := &storeWatchSigner{confirmingSigner: signer, store: store, key: key, seen: &recordDuringConfirm}
		scheme.raw = wrapped
		scheme.signer = &recordingSigner{PaymentChannelFacilitatorSigner: wrapped, scheme: scheme}

		broadcasts := 0
		result, err := scheme.broadcastDurably(context.Background(), key, network, payer, func(func(string, string) error) (string, error) {
			broadcasts++
			return "fresh-signature", nil
		})
		require.NoError(t, err)
		assert.Equal(t, recordedSignature, recordDuringConfirm)
		assert.True(t, result.OK)
		assert.Equal(t, recordedSignature, result.Signature)
		assert.Zero(t, broadcasts)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, recordedSignature, got)
		require.NoError(t, scheme.completeBroadcast(context.Background(), key, recordedSignature, network))
		_, ok, err = store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
		completed, ok, err := store.Get(context.Background(), key+CompletedBroadcastSuffix)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, recordedSignature, completed)
	})

	t.Run("has both concurrent retries reconcile rather than rebroadcast", func(t *testing.T) {
		store := NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, recordedSignature))
		scheme := facilitator(t, store)
		var broadcasts int
		var mu sync.Mutex
		attempt := func() durableResult {
			result, err := scheme.broadcastDurably(context.Background(), key, network, payer, func(func(string, string) error) (string, error) {
				mu.Lock()
				broadcasts++
				mu.Unlock()
				return "fresh-signature", nil
			})
			require.NoError(t, err)
			return result
		}
		var first, second durableResult
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); first = attempt() }()
		go func() { defer wg.Done(); second = attempt() }()
		wg.Wait()
		assert.Zero(t, broadcasts)
		assert.Equal(t, recordedSignature, first.Signature)
		assert.Equal(t, recordedSignature, second.Signature)
	})

	t.Run("records a broadcast before its confirmation is awaited", func(t *testing.T) {
		store := NewInMemoryPendingSettlementStore()
		scheme := facilitator(t, store)
		var recordedMidFlight string
		_, err := scheme.broadcastDurably(context.Background(), key, network, payer, func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared("in-flight-signature", "wire"))
			got, ok, err := store.Get(context.Background(), key)
			require.NoError(t, err)
			require.True(t, ok)
			recordedMidFlight = got
			return "in-flight-signature", nil
		})
		require.NoError(t, err)
		assert.Equal(t, "in-flight-signature", recordedMidFlight)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, "in-flight-signature", got)
	})
}

type storeWatchSigner struct {
	*confirmingSigner
	store PendingSettlementStore
	key   string
	seen  *string
}

func (s *storeWatchSigner) ConfirmTransactionWithOptions(
	ctx context.Context,
	signature solana.Signature,
	network string,
	opts *svm.FacilitatorConfirmOptions,
) (*svm.FacilitatorConfirmationStatus, error) {
	got, _, _ := s.store.Get(ctx, s.key)
	*s.seen = got
	return s.confirmingSigner.ConfirmTransactionWithOptions(ctx, signature, network, opts)
}
