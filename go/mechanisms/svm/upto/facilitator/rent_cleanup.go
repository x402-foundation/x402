package facilitator

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
)

const (
	// DefaultAbandonGraceSecs is how long after voucher expiry an Open channel
	// is left alone before the facilitator seals it to recover its rent.
	DefaultAbandonGraceSecs = 120

	// DefaultMaxReclaimsPerTx is how many reclaim instructions are packed into
	// one cleanup transaction.
	DefaultMaxReclaimsPerTx = 8

	// MaxSafeReclaimsPerTx is the largest reclaim batch proven, by
	// TestReclaimBatchFitsInOneTransaction, to serialize under Solana's
	// PACKET_DATA_SIZE (1232 bytes). MaxReclaimsPerTx is clamped to this so a
	// misconfigured operator value can never build a reclaim transaction that
	// fails to serialize or gets rejected on broadcast.
	MaxSafeReclaimsPerTx = 16

	// DefaultMaxTxsPerRun caps the close/distribute transactions the storage
	// scan submits per run.
	DefaultMaxTxsPerRun = 20

	// DefaultMaxTxsPerSigner caps the reclaim transactions each rent payer
	// submits per run.
	DefaultMaxTxsPerSigner = 20

	// DefaultMaxClosesPerRun caps the seal/distribute transactions per run.
	DefaultMaxClosesPerRun = 10
)

// CloseAction describes which cleanup path closed a channel.
type CloseAction string

// Cleanup close actions.
const (
	// CloseActionAbandonClose seals and distributes an abandoned Open channel.
	CloseActionAbandonClose CloseAction = "abandon_close"
	// CloseActionDistribute distributes an already-Sealed channel.
	CloseActionDistribute CloseAction = "distribute"
)

// CloseResult reports a successful abandon-close or Sealed distribute.
type CloseResult struct {
	ChannelID   string
	Transaction string
	Action      CloseAction
}

// ReclaimResult reports a successful batched reclaim transaction.
type ReclaimResult struct {
	ChannelIDs  []string
	Transaction string
}

// CleanupOptions bound the work of one cleanup pass and receive its results.
type CleanupOptions struct {
	// AbandonGraceSecs is the delay after ExpiresAt before abandon-closing an
	// Open channel. Defaults to DefaultAbandonGraceSecs.
	AbandonGraceSecs int64
	MaxReclaimsPerTx int
	// MaxTxsPerRun caps the transactions the storage scan may submit before it
	// stops and saves a resume cursor. It caps the scan, not the pass:
	// reclaims are budgeted separately by MaxTxsPerSigner.
	MaxTxsPerRun int
	// MaxTxsPerSigner caps the reclaim transactions each rent payer may submit
	// per pass. Budgeted per signer because rent-payer groups are independent:
	// adding managed keys adds throughput rather than dividing a fixed pool.
	MaxTxsPerSigner int
	MaxClosesPerRun int

	OnClose   func(result CloseResult)
	OnReclaim func(result ReclaimResult)
	OnError   func(err error, channelID string)
}

func (o CleanupOptions) withDefaults() CleanupOptions {
	if o.AbandonGraceSecs <= 0 {
		o.AbandonGraceSecs = DefaultAbandonGraceSecs
	}
	if o.MaxReclaimsPerTx <= 0 {
		o.MaxReclaimsPerTx = DefaultMaxReclaimsPerTx
	} else if o.MaxReclaimsPerTx > MaxSafeReclaimsPerTx {
		o.MaxReclaimsPerTx = MaxSafeReclaimsPerTx
	}
	if o.MaxTxsPerRun <= 0 {
		o.MaxTxsPerRun = DefaultMaxTxsPerRun
	}
	if o.MaxTxsPerSigner <= 0 {
		o.MaxTxsPerSigner = DefaultMaxTxsPerSigner
	}
	if o.MaxClosesPerRun <= 0 {
		o.MaxClosesPerRun = DefaultMaxClosesPerRun
	}
	return o
}

func (o CleanupOptions) reportError(err error, channelID string) {
	// Stop cancels the pass context mid-flight, so every call still in the
	// unwinding pass fails with context.Canceled. That is a requested
	// shutdown, not something the operator needs paged about.
	if o.OnError == nil || errors.Is(err, context.Canceled) {
		return
	}
	o.OnError(err, channelID)
}

// DiscoveryResult reports the channels one discovery sweep added to Storage.
type DiscoveryResult struct {
	ChannelIDs []string
}

// DiscoveryOptions receive the results of one discovery sweep.
type DiscoveryOptions struct {
	OnDiscover func(result DiscoveryResult)
	OnError    func(err error, channelID string)
}

func (o DiscoveryOptions) reportError(err error, channelID string) {
	// See CleanupOptions.reportError: a canceled sweep is a shutdown, not a
	// failure.
	if o.OnError == nil || errors.Is(err, context.Canceled) {
		return
	}
	o.OnError(err, channelID)
}

// StartConfig configures the interval runners.
type StartConfig struct {
	CleanupOptions
	// Interval is the delay between cleanup passes and is required.
	Interval time.Duration

	// DiscoveryInterval is the delay between Discover sweeps. Zero leaves
	// discovery off. A sweep is a getProgramAccounts scan per managed signer,
	// so it belongs on a far longer interval than cleanup: daily is typical.
	DiscoveryInterval time.Duration

	// OnDiscover receives each interval sweep's result.
	OnDiscover func(result DiscoveryResult)
}

// discoveryOptions is the discovery half of the interval runner's config.
func (c StartConfig) discoveryOptions() DiscoveryOptions {
	return DiscoveryOptions{OnDiscover: c.OnDiscover, OnError: c.OnError}
}

// RentCleanupConfig configures a rent cleanup manager for one network.
type RentCleanupConfig struct {
	Signer  svm.FacilitatorSvmSigner
	Storage ChannelStorage
	Network string
	RPCURL  string

	// RPC is a prebuilt client used instead of building one from RPCURL, for
	// callers that need custom headers, transport, or rate limiting.
	RPC *rpc.Client

	// ComputeUnitPriceMicroLamports is the SetComputeUnitPrice (microlamports
	// per compute unit) attached to cleanup transactions; 0 omits the
	// instruction. Unset defaults to svm.DefaultComputeUnitPriceMicrolamports.
	ComputeUnitPriceMicroLamports *uint64

	// SettleComputeUnitLimit is the SetComputeUnitLimit for close/distribute
	// cleanup transactions. Unset defaults to DefaultSettleComputeUnitLimit
	// (100k, standard SPL Token settlement); raise it for compute-heavy
	// Token-2022 extension mints. Reclaim batches instead derive their limit
	// per channel (ReclaimComputeUnitLimit) and are mint-independent.
	SettleComputeUnitLimit *uint32
}

// RentCleanupManager recovers the rent a facilitator fronts for payment
// channels on one network. Passes are driven by settle-time ChannelStorage
// rather than RPC discovery.
//
// Sealing an abandoned Open channel freezes the settlement watermark and
// refunds the unsettled remainder to the client, so cleanup only kicks in
// after the voucher deadline plus a grace period.
type RentCleanupManager struct {
	signer                        svm.FacilitatorSvmSigner
	storage                       ChannelStorage
	network                       string
	rpcURL                        string
	rpc                           *rpc.Client
	computeUnitPriceMicroLamports *uint64
	settleComputeUnitLimit        *uint32

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}

	// passMu serializes passes so a manual Cleanup cannot race the interval
	// loop into submitting the same close or reclaim twice, and so a Discover
	// sweep cannot upsert a record Cleanup is mid-way through deleting. It
	// also guards scanCursor, since only one pass ever reads or writes it.
	passMu sync.Mutex

	// scanCursor resumes scanning where the previous pass's budget ran out,
	// so a persistent close/reclaim backlog larger than MaxTxsPerRun cannot
	// starve records ordered later in storage.List forever. Empty means
	// start from the beginning of the list.
	scanCursor string
}

// NewRentCleanupManager creates a rent cleanup manager. It does not start
// automatically; the facilitator scheme never runs cleanup on its own.
func NewRentCleanupManager(config RentCleanupConfig) *RentCleanupManager {
	return &RentCleanupManager{
		signer:                        config.Signer,
		storage:                       config.Storage,
		network:                       config.Network,
		rpcURL:                        config.RPCURL,
		rpc:                           config.RPC,
		computeUnitPriceMicroLamports: config.ComputeUnitPriceMicroLamports,
		settleComputeUnitLimit:        config.SettleComputeUnitLimit,
	}
}

// rpcClient returns the injected client when there is one, otherwise builds
// one for the network.
func (m *RentCleanupManager) rpcClient() (*rpc.Client, error) {
	if m.rpc != nil {
		return m.rpc, nil
	}
	return upto.NewRPCClient(m.network, m.rpcURL)
}

// Start runs Cleanup on an interval, and Discover on its own longer interval
// when one is configured, until Stop is called or the context is canceled.
// Calling Start on a running manager is a no-op.
func (m *RentCleanupManager) Start(ctx context.Context, config StartConfig) {
	if config.Interval <= 0 {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cancel != nil {
		return
	}

	runCtx, cancel := context.WithCancel(ctx)
	m.cancel = cancel
	m.done = make(chan struct{})

	var runners sync.WaitGroup
	runners.Add(1)
	go func() {
		defer runners.Done()
		m.runTicker(runCtx, config.Interval, func() error {
			// Passes run serially, so a slow pass delays the next tick rather
			// than racing it.
			return m.Cleanup(runCtx, config.CleanupOptions)
		}, config.reportError)
	}()

	if config.DiscoveryInterval > 0 {
		runners.Add(1)
		go func() {
			defer runners.Done()
			discovery := config.discoveryOptions()
			m.runTicker(runCtx, config.DiscoveryInterval, func() error {
				return m.Discover(runCtx, discovery)
			}, discovery.reportError)
		}()
	}

	go func(done chan struct{}) {
		defer close(done)
		runners.Wait()
	}(m.done)
}

// runTicker calls run on every tick until ctx ends, reporting failures.
func (m *RentCleanupManager) runTicker(
	ctx context.Context,
	interval time.Duration,
	run func() error,
	reportError func(err error, channelID string),
) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := run(); err != nil {
				reportError(err, "")
			}
		}
	}
}

// Stop halts the interval runners and waits for an in-flight pass to finish.
func (m *RentCleanupManager) Stop() {
	m.mu.Lock()
	cancel, done := m.cancel, m.done
	m.cancel, m.done = nil, nil
	m.mu.Unlock()

	if cancel == nil {
		return
	}
	cancel()
	<-done
}

// Cleanup runs one pass: abandon-close timed-out Open channels, distribute
// Sealed ones, and batch-reclaim Distributed ones past the open-slot gate.
// Closing channels and channels that are not yet ready are skipped.
func (m *RentCleanupManager) Cleanup(ctx context.Context, opts CleanupOptions) error {
	m.passMu.Lock()
	defer m.passMu.Unlock()

	opts = opts.withDefaults()

	rpcClient, err := m.rpcClient()
	if err != nil {
		return err
	}
	records, err := m.storage.List(ctx)
	if err != nil {
		return fmt.Errorf("failed to list stored channels: %w", err)
	}
	records = orderForScan(records, m.scanCursor)
	m.scanCursor = ""

	now := time.Now().Unix()
	var currentSlot *uint64
	txsUsed, closesUsed := 0, 0
	var reclaimCandidates []reclaimCandidate

	for _, record := range records {
		// Stop, not skip: the budget is spent, so nothing further in this pass
		// can act on a record, and each one costs an account fetch to classify.
		// Resume here next pass instead of always rescanning from the start.
		if txsUsed >= opts.MaxTxsPerRun {
			m.scanCursor = record.ChannelID
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if record.Network != m.network {
			continue
		}

		channelID, err := solana.PublicKeyFromBase58(record.ChannelID)
		if err != nil {
			opts.reportError(err, record.ChannelID)
			continue
		}
		channel, exists, err := fetchChannelAccount(ctx, rpcClient, channelID)
		if err != nil {
			opts.reportError(err, record.ChannelID)
			continue
		}
		if !exists {
			if err := m.storage.Delete(ctx, record.ChannelID); err != nil {
				opts.reportError(err, record.ChannelID)
			}
			continue
		}

		switch channel.Status {
		case paymentchannels.StatusClosing:
			continue

		case paymentchannels.StatusOpen, paymentchannels.StatusSealed:
			if channel.Status == paymentchannels.StatusOpen && now < record.ExpiresAt+opts.AbandonGraceSecs {
				continue
			}
			// Skip, not stop: later records may be reclaimable, and reclaims
			// are budgeted separately from closes.
			if closesUsed >= opts.MaxClosesPerRun {
				continue
			}
			if record.PayTo == "" {
				opts.reportError(
					fmt.Errorf("channel %s has no stored payTo; cannot rebuild its distribution", record.ChannelID),
					record.ChannelID,
				)
				continue
			}
			signature, err := m.submitCloseOrDistribute(ctx, rpcClient, record, channel, channelID)
			if err != nil {
				opts.reportError(err, record.ChannelID)
				continue
			}
			closesUsed++
			txsUsed++
			if opts.OnClose != nil {
				action := CloseActionDistribute
				if channel.Status == paymentchannels.StatusOpen {
					action = CloseActionAbandonClose
				}
				opts.OnClose(CloseResult{
					ChannelID:   record.ChannelID,
					Transaction: signature,
					Action:      action,
				})
			}
			m.deleteIfGone(ctx, rpcClient, channelID, record.ChannelID, opts)

		case paymentchannels.StatusDistributed:
			slot, err := m.currentSlot(ctx, rpcClient, &currentSlot)
			if err != nil {
				opts.reportError(err, record.ChannelID)
				continue
			}
			if slot > channel.OpenSlot+paymentchannels.OpenSlotWindow {
				reclaimCandidates = append(reclaimCandidates, reclaimCandidate{
					channelID: channelID,
					rentPayer: channel.RentPayer,
				})
			}

		default:
			// An unrecognized status has no cleanup path, and the record would
			// otherwise sit in storage forever without the operator knowing.
			opts.reportError(
				fmt.Errorf("channel %s has unrecognized status %s", record.ChannelID, channel.Status),
				record.ChannelID,
			)
		}
	}

	m.submitReclaimBatches(ctx, rpcClient, reclaimCandidates, opts)
	return nil
}

// Discover finds Distributed channels this facilitator paid rent for that
// Storage does not know about and adds them, so Cleanup reclaims them on a
// later pass. It is the spec §6 recovery path for a lost or incomplete work
// index.
//
// A sweep is a getProgramAccounts scan per managed signer key, far more
// expensive than a cleanup pass: run it rarely (see StartConfig's
// DiscoveryInterval), not on the cleanup interval.
//
// Discovered records carry only what the chain proves: PayTo, TokenProgram,
// and ExpiresAt are empty. That is safe because only the Open and Sealed
// cleanup branches read them, and a Distributed channel never returns to those
// states. Channel IDs already in Storage are left alone so a full record is
// never overwritten with a partial one.
func (m *RentCleanupManager) Discover(ctx context.Context, opts DiscoveryOptions) error {
	m.passMu.Lock()
	defer m.passMu.Unlock()

	rpcClient, err := m.rpcClient()
	if err != nil {
		return err
	}
	records, err := m.storage.List(ctx)
	if err != nil {
		return fmt.Errorf("failed to list stored channels: %w", err)
	}
	known := make(map[string]struct{}, len(records))
	for _, record := range records {
		known[record.ChannelID] = struct{}{}
	}

	var (
		currentSlot *uint64
		discovered  []string
	)
	for _, managed := range m.signer.GetAddresses(ctx, m.network) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		found, err := paymentchannels.DiscoverChannelsByRentPayer(ctx, rpcClient, managed)
		if err != nil {
			opts.reportError(fmt.Errorf("discovery failed for rent payer %s: %w", managed, err), "")
			continue
		}
		slot, err := m.currentSlot(ctx, rpcClient, &currentSlot)
		if err != nil {
			return err
		}

		for _, channel := range found {
			id := channel.ChannelID.String()
			if _, exists := known[id]; exists {
				continue
			}
			known[id] = struct{}{}
			if channel.Channel.Status != paymentchannels.StatusDistributed {
				continue
			}
			if slot <= channel.Channel.OpenSlot+paymentchannels.OpenSlotWindow {
				continue
			}

			if err := m.storage.Upsert(ctx, ChannelRecord{
				ChannelID:   id,
				FirstSeenAt: time.Now(),
				Network:     m.network,
			}); err != nil {
				opts.reportError(err, id)
				continue
			}
			discovered = append(discovered, id)
		}
	}

	if len(discovered) > 0 && opts.OnDiscover != nil {
		opts.OnDiscover(DiscoveryResult{ChannelIDs: discovered})
	}
	return nil
}

// currentSlot lazily fetches and caches the slot used to gate reclaims, so a
// pass with no Distributed records never pays for the RPC round trip.
func (m *RentCleanupManager) currentSlot(ctx context.Context, rpcClient *rpc.Client, cache **uint64) (uint64, error) {
	if *cache != nil {
		return **cache, nil
	}
	slot, err := rpcClient.GetSlot(ctx, upto.SlotCommitment)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch the current slot: %w", err)
	}
	*cache = &slot
	return slot, nil
}

// reclaimCandidate is a Distributed channel ready to have its rent reclaimed.
type reclaimCandidate struct {
	channelID solana.PublicKey
	rentPayer solana.PublicKey
}

// orderForScan puts records in scan order, resuming where the previous pass
// stopped.
//
// ChannelStorage.List promises no ordering, so the manager imposes one:
// without it the resume cursor would mean something different on every storage
// implementation, and a backlog larger than the budget could revisit the same
// records forever. Records are sorted by channel ID, then rotated so cursor
// comes first. An unknown or empty cursor (a closed channel, or the first
// pass) scans from the beginning.
func orderForScan(records []ChannelRecord, cursor string) []ChannelRecord {
	sorted := make([]ChannelRecord, len(records))
	copy(sorted, records)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ChannelID < sorted[j].ChannelID })

	if cursor == "" {
		return sorted
	}
	for i, record := range sorted {
		if record.ChannelID == cursor {
			rotated := make([]ChannelRecord, 0, len(sorted))
			rotated = append(rotated, sorted[i:]...)
			rotated = append(rotated, sorted[:i]...)
			return rotated
		}
	}
	return sorted
}

// submitCloseOrDistribute seals and distributes an abandoned Open channel, or
// distributes an already-Sealed one.
func (m *RentCleanupManager) submitCloseOrDistribute(
	ctx context.Context,
	rpcClient *rpc.Client,
	record ChannelRecord,
	channel *paymentchannels.Channel,
	channelID solana.PublicKey,
) (string, error) {
	// The channel payee and rent payer are the same facilitator key in this
	// scheme, and both come from the live account rather than storage.
	feePayer, err := m.resolveFeePayer(ctx, channel.Payee)
	if err != nil {
		return "", err
	}
	tokenProgram, err := solana.PublicKeyFromBase58(record.TokenProgram)
	if err != nil {
		return "", fmt.Errorf("channel %s has an invalid stored tokenProgram: %w", record.ChannelID, err)
	}

	distribute, err := paymentchannels.BuildDistributeInstruction(paymentchannels.DistributeInstructionArgs{
		Channel:      channelID,
		Payer:        channel.Payer,
		Payee:        channel.Payee,
		RentPayer:    channel.RentPayer,
		Mint:         channel.Mint,
		TokenProgram: tokenProgram,
		Splits:       []paymentchannels.Split{{Recipient: record.PayTo, BPS: paymentchannels.BasisPointsDenominator}},
		Network:      m.network,
	})
	if err != nil {
		return "", err
	}

	instructions := []solana.Instruction{distribute}
	if channel.Status == paymentchannels.StatusOpen {
		// Seal at the current watermark with no voucher: the unsettled
		// remainder refunds to the payer in the same transaction.
		instructions = []solana.Instruction{
			paymentchannels.BuildSettleAndSealInstruction(channelID, channel.Payee, false),
			distribute,
		}
	}

	return submitSettle(ctx, rpcClient, m.signer, feePayer, m.network, instructions, submitSettleOptions{
		ComputeUnitLimit:              m.settleComputeUnitLimit,
		ComputeUnitPriceMicroLamports: m.computeUnitPriceMicroLamports,
	})
}

// submitReclaimBatches groups candidates by rent payer and runs each group's
// batched reclaim transactions concurrently, each against its own
// MaxTxsPerSigner budget. Submissions within a group stay sequential (each
// batch refetches live state, so a group depends on its own prior submissions
// to avoid double-reclaiming), but independent rent-payer groups do not share
// a budget or depend on one another: adding managed signer keys adds
// MaxTxsPerSigner more reclaim throughput per pass, not a share of a fixed
// pool.
func (m *RentCleanupManager) submitReclaimBatches(
	ctx context.Context,
	rpcClient *rpc.Client,
	candidates []reclaimCandidate,
	opts CleanupOptions,
) {
	if opts.MaxTxsPerSigner <= 0 || len(candidates) == 0 {
		return
	}

	byRentPayer := make(map[solana.PublicKey][]reclaimCandidate)
	order := make([]solana.PublicKey, 0, len(candidates))
	for _, candidate := range candidates {
		if _, seen := byRentPayer[candidate.rentPayer]; !seen {
			order = append(order, candidate.rentPayer)
		}
		byRentPayer[candidate.rentPayer] = append(byRentPayer[candidate.rentPayer], candidate)
	}

	var wg sync.WaitGroup
	for _, rentPayer := range order {
		group := byRentPayer[rentPayer]
		wg.Add(1)
		go func(rentPayer solana.PublicKey, group []reclaimCandidate) {
			defer wg.Done()
			budget := int64(opts.MaxTxsPerSigner)
			m.submitReclaimGroup(ctx, rpcClient, rentPayer, group, opts, &budget)
		}(rentPayer, group)
	}
	wg.Wait()
}

// submitReclaimGroup submits one rent payer's batches sequentially, claiming
// a slot from the shared budget before each attempt so concurrent groups
// cannot overrun maxTxs.
func (m *RentCleanupManager) submitReclaimGroup(
	ctx context.Context,
	rpcClient *rpc.Client,
	rentPayer solana.PublicKey,
	group []reclaimCandidate,
	opts CleanupOptions,
	budget *int64,
) {
	feePayer, err := m.resolveFeePayer(ctx, rentPayer)
	if err != nil {
		for _, candidate := range group {
			opts.reportError(err, candidate.channelID.String())
		}
		return
	}

	for start := 0; start < len(group); start += opts.MaxReclaimsPerTx {
		if atomic.AddInt64(budget, -1) < 0 {
			atomic.AddInt64(budget, 1)
			return
		}
		if ctx.Err() != nil {
			return
		}

		end := start + opts.MaxReclaimsPerTx
		if end > len(group) {
			end = len(group)
		}
		batch := m.refreshReclaimBatch(ctx, rpcClient, group[start:end], opts)
		if len(batch) == 0 {
			continue
		}

		instructions := make([]solana.Instruction, 0, len(batch))
		channelIDs := make([]string, 0, len(batch))
		for _, candidate := range batch {
			instructions = append(instructions,
				paymentchannels.BuildReclaimInstruction(candidate.channelID, candidate.rentPayer))
			channelIDs = append(channelIDs, candidate.channelID.String())
		}

		reclaimLimit := ReclaimComputeUnitLimit(len(batch))
		signature, err := submitSettle(ctx, rpcClient, m.signer, feePayer, m.network, instructions, submitSettleOptions{
			ComputeUnitLimit:              &reclaimLimit,
			ComputeUnitPriceMicroLamports: m.computeUnitPriceMicroLamports,
		})
		if err != nil {
			// Every channel in the batch is stuck, not just the first.
			for _, channelID := range channelIDs {
				opts.reportError(err, channelID)
			}
			continue
		}
		if opts.OnReclaim != nil {
			opts.OnReclaim(ReclaimResult{ChannelIDs: channelIDs, Transaction: signature})
		}
		for _, channelID := range channelIDs {
			if err := m.storage.Delete(ctx, channelID); err != nil {
				opts.reportError(err, channelID)
			}
		}
	}
}

// refreshReclaimBatch refetches each candidate immediately before acting, so a
// channel that changed since the listing pass is skipped rather than failing
// the whole batch.
func (m *RentCleanupManager) refreshReclaimBatch(
	ctx context.Context,
	rpcClient *rpc.Client,
	batch []reclaimCandidate,
	opts CleanupOptions,
) []reclaimCandidate {
	live := make([]reclaimCandidate, 0, len(batch))
	for _, candidate := range batch {
		channel, exists, err := fetchChannelAccount(ctx, rpcClient, candidate.channelID)
		if err != nil {
			opts.reportError(err, candidate.channelID.String())
			continue
		}
		if !exists {
			if err := m.storage.Delete(ctx, candidate.channelID.String()); err != nil {
				opts.reportError(err, candidate.channelID.String())
			}
			continue
		}
		if channel.Status != paymentchannels.StatusDistributed {
			continue
		}
		live = append(live, reclaimCandidate{channelID: candidate.channelID, rentPayer: channel.RentPayer})
	}
	return live
}

// deleteIfGone drops the storage entry once the channel account is closed.
func (m *RentCleanupManager) deleteIfGone(
	ctx context.Context,
	rpcClient *rpc.Client,
	channelID solana.PublicKey,
	storedID string,
	opts CleanupOptions,
) {
	exists, err := channelExists(ctx, rpcClient, channelID)
	if err != nil {
		opts.reportError(err, storedID)
		return
	}
	if exists {
		return
	}
	if err := m.storage.Delete(ctx, storedID); err != nil {
		opts.reportError(err, storedID)
	}
}

// resolveFeePayer checks that a live channel's payee / rent payer is a signer
// this facilitator controls.
func (m *RentCleanupManager) resolveFeePayer(ctx context.Context, address solana.PublicKey) (solana.PublicKey, error) {
	for _, managed := range m.signer.GetAddresses(ctx, m.network) {
		if managed.Equals(address) {
			return address, nil
		}
	}
	return solana.PublicKey{}, fmt.Errorf("channel key %s is not in the facilitator signer set", address)
}
