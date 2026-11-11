package facilitator

import (
	"context"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestBatchSettlementPendingSettlement(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	const key = "batch:claim:test"
	payer := mustKey(t).PublicKey().String()
	recorded := solana.Signature{1}
	recordedSignature := recorded.String()

	facilitator := func(t *testing.T, store x402.PendingSettlementStore) *BatchSvmScheme {
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

	t.Run("reconciles a recorded broadcast instead of repeating it and clears the record", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
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
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
	})

	t.Run("keeps the record until the reconcile knows the outcome", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
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
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
	})

	t.Run("has both concurrent retries reconcile rather than rebroadcast", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		require.NoError(t, store.Set(context.Background(), key, recordedSignature))
		scheme := facilitator(t, store)
		_, reserved, err := scheme.duplicateStore.Reserve(context.Background(), key, recordedSignature, ReservationTTL)
		require.NoError(t, err)
		require.True(t, reserved)
		var broadcasts int
		var mu sync.Mutex
		attempt := func() durableResult {
			result, err := scheme.broadcastDurably(context.Background(), key, network, payer, func(onPrepared func(string, string) error) (string, error) {
				if err := onPrepared("fresh-signature", "wire"); err != nil {
					return "", err
				}
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

	t.Run("reserves the signature before the send and writes no pending record on success", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		scheme := facilitator(t, store)
		var heldMidFlight string
		_, err := scheme.broadcastDurably(context.Background(), key, network, payer, func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared("in-flight-signature", "wire"))
			holder, reserved, err := scheme.duplicateStore.Reserve(context.Background(), key, "other-signature", ReservationTTL)
			require.NoError(t, err)
			require.False(t, reserved)
			heldMidFlight = holder
			return "in-flight-signature", nil
		})
		require.NoError(t, err)
		assert.Equal(t, "in-flight-signature", heldMidFlight)
		_, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.False(t, ok)
	})

	t.Run("records the pending signature when the confirmation times out", func(t *testing.T) {
		store := x402.NewInMemoryPendingSettlementStore()
		scheme := facilitator(t, store)
		result, err := scheme.broadcastDurably(context.Background(), key, network, payer, func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared(recordedSignature, "wire"))
			return "", &paymentchannels.SettlementConfirmationTimeoutError{Signature: recordedSignature}
		})
		require.NoError(t, err)
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, recordedSignature, got)
	})
}

type storeWatchSigner struct {
	*confirmingSigner
	store x402.PendingSettlementStore
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

type opCounts struct {
	mu       sync.Mutex
	gets     int
	sets     int
	deletes  int
	reserves int
	releases int
}

func (c *opCounts) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gets + c.sets + c.deletes + c.reserves + c.releases
}

type countingPendingStore struct {
	x402.PendingSettlementStore
	counts *opCounts
}

func (s *countingPendingStore) Get(ctx context.Context, key string) (string, bool, error) {
	s.counts.mu.Lock()
	s.counts.gets++
	s.counts.mu.Unlock()
	return s.PendingSettlementStore.Get(ctx, key)
}

func (s *countingPendingStore) Set(ctx context.Context, key, value string) error {
	s.counts.mu.Lock()
	s.counts.sets++
	s.counts.mu.Unlock()
	return s.PendingSettlementStore.Set(ctx, key, value)
}

func (s *countingPendingStore) Delete(ctx context.Context, key string) error {
	s.counts.mu.Lock()
	s.counts.deletes++
	s.counts.mu.Unlock()
	return s.PendingSettlementStore.Delete(ctx, key)
}

type countingDuplicateStore struct {
	svm.DuplicateSettlementStore
	counts *opCounts
}

func (s *countingDuplicateStore) Reserve(ctx context.Context, key, signature string, ttl time.Duration) (string, bool, error) {
	s.counts.mu.Lock()
	s.counts.reserves++
	s.counts.mu.Unlock()
	return s.DuplicateSettlementStore.Reserve(ctx, key, signature, ttl)
}

func (s *countingDuplicateStore) Release(ctx context.Context, key, signature string) error {
	s.counts.mu.Lock()
	s.counts.releases++
	s.counts.mu.Unlock()
	return s.DuplicateSettlementStore.Release(ctx, key, signature)
}

func TestSettleStorageOperationCounts(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	payer := mustKey(t).PublicKey().String()
	signature := solana.Signature{3}.String()

	counted := func(t *testing.T, cfg *Config) (*BatchSvmScheme, *opCounts) {
		t.Helper()
		counts := &opCounts{}
		cfg.PendingSettlementStore = &countingPendingStore{PendingSettlementStore: x402.NewInMemoryPendingSettlementStore(), counts: counts}
		cfg.DuplicateSettlementStore = &countingDuplicateStore{DuplicateSettlementStore: svm.NewInMemoryDuplicateSettlementStore(), counts: counts}
		signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 1}
		return NewBatchSvmScheme(context.Background(), signer, cfg), counts
	}

	t.Run("a confirmed broadcast costs one pending read and one reservation", func(t *testing.T) {
		scheme, counts := counted(t, &Config{})
		result, err := scheme.broadcastDurably(context.Background(), "batch:claim:test", network, payer, func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared(signature, "wire"))
			return signature, nil
		})
		require.NoError(t, err)
		require.True(t, result.OK)
		assert.Equal(t, 1, counts.gets)
		assert.Equal(t, 1, counts.reserves)
		assert.Zero(t, counts.sets)
		assert.Zero(t, counts.deletes)
		assert.Zero(t, counts.releases)
		assert.Equal(t, 2, counts.total())
	})

	t.Run("a definitive send failure adds one release and no pending write", func(t *testing.T) {
		scheme, counts := counted(t, &Config{})
		_, err := scheme.broadcastUnchecked(context.Background(), "batch:claim:test", network, payer, func(onPrepared func(string, string) error) (string, error) {
			require.NoError(t, onPrepared(signature, "wire"))
			return "", assert.AnError
		})
		require.Error(t, err)
		assert.Equal(t, 1, counts.releases)
		assert.Zero(t, counts.sets)
	})

	t.Run("a distribution without OnDistributionConfirmed writes no result or recorded marker", func(t *testing.T) {
		scheme, counts := counted(t, &Config{})
		response := &x402.SettleResponse{Success: true, Transaction: signature}
		require.NoError(t, scheme.keepPayoutResult(context.Background(), "batch:distribute:test", response))
		require.NoError(t, scheme.recordPayout(context.Background(), "batch:distribute:test", response, types.PaymentRequirements{}))
		assert.Zero(t, counts.total())
	})

	t.Run("a distribution with OnDistributionConfirmed stores the result before the hook and the recorded marker after it", func(t *testing.T) {
		var order []string
		scheme, _ := counted(t, &Config{})
		store := scheme.pendingStore
		scheme.config.OnDistributionConfirmed = func(ctx context.Context, _ *x402.SettleResponse, _ types.PaymentRequirements) error {
			_, stored, err := store.Get(ctx, resultKey("k"))
			require.NoError(t, err)
			assert.True(t, stored, "the result is durable before the hook runs")
			_, recorded, err := store.Get(ctx, recordedKey("k"))
			require.NoError(t, err)
			assert.False(t, recorded)
			order = append(order, "hook")
			return nil
		}
		response := &x402.SettleResponse{Success: true, Transaction: signature, Network: x402.Network(network)}
		require.NoError(t, scheme.keepPayoutResult(context.Background(), "k", response))
		require.NoError(t, scheme.recordPayout(context.Background(), "k", response, types.PaymentRequirements{}))
		require.NoError(t, scheme.recordPayout(context.Background(), "k", response, types.PaymentRequirements{}))
		assert.Equal(t, []string{"hook"}, order, "the hook sees each payout once")
		_, recorded, err := store.Get(context.Background(), recordedKey("k"))
		require.NoError(t, err)
		assert.True(t, recorded)
	})
}

func TestDistributionKeyFollowsTheSettledWatermark(t *testing.T) {
	prepared := []PreparedDistribution{{ChannelID: "chan-b"}, {ChannelID: "chan-a"}}
	at := func(settledB, settledA uint64) string {
		return distributionKey("net", prepared, []*generated.Channel{
			{Settlement: generated.SettlementWatermarks{Settled: settledB}},
			{Settlement: generated.SettlementWatermarks{Settled: settledA}},
		})
	}
	assert.Equal(t, "batch:distribute:net:chan-a:7,chan-b:5", at(5, 7), "channel order does not change the key")
	assert.NotEqual(t, at(5, 7), at(5, 8), "a new claim starts a new pass")
}

func TestDecodeWithMessageHashIgnoresSignatures(t *testing.T) {
	feePayer := mustKey(t)
	other := mustKey(t)
	build := func(signer solana.PrivateKey) string {
		tx, err := solana.NewTransaction(
			[]solana.Instruction{solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), nil, []byte{1})},
			solana.MustHashFromBase58("11111111111111111111111111111111"),
			solana.TransactionPayer(signer.PublicKey()),
		)
		require.NoError(t, err)
		_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
			if key.Equals(signer.PublicKey()) {
				return &signer
			}
			return nil
		})
		require.NoError(t, err)
		wire, err := svm.EncodeTransaction(tx)
		require.NoError(t, err)
		return wire
	}
	_, first, err := decodeWithMessageHash(build(feePayer))
	require.NoError(t, err)
	_, again, err := decodeWithMessageHash(build(feePayer))
	require.NoError(t, err)
	_, different, err := decodeWithMessageHash(build(other))
	require.NoError(t, err)
	assert.Equal(t, first, again)
	assert.NotEqual(t, first, different)

	_, _, err = decodeWithMessageHash("not-a-transaction")
	assert.Error(t, err)
}
