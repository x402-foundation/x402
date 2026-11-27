package facilitator

import (
	"context"
	"sync"
	"testing"
	"testing/synctest"
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

	t.Run("never rebroadcasts under concurrent retries and answers a late one duplicate_settlement", func(t *testing.T) {
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
		var reconciled int
		for _, result := range []durableResult{first, second} {
			if result.OK {
				reconciled++
				assert.Equal(t, recordedSignature, result.Signature)
				continue
			}
			require.NotNil(t, result.Response)
			assert.Equal(t, ChannelBusy, result.Response.ErrorReason)
			assert.Empty(t, result.Response.Transaction)
		}
		assert.GreaterOrEqual(t, reconciled, 1, "the retry that found the pending record finishes it")
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
		assert.Equal(t, recordedSignature, result.Response.Transaction)
		got, ok, err := store.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, encodeBroadcastRecord(recordedSignature, "", "wire"), got, "the timeout record keeps the signed transaction")
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
		cfg.PayoutStore = cfg.PendingSettlementStore
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

	t.Run("a payout record is stored before the hook and deleted after it, in two writes", func(t *testing.T) {
		scheme, counts := counted(t, &Config{})
		store := scheme.payoutStore
		var hookRuns int
		scheme.config.OnDistributionConfirmed = func(ctx context.Context, _ *x402.SettleResponse, _ types.PaymentRequirements) error {
			_, stored, err := store.Get(ctx, resultKey("k"))
			require.NoError(t, err)
			assert.True(t, stored, "the record is durable before the hook runs")
			hookRuns++
			return nil
		}
		response := &x402.SettleResponse{Success: true, Transaction: signature, Network: x402.Network(network)}
		require.NoError(t, storePayoutResult(context.Background(), store, "k", response))
		require.Nil(t, scheme.completePayout(context.Background(), "k", response, types.PaymentRequirements{}))
		assert.Equal(t, 1, hookRuns)
		_, stored, err := store.Get(context.Background(), resultKey("k"))
		require.NoError(t, err)
		assert.False(t, stored, "the record is deleted once the hook has run")
		assert.Equal(t, 1, counts.sets)
		assert.Equal(t, 1, counts.deletes)
	})

	t.Run("a failing hook keeps the payout record for a retry", func(t *testing.T) {
		scheme, counts := counted(t, &Config{})
		store := scheme.payoutStore
		scheme.config.OnDistributionConfirmed = func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error {
			return assert.AnError
		}
		response := &x402.SettleResponse{Success: true, Transaction: signature, Network: x402.Network(network)}
		require.NoError(t, storePayoutResult(context.Background(), store, "k", response))
		pending := scheme.completePayout(context.Background(), "k", response, types.PaymentRequirements{})
		require.NotNil(t, pending)
		assert.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)
		assert.Equal(t, signature, pending.Transaction)
		_, stored, err := store.Get(context.Background(), resultKey("k"))
		require.NoError(t, err)
		assert.True(t, stored)
		assert.Zero(t, counts.deletes)
	})
}

func TestLosingReservationAnswersDuplicateSettlement(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	payer := mustKey(t).PublicKey().String()
	holderSignature := solana.Signature{5}.String()
	const key = "batch:claim:test"

	store := x402.NewInMemoryPendingSettlementStore()
	signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 1}
	scheme := NewBatchSvmScheme(context.Background(), signer, &Config{PendingSettlementStore: store})
	_, reserved, err := scheme.duplicateStore.Reserve(context.Background(), key, holderSignature, ReservationTTL)
	require.NoError(t, err)
	require.True(t, reserved)

	result, err := scheme.broadcastUnchecked(context.Background(), key, network, payer, func(onPrepared func(string, string) error) (string, error) {
		return "", onPrepared(solana.Signature{6}.String(), "wire")
	})
	require.NoError(t, err)
	assert.False(t, result.OK)
	assert.Empty(t, result.Signature)
	require.NotNil(t, result.Response)
	assert.False(t, result.Response.Success)
	assert.Equal(t, ChannelBusy, result.Response.ErrorReason)
	assert.Empty(t, result.Response.Transaction, "a loser never reports the holder's signature")
	assert.Empty(t, signer.confirmCalls(), "a loser does not reconcile the holder's broadcast")
	_, ok, err := store.Get(context.Background(), key)
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestNewBatchSvmSchemeDefaultStores(t *testing.T) {
	t.Run("the pending store keeps the shared five-minute TTL and a payout record outlives it", func(t *testing.T) {
		hook := func(context.Context, *x402.SettleResponse, types.PaymentRequirements) error { return nil }
		scheme := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), &Config{OnDistributionConfirmed: hook})
		synctest.Test(t, func(t *testing.T) {
			ctx := context.Background()
			require.NoError(t, scheme.pendingStore.Set(ctx, "batch:seal:k", "sig"))
			require.NoError(t, scheme.payoutStore.Set(ctx, resultKey("batch:seal:k"), `{"success":true}`))

			time.Sleep(x402.PendingSettlementTTL + time.Second)
			_, ok, err := scheme.pendingStore.Get(ctx, "batch:seal:k")
			require.NoError(t, err)
			assert.False(t, ok)
			_, ok, err = scheme.payoutStore.Get(ctx, resultKey("batch:seal:k"))
			require.NoError(t, err)
			assert.True(t, ok, "a payout must outlive the pending TTL so a failing hook can be retried")

			time.Sleep(PayoutRetention)
			_, ok, err = scheme.payoutStore.Get(ctx, resultKey("batch:seal:k"))
			require.NoError(t, err)
			assert.False(t, ok, "payout records are still bounded")
		})
	})

	t.Run("no payout store without OnDistributionConfirmed", func(t *testing.T) {
		scheme := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), &Config{})
		assert.Nil(t, scheme.payoutStore)
	})
}

func TestDistributionKeys(t *testing.T) {
	prepared := []PreparedDistribution{{ChannelID: "chan-b"}, {ChannelID: "chan-a"}}
	key := distributionKey("net", prepared)
	assert.Equal(t, "batch:distribute:net:chan-a,chan-b", key, "channel order does not change the key")
	pass := func(settledB, settledA uint64) string {
		return distributionPassKey(key, prepared, []*generated.Channel{
			{Settlement: generated.SettlementWatermarks{Settled: settledB}},
			{Settlement: generated.SettlementWatermarks{Settled: settledA}},
		})
	}
	assert.Equal(t, "batch:distribute:net:chan-a,chan-b:pass:chan-a:7,chan-b:5", pass(5, 7))
	assert.NotEqual(t, pass(5, 7), pass(5, 8), "a new claim starts a new pass")
	assert.Empty(t, distributionPassKey(key, prepared, []*generated.Channel{nil, {}}), "no pass starts while a channel is absent")
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
