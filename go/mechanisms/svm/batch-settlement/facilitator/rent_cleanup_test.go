package facilitator

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

func TestPaymentChannelReclaimPrimitive(t *testing.T) {
	t.Run("exports OPEN_SLOT_WINDOW and builds reclaim with disc 9", func(t *testing.T) {
		assert.Equal(t, uint64(1500), paymentchannels.OpenSlotWindow)
		assert.Equal(t, generated.AccountDiscriminator(1), generated.AccountDiscriminator_Channel)
		assert.Equal(t, generated.ChannelStatus(0), generated.ChannelStatus_Open)
		assert.Equal(t, generated.ChannelStatus(1), generated.ChannelStatus_Sealed)
		assert.Equal(t, generated.ChannelStatus(2), generated.ChannelStatus_Closing)
		assert.Equal(t, generated.ChannelStatus(3), generated.ChannelStatus_Distributed)
		instruction := paymentchannels.BuildReclaimInstruction(mustKey(t).PublicKey(), mustKey(t).PublicKey())
		data, err := instruction.Data()
		require.NoError(t, err)
		assert.Equal(t, byte(generated.ReclaimDiscriminator), data[0])
		accounts := instruction.Accounts()
		require.Len(t, accounts, 2)
		assert.True(t, accounts[0].IsWritable)
		assert.True(t, accounts[1].IsWritable)
	})
}

func TestBatchChannelStorageAndSchemeWiring(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	const farFuture int64 = 4_102_444_800

	t.Run("records on verify success, retains after settle, deletes when PDA gone", func(t *testing.T) {
		signer, stub := newRPCSigner(t, 1)
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		scheme := NewBatchSvmScheme(context.Background(), signer, &Config{
			ChannelStorage: storage,
		})
		channelID := mustKey(t).PublicKey().String()
		record := paymentchannels.PaymentChannelRecord{
			ChannelID: channelID, PayTo: mustKey(t).PublicKey().String(), TokenProgram: svm.TokenProgramAddress,
			LastActivityAt: time.Now().Add(-time.Duration(paymentchannels.OpenIndexGraceSecs+1) * time.Second),
			ExpiresAt:      farFuture,
			Network:        network,
		}
		_, err := storage.RecordOpen(context.Background(), record)
		require.NoError(t, err)
		got, err := storage.Get(context.Background(), network, channelID)
		require.NoError(t, err)
		assert.Equal(t, record.PayTo, got.PayTo)
		assert.Equal(t, svm.TokenProgramAddress, got.TokenProgram)
		firstActivity := got.LastActivityAt
		record.ExpiresAt = farFuture - 100
		_, err = storage.RecordOpen(context.Background(), record)
		require.NoError(t, err)
		got, err = storage.Get(context.Background(), network, channelID)
		require.NoError(t, err)
		assert.True(t, got.LastActivityAt.After(firstActivity) || got.LastActivityAt.Equal(firstActivity))
		assert.Equal(t, farFuture, got.ExpiresAt)
		_ = stub
		manager := scheme.CreateRentCleanupManager(svm.SolanaDevnetCAIP2)
		require.NoError(t, manager.Cleanup(context.Background(), CleanupOptions{}))
		got, err = storage.Get(context.Background(), network, channelID)
		require.NoError(t, err)
		assert.Nil(t, got)
	})

	t.Run("createRentCleanupManager returns a manager bound to the scheme storage", func(t *testing.T) {
		signer, _ := newRPCSigner(t, 1)
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		manager := NewBatchSvmRentCleanupManager(RentCleanupConfig{Network: network, Signer: signer, Storage: storage})
		require.NotNil(t, manager)
		require.NotNil(t, storage)
	})
}

func TestBatchSvmRentCleanupManagerCleanup(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	const openSlot = uint64(100)
	const farFuture int64 = 4_102_444_800
	day := 24 * time.Hour

	newHarness := func(t *testing.T) *cleanupHarness {
		t.Helper()
		signer, stub := newRPCSigner(t, 1)
		stub.slot = openSlot + paymentchannels.OpenSlotWindow + 1
		h := &cleanupHarness{
			t: t, signer: signer, stub: stub,
			storage: paymentchannels.NewInMemoryPaymentChannelStorage(),
			payer:   mustKey(t).PublicKey(),
			payTo:   mustKey(t).PublicKey(),
		}
		h.manager = NewBatchSvmRentCleanupManager(RentCleanupConfig{
			Network: network, Signer: signer, Storage: h.storage,
		})
		return h
	}

	t.Run("keeps an Open channel with recent lifecycle activity", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: generated.ChannelStatus_Open, expiresAt: 0, firstSeen: time.Now().Add(-30 * day), lastActivity: time.Now().Add(-day)})
		var closes int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnClose: func(CloseResult) { closes++ }}))
		assert.Zero(t, closes)
		assert.Empty(t, h.signer.sentTransactions())
		assert.True(t, h.exists(record.ChannelID))
	})

	t.Run("abandon-closes an Open channel idle for the default window", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{
			status: generated.ChannelStatus_Open, expiresAt: 0,
			firstSeen: time.Now().Add(-30 * day), lastActivity: time.Now().Add(-time.Duration(DefaultMaxIdleSecs)*time.Second - day),
		})
		h.deleteOnSend(record.ChannelID)
		var action CloseAction
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnClose: func(result CloseResult) {
			action = result.Action
			assert.Equal(t, record.ChannelID, result.ChannelID)
		}}))
		assert.Equal(t, CloseActionAbandon, action)
		assert.Len(t, h.signer.sentTransactions(), 1)
	})

	t.Run("honours a per-pass idle window and a zero window disables idle cleanup", func(t *testing.T) {
		h := newHarness(t)
		h.seed(channelSeed{status: generated.ChannelStatus_Open, expiresAt: 0, firstSeen: time.Now().Add(-30 * day), lastActivity: time.Now().Add(-2 * day)})
		zero := int64(0)
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{MaxIdleSecs: &zero}))
		assert.Empty(t, h.signer.sentTransactions())
		daySecs := int64(86_400)
		var action CloseAction
		h.deleteOnSend(h.only().ChannelID)
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{MaxIdleSecs: &daySecs, OnClose: func(result CloseResult) { action = result.Action }}))
		assert.Equal(t, CloseActionAbandon, action)
	})

	t.Run("falls back to firstSeenAt when a record predates activity tracking", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{
			status: generated.ChannelStatus_Open, expiresAt: 0,
			firstSeen: time.Now().Add(-time.Duration(DefaultMaxIdleSecs)*time.Second - day),
		})
		h.deleteOnSend(record.ChannelID)
		var action CloseAction
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnClose: func(result CloseResult) { action = result.Action }}))
		assert.Equal(t, CloseActionAbandon, action)
	})

	t.Run("does not abandon-close Open channels before expiry plus grace", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: generated.ChannelStatus_Open, expiresAt: time.Now().Unix() + 300, firstSeen: time.Now().Add(-time.Minute)})
		var closes int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{AbandonGraceSecs: 120, OnClose: func(CloseResult) { closes++ }}))
		assert.Zero(t, closes)
		assert.Empty(t, h.signer.sentTransactions())
		assert.True(t, h.exists(record.ChannelID))
	})

	t.Run("abandon-closes Open channels after expiry plus grace", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: generated.ChannelStatus_Open, expiresAt: time.Now().Unix() - 200, firstSeen: time.Now().Add(-time.Minute)})
		h.deleteOnSend(record.ChannelID)
		var action CloseAction
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{AbandonGraceSecs: 120, OnClose: func(result CloseResult) { action = result.Action }}))
		assert.Equal(t, CloseActionAbandon, action)
		require.Len(t, h.signer.sentTransactions(), 1)
		assert.GreaterOrEqual(t, len(programInstructions(t, h.signer.sentTransactions()[0])), 2)
		assert.False(t, h.exists(record.ChannelID))
	})

	t.Run("does not abandon-close Open channels before expiresAt even when firstSeen is old", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: generated.ChannelStatus_Open, expiresAt: time.Now().Unix() + 300, firstSeen: time.Now().Add(-2 * time.Hour)})
		var closes int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{AbandonGraceSecs: 120, OnClose: func(CloseResult) { closes++ }}))
		assert.Zero(t, closes)
		assert.Empty(t, h.signer.sentTransactions())
		assert.True(t, h.exists(record.ChannelID))
	})

	t.Run("distributes Sealed channels", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: farFuture})
		h.deleteOnSend(record.ChannelID)
		var action CloseAction
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnClose: func(result CloseResult) { action = result.Action }}))
		assert.Equal(t, CloseActionDistribute, action)
		require.NotEmpty(t, h.signer.sentTransactions())
		assert.Len(t, programInstructions(t, h.signer.sentTransactions()[0]), 1)
	})

	t.Run("defers Closing channels until the onchain grace period elapses", func(t *testing.T) {
		h := newHarness(t)
		h.seed(channelSeed{status: generated.ChannelStatus_Closing, closureStartedAt: time.Now().Unix() - 30, grace: 60, expiresAt: farFuture})
		var closes, reclaims int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			OnClose:   func(CloseResult) { closes++ },
			OnReclaim: func(ReclaimResult) { reclaims++ },
		}))
		assert.Zero(t, closes)
		assert.Zero(t, reclaims)
		assert.Empty(t, h.signer.sentTransactions())
	})

	t.Run("seals and distributes Closing channels after the onchain grace period", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: generated.ChannelStatus_Closing, closureStartedAt: time.Now().Unix() - 60, grace: 60, expiresAt: farFuture})
		h.deleteOnSend(record.ChannelID)
		var action CloseAction
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnClose: func(result CloseResult) { action = result.Action }}))
		assert.Equal(t, CloseActionForced, action)
		instructions := programInstructions(t, h.signer.sentTransactions()[0])
		require.Len(t, instructions, 2)
		assert.Equal(t, byte(generated.SealDiscriminator), instructions[0][0])
		assert.False(t, h.exists(record.ChannelID))
	})

	t.Run("defers Distributed reclaim until the open-slot gate elapses", func(t *testing.T) {
		h := newHarness(t)
		h.stub.slot = openSlot + paymentchannels.OpenSlotWindow
		h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		var reclaims int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnReclaim: func(ReclaimResult) { reclaims++ }}))
		assert.Zero(t, reclaims)
		assert.Empty(t, h.signer.sentTransactions())
	})

	t.Run("batch-reclaims Distributed channels after the open-slot gate", func(t *testing.T) {
		h := newHarness(t)
		a := h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		b := h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		var ids []string
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{MaxReclaimsPerTx: 8, OnReclaim: func(result ReclaimResult) {
			ids = append(ids, result.ChannelIDs...)
		}}))
		assert.ElementsMatch(t, []string{a.ChannelID, b.ChannelID}, ids)
		instructions := programInstructions(t, h.signer.sentTransactions()[0])
		assert.Len(t, instructions, 2)
		for _, data := range instructions {
			assert.Equal(t, byte(generated.ReclaimDiscriminator), data[0])
		}
		assert.Equal(t, paymentchannels.ReclaimComputeUnitLimit(2), computeLimit(t, h.signer.sentTransactions()[0]))
		assert.False(t, h.exists(a.ChannelID))
		assert.False(t, h.exists(b.ChannelID))
	})

	t.Run("reports every channel in a reclaim batch that failed to broadcast", func(t *testing.T) {
		h := newHarness(t)
		a := h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		b := h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		h.signer.sendErr = errString("broadcast failed")
		var ids []string
		var reclaims int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			MaxReclaimsPerTx: 8,
			OnReclaim:        func(ReclaimResult) { reclaims++ },
			OnError:          func(error, string) {},
		}))
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			MaxReclaimsPerTx: 8,
			OnError: func(_ error, channelID string) {
				if channelID != "" {
					ids = append(ids, channelID)
				}
			},
		}))
		assert.Zero(t, reclaims)
		assert.ElementsMatch(t, []string{a.ChannelID, b.ChannelID}, ids)
	})

	t.Run("respects maxReclaimsPerTx and maxTxsPerSigner for reclaim batching", func(t *testing.T) {
		h := newHarness(t)
		for i := 0; i < 3; i++ {
			h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		}
		var batches []int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			MaxReclaimsPerTx: 2, MaxTxsPerSigner: 1,
			OnReclaim: func(result ReclaimResult) { batches = append(batches, len(result.ChannelIDs)) },
		}))
		assert.Equal(t, []int{2}, batches)
		assert.Len(t, h.signer.sentTransactions(), 1)
	})

	t.Run("clamps maxReclaimsPerTx to MAX_SAFE_RECLAIMS_PER_TX", func(t *testing.T) {
		h := newHarness(t)
		for i := 0; i < MaxSafeReclaimsPerTx+1; i++ {
			h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		}
		var sizes []int
		var total int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			MaxReclaimsPerTx: 1_000, MaxTxsPerSigner: 10,
			OnReclaim: func(result ReclaimResult) {
				sizes = append(sizes, len(result.ChannelIDs))
				total += len(result.ChannelIDs)
			},
		}))
		assert.Len(t, sizes, 2)
		assert.Equal(t, MaxSafeReclaimsPerTx, maxInt(sizes))
		assert.Equal(t, MaxSafeReclaimsPerTx+1, total)
	})

	t.Run("falls back to the default when maxReclaimsPerTx is non-positive", func(t *testing.T) {
		h := newHarness(t)
		h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		var reclaims int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{MaxReclaimsPerTx: 0, OnReclaim: func(ReclaimResult) { reclaims++ }}))
		assert.Equal(t, 1, reclaims)
	})

	t.Run("budgets the scan and reclaims separately", func(t *testing.T) {
		h := newHarness(t)
		for i := 0; i < 4; i++ {
			h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		}
		var reclaims int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			MaxReclaimsPerTx: 1, MaxTxsPerRun: 1, MaxTxsPerSigner: 4,
			OnReclaim: func(ReclaimResult) { reclaims++ },
		}))
		assert.Equal(t, 4, reclaims)
	})

	t.Run("skips reclaim when a concurrent settle already changed status (stale refetch)", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: farFuture})
		h.stub.deleteAccountAfter(record.ChannelID, 1)
		var reclaims int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnReclaim: func(ReclaimResult) { reclaims++ }}))
		assert.Zero(t, reclaims)
		assert.Empty(t, h.signer.sentTransactions())
		assert.False(t, h.exists(record.ChannelID))
	})

	t.Run("skips channels with missing payTo and surfaces onError", func(t *testing.T) {
		h := newHarness(t)
		h.seed(channelSeed{status: generated.ChannelStatus_Open, payTo: " ", expiresAt: time.Now().Unix() - 200, firstSeen: time.Now().Add(-2 * time.Hour)})
		var closes int
		var messages []string
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			AbandonGraceSecs: 120,
			OnClose:          func(CloseResult) { closes++ },
			OnError:          func(err error, _ string) { messages = append(messages, err.Error()) },
		}))
		assert.Zero(t, closes)
		require.NotEmpty(t, messages)
		assert.Contains(t, messages[0], "payTo")
	})

	t.Run("still reclaims when the close budget is spent", func(t *testing.T) {
		h := newHarness(t)
		h.seed(channelSeed{status: generated.ChannelStatus_Open, expiresAt: time.Now().Unix() - 200})
		distributed := h.seed(channelSeed{status: generated.ChannelStatus_Distributed, openSlot: openSlot, expiresAt: time.Now().Unix() - 200})
		var ids []string
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			AbandonGraceSecs: 120, MaxClosesPerRun: 0,
			OnReclaim: func(result ReclaimResult) { ids = append(ids, result.ChannelIDs...) },
		}))
		assert.Equal(t, []string{distributed.ChannelID}, ids)
	})

	t.Run("resumes scanning from the cursor after the budget runs out", func(t *testing.T) {
		h := newHarness(t)
		first := h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		second := h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		var closed []string
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{MaxTxsPerRun: 1, OnClose: func(result CloseResult) {
			closed = append(closed, result.ChannelID)
		}}))
		require.Len(t, closed, 1)
		assert.Contains(t, []string{first.ChannelID, second.ChannelID}, closed[0])
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnClose: func(result CloseResult) {
			closed = append(closed, result.ChannelID)
		}}))
		require.GreaterOrEqual(t, len(closed), 2)
		assert.NotEqual(t, closed[0], closed[1])
	})

	t.Run("scans in channel id order regardless of what storage.list returns", func(t *testing.T) {
		h := newHarness(t)
		first := h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		second := h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		lowest := first.ChannelID
		if second.ChannelID < lowest {
			lowest = second.ChannelID
		}
		h.manager = NewBatchSvmRentCleanupManager(RentCleanupConfig{
			Network: network, Signer: h.signer, Storage: reverseStorage{h.storage},
		})
		var closed string
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{MaxTxsPerRun: 1, OnClose: func(result CloseResult) {
			closed = result.ChannelID
		}}))
		assert.Equal(t, lowest, closed)
	})

	t.Run("reports an unrecognized channel status", func(t *testing.T) {
		h := newHarness(t)
		record := h.seed(channelSeed{status: 99, expiresAt: farFuture})
		var message string
		var closes, reclaims int
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{
			OnClose:   func(CloseResult) { closes++ },
			OnReclaim: func(ReclaimResult) { reclaims++ },
			OnError:   func(err error, channelID string) { message = err.Error(); assert.Equal(t, record.ChannelID, channelID) },
		}))
		assert.Contains(t, message, "unrecognized status")
		assert.Zero(t, closes)
		assert.Zero(t, reclaims)
		assert.True(t, h.exists(record.ChannelID))
	})

	t.Run("runs overlapping passes serially", func(t *testing.T) {
		h := newHarness(t)
		h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		var inFlight atomic.Int32
		var overlapped atomic.Bool
		h.signer.holdSend = func() {
			if inFlight.Add(1) > 1 {
				overlapped.Store(true)
			}
			time.Sleep(20 * time.Millisecond)
			inFlight.Add(-1)
		}
		var wg sync.WaitGroup
		for i := 0; i < 3; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{}))
			}()
		}
		wg.Wait()
		assert.False(t, overlapped.Load())
	})

	t.Run("stops a scan in progress at the next record when the caller aborts", func(t *testing.T) {
		h := newHarness(t)
		for i := 0; i < 3; i++ {
			h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		}
		ctx, cancel := context.WithCancel(context.Background())
		h.signer.holdSend = func() { cancel() }
		err := h.manager.Cleanup(ctx, CleanupOptions{})
		require.Error(t, err)
		assert.ErrorIs(t, err, context.Canceled)
		assert.Len(t, h.signer.sentTransactions(), 1)
	})

	t.Run("stop waits for the in-flight pass and does not report the abort as an error", func(t *testing.T) {
		h := newHarness(t)
		h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		h.seed(channelSeed{status: generated.ChannelStatus_Sealed, expiresAt: time.Now().Unix() - 200})
		started := make(chan struct{})
		release := make(chan struct{})
		var once sync.Once
		h.signer.holdSend = func() {
			once.Do(func() { close(started) })
			<-release
		}
		var errors int
		h.manager.Start(context.Background(), StartConfig{
			Interval:           15 * time.Millisecond,
			RentCleanupOptions: paymentchannels.RentCleanupOptions{OnError: func(error, string) { errors++ }},
		})
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("cleanup did not start")
		}
		stopped := make(chan struct{})
		go func() {
			h.manager.Stop()
			close(stopped)
		}()
		select {
		case <-stopped:
			t.Fatal("stop resolved while the broadcast was still outstanding")
		case <-time.After(30 * time.Millisecond):
		}
		close(release)
		select {
		case <-stopped:
		case <-time.After(time.Second):
			t.Fatal("stop did not return after the broadcast finished")
		}
		assert.Zero(t, errors)
	})

	t.Run("stop is idempotent and safe when no pass ever ran", func(t *testing.T) {
		h := newHarness(t)
		h.manager.Stop()
		h.manager.Stop()
		assert.Empty(t, h.signer.sentTransactions())
	})

	t.Run("skips channels whose feePayer is not in the signer set", func(t *testing.T) {
		h := newHarness(t)
		other := mustKey(t).PublicKey()
		h.seed(channelSeed{status: generated.ChannelStatus_Open, expiresAt: time.Now().Unix() - 200, firstSeen: time.Now().Add(-2 * time.Hour), payee: other, rentPayer: other})
		var message string
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{AbandonGraceSecs: 120, OnError: func(err error, _ string) {
			message = err.Error()
		}}))
		assert.Contains(t, message, "facilitator signer set")
		assert.Empty(t, h.signer.sentTransactions())
	})
}

func TestBatchSvmRentCleanupManagerOnchainDiscovery(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	const openSlot = uint64(100)
	const farFuture int64 = 4_102_444_800

	t.Run("adds an untracked Distributed channel to storage for cleanup to reclaim", func(t *testing.T) {
		h := newDiscoveryHarness(t, 1)
		pda := h.discovered(generated.ChannelStatus_Distributed, openSlot, h.signer.feePayer())
		var ids []string
		require.NoError(t, h.manager.Discover(context.Background(), DiscoveryOptions{OnDiscover: func(result DiscoveryResult) {
			ids = append(ids, result.ChannelIDs...)
		}}))
		assert.Equal(t, []string{pda.String()}, ids)
		got, err := h.storage.Get(context.Background(), network, pda.String())
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, pda.String(), got.ChannelID)
		assert.Equal(t, network, got.Network)
		assert.Zero(t, got.ExpiresAt)
		assert.Empty(t, got.PayTo)
		assert.Empty(t, got.TokenProgram)
		assert.Empty(t, h.signer.sentTransactions())
	})

	t.Run("reclaims a discovered channel on the following cleanup pass", func(t *testing.T) {
		h := newDiscoveryHarness(t, 1)
		pda := h.discovered(generated.ChannelStatus_Distributed, openSlot, h.signer.feePayer())
		require.NoError(t, h.manager.Discover(context.Background(), DiscoveryOptions{}))
		var ids []string
		require.NoError(t, h.manager.Cleanup(context.Background(), CleanupOptions{OnReclaim: func(result ReclaimResult) {
			ids = append(ids, result.ChannelIDs...)
		}}))
		assert.Equal(t, []string{pda.String()}, ids)
	})

	t.Run("ignores discovered channels that are not Distributed", func(t *testing.T) {
		h := newDiscoveryHarness(t, 1)
		h.discovered(generated.ChannelStatus_Open, openSlot, h.signer.feePayer())
		var discovered int
		require.NoError(t, h.manager.Discover(context.Background(), DiscoveryOptions{OnDiscover: func(DiscoveryResult) { discovered++ }}))
		assert.Zero(t, discovered)
		records, err := h.storage.List(context.Background(), string(svm.SolanaDevnetCAIP2))
		require.NoError(t, err)
		assert.Empty(t, records)
	})

	t.Run("ignores discovered channels still inside the open-slot window", func(t *testing.T) {
		h := newDiscoveryHarness(t, 1)
		h.stub.slot = openSlot + paymentchannels.OpenSlotWindow
		h.discovered(generated.ChannelStatus_Distributed, openSlot, h.signer.feePayer())
		require.NoError(t, h.manager.Discover(context.Background(), DiscoveryOptions{}))
		records, err := h.storage.List(context.Background(), string(svm.SolanaDevnetCAIP2))
		require.NoError(t, err)
		assert.Empty(t, records)
	})

	t.Run("never overwrites a channel already tracked in storage", func(t *testing.T) {
		h := newDiscoveryHarness(t, 1)
		pda := h.discovered(generated.ChannelStatus_Distributed, openSlot, h.signer.feePayer())
		_, err := h.storage.RecordOpen(context.Background(), paymentchannels.PaymentChannelRecord{
			ChannelID: pda.String(), ExpiresAt: farFuture, LastActivityAt: time.Now(), Network: network,
			PayTo: h.payer.String(), TokenProgram: svm.TokenProgramAddress,
		})
		require.NoError(t, err)
		var discovered int
		require.NoError(t, h.manager.Discover(context.Background(), DiscoveryOptions{OnDiscover: func(DiscoveryResult) { discovered++ }}))
		assert.Zero(t, discovered)
		got, err := h.storage.Get(context.Background(), network, pda.String())
		require.NoError(t, err)
		assert.Equal(t, h.payer.String(), got.PayTo)
		assert.Equal(t, svm.TokenProgramAddress, got.TokenProgram)
	})

	t.Run("reports a sweep failure for one signer and continues", func(t *testing.T) {
		h := newDiscoveryHarness(t, 2)
		h.stub.failProgramAccounts = 1
		pda := h.discovered(generated.ChannelStatus_Distributed, openSlot, h.signer.keys[1].PublicKey())
		var ids []string
		var message string
		require.NoError(t, h.manager.Discover(context.Background(), DiscoveryOptions{
			OnDiscover: func(result DiscoveryResult) { ids = append(ids, result.ChannelIDs...) },
			OnError:    func(err error, _ string) { message = err.Error() },
		}))
		assert.Contains(t, message, "getProgramAccounts failed")
		assert.Equal(t, []string{pda.String()}, ids)
	})

	t.Run("runs discovery on its own interval, not the cleanup interval", func(t *testing.T) {
		h := newDiscoveryHarness(t, 1)
		h.manager.Start(context.Background(), StartConfig{Interval: 15 * time.Millisecond, DiscoveryInterval: 10 * time.Second})
		time.Sleep(60 * time.Millisecond)
		h.manager.Stop()
		assert.Zero(t, h.stub.methodCount("getProgramAccounts"))
	})

	t.Run("does not sweep at all when no discovery interval is configured", func(t *testing.T) {
		h := newDiscoveryHarness(t, 1)
		h.manager.Start(context.Background(), StartConfig{Interval: 15 * time.Millisecond})
		time.Sleep(60 * time.Millisecond)
		h.manager.Stop()
		assert.Zero(t, h.stub.methodCount("getProgramAccounts"))
	})
}

func TestBatchSvmRentCleanupManagerConcurrentSignerGroups(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	const openSlot = uint64(100)

	t.Run("submits independent rent-payer groups concurrently", func(t *testing.T) {
		signer, stub := newRPCSigner(t, 2)
		stub.slot = openSlot + paymentchannels.OpenSlotWindow + 1
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		payer := mustKey(t).PublicKey()
		payTo := mustKey(t).PublicKey().String()
		for _, rentPayer := range signer.GetAddresses(context.Background(), "") {
			id := mustKey(t).PublicKey().String()
			_, err := storage.RecordOpen(context.Background(), paymentchannels.PaymentChannelRecord{
				ChannelID: id, PayTo: payTo, TokenProgram: svm.TokenProgramAddress, LastActivityAt: time.Now(), ExpiresAt: 4_102_444_800, Network: network,
			})
			require.NoError(t, err)
			stub.setAccount(id, channelAccount{
				Status: generated.ChannelStatus_Distributed, OpenSlot: openSlot, Payer: payer, Payee: rentPayer, RentPayer: rentPayer,
				Mint:   solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
				Splits: []paymentchannels.Split{{Recipient: payTo, BPS: paymentchannels.BasisPointsDenominator}},
			}.encode(t))
		}
		var entered atomic.Int32
		release := make(chan struct{})
		started := make(chan struct{})
		signer.holdSend = func() {
			if entered.Add(1) == 2 {
				close(started)
			}
			<-release
		}
		manager := NewBatchSvmRentCleanupManager(RentCleanupConfig{Network: network, Signer: signer, Storage: storage})
		done := make(chan error, 1)
		go func() { done <- manager.Cleanup(context.Background(), CleanupOptions{}) }()
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("the two rent-payer groups did not submit together")
		}
		close(release)
		require.NoError(t, <-done)
		assert.Len(t, signer.sentTransactions(), 2)
	})

	t.Run("budgets each rent-payer group independently instead of sharing a pool", func(t *testing.T) {
		signer, stub := newRPCSigner(t, 2)
		stub.slot = openSlot + paymentchannels.OpenSlotWindow + 1
		storage := paymentchannels.NewInMemoryPaymentChannelStorage()
		payer := mustKey(t).PublicKey()
		payTo := mustKey(t).PublicKey().String()
		rentPayers := signer.GetAddresses(context.Background(), "")
		for _, rentPayer := range rentPayers {
			for i := 0; i < 3; i++ {
				id := mustKey(t).PublicKey().String()
				_, err := storage.RecordOpen(context.Background(), paymentchannels.PaymentChannelRecord{
					ChannelID: id, PayTo: payTo, TokenProgram: svm.TokenProgramAddress, LastActivityAt: time.Now(), ExpiresAt: 4_102_444_800, Network: network,
				})
				require.NoError(t, err)
				stub.setAccount(id, channelAccount{
					Status: generated.ChannelStatus_Distributed, OpenSlot: openSlot, Payer: payer, Payee: rentPayer, RentPayer: rentPayer,
					Mint:   solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
					Splits: []paymentchannels.Split{{Recipient: payTo, BPS: paymentchannels.BasisPointsDenominator}},
				}.encode(t))
			}
		}
		manager := NewBatchSvmRentCleanupManager(RentCleanupConfig{Network: network, Signer: signer, Storage: storage})
		var reclaims atomic.Int32
		require.NoError(t, manager.Cleanup(context.Background(), CleanupOptions{
			MaxReclaimsPerTx: 1, MaxTxsPerSigner: 2,
			OnReclaim: func(ReclaimResult) { reclaims.Add(1) },
		}))
		assert.Equal(t, int32(4), reclaims.Load())
	})
}

type cleanupHarness struct {
	t       *testing.T
	signer  *rpcSigner
	stub    *stubRPC
	storage *paymentchannels.InMemoryPaymentChannelStorage
	manager *BatchSvmRentCleanupManager
	payer   solana.PublicKey
	payTo   solana.PublicKey
}

type channelSeed struct {
	status           generated.ChannelStatus
	openSlot         uint64
	expiresAt        int64
	firstSeen        time.Time
	lastActivity     time.Time
	closureStartedAt int64
	grace            uint32
	payTo            string
	payee            solana.PublicKey
	rentPayer        solana.PublicKey
}

func (h *cleanupHarness) seed(seed channelSeed) paymentchannels.PaymentChannelRecord {
	h.t.Helper()
	if seed.openSlot == 0 {
		seed.openSlot = 100
	}
	if seed.grace == 0 {
		seed.grace = 900
	}
	if seed.lastActivity.IsZero() {
		if !seed.firstSeen.IsZero() {
			seed.lastActivity = seed.firstSeen
		} else {
			seed.lastActivity = time.Now().Add(-2 * time.Hour)
		}
	}
	payee := h.signer.feePayer()
	if !seed.payee.IsZero() {
		payee = seed.payee
	}
	rentPayer := payee
	if !seed.rentPayer.IsZero() {
		rentPayer = seed.rentPayer
	}
	record := paymentchannels.PaymentChannelRecord{
		ChannelID: mustKey(h.t).PublicKey().String(), PayTo: h.payTo.String(), TokenProgram: svm.TokenProgramAddress,
		LastActivityAt: seed.lastActivity, ExpiresAt: seed.expiresAt, Network: string(svm.SolanaDevnetCAIP2),
	}
	if seed.payTo == " " {
		record.PayTo = ""
	} else if seed.payTo != "" {
		record.PayTo = seed.payTo
	}
	_, err := h.storage.RecordOpen(context.Background(), record)
	require.NoError(h.t, err)
	h.stub.setAccount(record.ChannelID, channelAccount{
		Status: seed.status, Deposit: 10_000, GracePeriod: seed.grace, ClosureStartedAt: seed.closureStartedAt,
		Payer: h.payer, Payee: payee, RentPayer: rentPayer, Mint: solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
		OpenSlot: seed.openSlot, AuthorizedSigner: h.payer,
		Splits: []paymentchannels.Split{{Recipient: h.payTo.String(), BPS: paymentchannels.BasisPointsDenominator}},
	}.encode(h.t))
	return record
}

func (h *cleanupHarness) deleteOnSend(channelID string) {
	h.signer.holdSend = func() { h.stub.deleteAccount(channelID) }
}

func (h *cleanupHarness) exists(channelID string) bool {
	h.t.Helper()
	record, err := h.storage.Get(context.Background(), string(svm.SolanaDevnetCAIP2), channelID)
	require.NoError(h.t, err)
	return record != nil
}

func (h *cleanupHarness) only() paymentchannels.PaymentChannelRecord {
	h.t.Helper()
	records, err := h.storage.List(context.Background(), string(svm.SolanaDevnetCAIP2))
	require.NoError(h.t, err)
	require.Len(h.t, records, 1)
	return records[0]
}

func newDiscoveryHarness(t *testing.T, keys int) *cleanupHarness {
	t.Helper()
	signer, stub := newRPCSigner(t, keys)
	stub.slot = 100 + paymentchannels.OpenSlotWindow + 1
	h := &cleanupHarness{
		t: t, signer: signer, stub: stub,
		storage: paymentchannels.NewInMemoryPaymentChannelStorage(),
		payer:   mustKey(t).PublicKey(),
		payTo:   mustKey(t).PublicKey(),
	}
	h.manager = NewBatchSvmRentCleanupManager(RentCleanupConfig{
		Network: string(svm.SolanaDevnetCAIP2), Signer: signer, Storage: h.storage,
	})
	return h
}

func (h *cleanupHarness) discovered(status generated.ChannelStatus, openSlot uint64, rentPayer solana.PublicKey) solana.PublicKey {
	h.t.Helper()
	mint := solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress)
	authorized := mustKey(h.t)
	salt := uint64(time.Now().UnixNano())
	pda, err := paymentchannels.FindChannelPDA(h.payer, rentPayer, mint, authorized.PublicKey(), salt, openSlot)
	require.NoError(h.t, err)
	h.stub.setAccount(pda.String(), channelAccount{
		Status: status, Salt: salt, Deposit: 10_000, GracePeriod: 3600,
		Payer: h.payer, Payee: rentPayer, AuthorizedSigner: authorized.PublicKey(),
		Mint: mint, RentPayer: rentPayer, OpenSlot: openSlot,
		Splits: []paymentchannels.Split{{Recipient: h.payTo.String(), BPS: paymentchannels.BasisPointsDenominator}},
	}.encode(h.t))
	return pda
}

type reverseStorage struct {
	*paymentchannels.InMemoryPaymentChannelStorage
}

func (s reverseStorage) List(ctx context.Context, network string) ([]paymentchannels.PaymentChannelRecord, error) {
	records, err := s.InMemoryPaymentChannelStorage.List(ctx, network)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(records)-1; i < j; i, j = i+1, j-1 {
		records[i], records[j] = records[j], records[i]
	}
	return records, nil
}

func programInstructions(t *testing.T, tx *solana.Transaction) [][]byte {
	t.Helper()
	var out [][]byte
	for _, instruction := range tx.Message.Instructions {
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		require.NoError(t, err)
		if program.Equals(solana.ComputeBudget) {
			continue
		}
		out = append(out, instruction.Data)
	}
	return out
}

func computeLimit(t *testing.T, tx *solana.Transaction) uint32 {
	t.Helper()
	for _, instruction := range tx.Message.Instructions {
		program, err := tx.Message.Program(instruction.ProgramIDIndex)
		require.NoError(t, err)
		if program.Equals(solana.ComputeBudget) && len(instruction.Data) >= 5 && instruction.Data[0] == paymentchannels.ComputeBudgetSetUnitLimit {
			return uint32(instruction.Data[1]) | uint32(instruction.Data[2])<<8 | uint32(instruction.Data[3])<<16 | uint32(instruction.Data[4])<<24
		}
	}
	t.Fatal("transaction has no SetComputeUnitLimit instruction")
	return 0
}

func maxInt(values []int) int {
	max := values[0]
	for _, value := range values[1:] {
		if value > max {
			max = value
		}
	}
	return max
}
