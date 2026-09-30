package paymentchannels

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
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

const (
	// DefaultAbandonGraceSecs is how long after voucher expiry an Open channel
	// is left alone before the facilitator seals it to recover its rent.
	DefaultAbandonGraceSecs = 120

	// DefaultMaxIdleSecs is the idle window after which an Open channel with
	// no facilitator-visible activity is abandon-closed. Seven days.
	DefaultMaxIdleSecs int64 = 7 * 24 * 60 * 60

	// DefaultMaxReclaimsPerTx is how many reclaim instructions are packed into
	// one cleanup transaction.
	DefaultMaxReclaimsPerTx = 8

	// MaxSafeReclaimsPerTx is the largest reclaim batch that serializes under
	// Solana's packet data size. MaxReclaimsPerTx is clamped to this.
	MaxSafeReclaimsPerTx = 16

	// DefaultMaxTxsPerRun caps the close/distribute transactions the storage
	// scan submits per run.
	DefaultMaxTxsPerRun = 20

	// DefaultMaxTxsPerSigner caps the reclaim transactions each rent payer
	// submits per run.
	DefaultMaxTxsPerSigner = 20

	// DefaultMaxClosesPerRun caps the seal/distribute transactions per run.
	DefaultMaxClosesPerRun = 10

	// OpenIndexGraceSecs is how long a missing account keeps its index row.
	// Longer than a blockhash lifetime, so cleanup does not drop an open that
	// is still pending.
	OpenIndexGraceSecs int64 = 300
)

// OpenAbandonPolicy selects how an Open channel becomes an abandon candidate.
type OpenAbandonPolicy string

const (
	// OpenAbandonPolicyExpiry abandons every Open channel at ExpiresAt + grace.
	// ExpiresAt == 0 is already due. This is the upto policy.
	OpenAbandonPolicyExpiry OpenAbandonPolicy = "expiry"
	// OpenAbandonPolicyIdle abandons expiring channels at ExpiresAt + grace and
	// non-expiring channels after MaxIdleSecs without activity. This is the
	// batch-settlement default.
	OpenAbandonPolicyIdle OpenAbandonPolicy = "idle"
)

// AssertMaxIdleSecs validates a non-negative idle window. A nil value returns
// the default. Zero disables idle abandon-close.
func AssertMaxIdleSecs(value *int64) (int64, error) {
	if value == nil {
		return DefaultMaxIdleSecs, nil
	}
	if *value < 0 {
		return 0, fmt.Errorf("maxIdleSecs must be a non-negative integer number of seconds")
	}
	return *value, nil
}

// RentCleanupCloseAction describes which cleanup path closed a channel.
type RentCleanupCloseAction string

const (
	RentCleanupCloseAbandon    RentCleanupCloseAction = "abandon_close"
	RentCleanupCloseForced     RentCleanupCloseAction = "forced_close"
	RentCleanupCloseDistribute RentCleanupCloseAction = "distribute"
)

// RentCleanupCloseResult reports one successful close or distribute.
type RentCleanupCloseResult struct {
	ChannelID   string
	Transaction string
	Action      RentCleanupCloseAction
}

// RentCleanupReclaimResult reports one successful batched reclaim.
type RentCleanupReclaimResult struct {
	ChannelIDs  []string
	Transaction string
}

// RentCleanupOptions bound one cleanup pass and receive its results.
type RentCleanupOptions struct {
	AbandonGraceSecs int64
	MaxIdleSecs      *int64
	MaxReclaimsPerTx int
	MaxTxsPerRun     int
	MaxTxsPerSigner  int
	MaxClosesPerRun  int
	OnClose          func(RentCleanupCloseResult)
	OnReclaim        func(RentCleanupReclaimResult)
	OnError          func(err error, channelID string)
}

func (o RentCleanupOptions) withDefaults(configuredIdle *int64) (RentCleanupOptions, int64) {
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
	idle := configuredIdle
	if o.MaxIdleSecs != nil {
		idle = o.MaxIdleSecs
	}
	resolved := DefaultMaxIdleSecs
	if idle != nil && *idle >= 0 {
		resolved = *idle
	}
	return o, resolved
}

func reportRentError(onError func(error, string), err error, channelID string) {
	if onError == nil || errors.Is(err, context.Canceled) {
		return
	}
	onError(err, channelID)
}

func (o RentCleanupOptions) reportError(err error, channelID string) {
	reportRentError(o.OnError, err, channelID)
}

// RentDiscoveryResult reports the channels one discovery sweep added to storage.
type RentDiscoveryResult struct {
	ChannelIDs []string
}

// RentDiscoveryOptions receive one discovery sweep's results.
type RentDiscoveryOptions struct {
	OnDiscover func(RentDiscoveryResult)
	OnError    func(err error, channelID string)
}

func (o RentDiscoveryOptions) reportError(err error, channelID string) {
	reportRentError(o.OnError, err, channelID)
}

// RentCleanupStartConfig configures the interval runners.
type RentCleanupStartConfig struct {
	RentCleanupOptions
	Interval          time.Duration
	DiscoveryInterval time.Duration
	OnDiscover        func(RentDiscoveryResult)
}

func (c RentCleanupStartConfig) discoveryOptions() RentDiscoveryOptions {
	return RentDiscoveryOptions{OnDiscover: c.OnDiscover, OnError: c.OnError}
}

// PaymentChannelRentCleanupConfig configures a rent cleanup manager for one network.
type PaymentChannelRentCleanupConfig struct {
	Signer                        svm.FacilitatorSvmSigner
	Storage                       PaymentChannelStorage
	Network                       string
	ComputeUnitPriceMicroLamports *uint64
	SettleComputeUnitLimit        *uint32
	MaxIdleSecs                   *int64
	AbandonPolicy                 OpenAbandonPolicy
	// SealClosingChannels nil defaults to true. upto sets it false.
	SealClosingChannels *bool
	Label               string
}

// PaymentChannelRentCleanupManager recovers rent a facilitator fronts for
// payment channels on one network.
type PaymentChannelRentCleanupManager struct {
	signer                        PaymentChannelFacilitatorSigner
	storage                       PaymentChannelStorage
	network                       string
	computeUnitPriceMicroLamports *uint64
	settleComputeUnitLimit        *uint32
	maxIdleSecs                   *int64
	abandonPolicy                 OpenAbandonPolicy
	sealClosingChannels           bool
	label                         string

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}

	passMu     sync.Mutex
	scanCursor string
}

// NewPaymentChannelRentCleanupManager creates a rent cleanup manager. It does
// not start automatically.
func NewPaymentChannelRentCleanupManager(config PaymentChannelRentCleanupConfig) *PaymentChannelRentCleanupManager {
	label := config.Label
	if label == "" {
		label = "PaymentChannelRentCleanupManager"
	}
	if config.Signer == nil {
		panic(label + ": signer is required")
	}
	policy := config.AbandonPolicy
	if policy == "" {
		policy = OpenAbandonPolicyIdle
	}
	switch policy {
	case OpenAbandonPolicyExpiry, OpenAbandonPolicyIdle:
	default:
		panic(label + ": abandonPolicy must be expiry or idle")
	}
	seal := true
	if config.SealClosingChannels != nil {
		seal = *config.SealClosingChannels
	}
	return &PaymentChannelRentCleanupManager{
		signer:                        AssertPaymentChannelFacilitatorSigner(config.Signer, label),
		storage:                       config.Storage,
		network:                       config.Network,
		computeUnitPriceMicroLamports: config.ComputeUnitPriceMicroLamports,
		settleComputeUnitLimit:        config.SettleComputeUnitLimit,
		maxIdleSecs:                   config.MaxIdleSecs,
		abandonPolicy:                 policy,
		sealClosingChannels:           seal,
		label:                         label,
	}
}

// Start runs Cleanup on an interval, and Discover on its own longer interval
// when one is configured, until Stop or ctx ends.
func (m *PaymentChannelRentCleanupManager) Start(ctx context.Context, config RentCleanupStartConfig) {
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
			return m.Cleanup(runCtx, config.RentCleanupOptions)
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

func (m *PaymentChannelRentCleanupManager) runTicker(
	ctx context.Context,
	interval time.Duration,
	run func() error,
	reportError func(error, string),
) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := run(); err != nil && ctx.Err() == nil {
				reportError(err, "")
			}
		}
	}
}

// Stop halts the interval runners and waits for an in-flight pass to finish.
func (m *PaymentChannelRentCleanupManager) Stop() {
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

// Cleanup runs one pass: abandon-close due Open channels, seal Closing
// channels whose grace has elapsed when configured, distribute Sealed ones,
// and batch-reclaim Distributed ones past the open-slot gate.
func (m *PaymentChannelRentCleanupManager) Cleanup(ctx context.Context, opts RentCleanupOptions) error {
	m.passMu.Lock()
	defer m.passMu.Unlock()

	opts, maxIdleSecs := opts.withDefaults(m.maxIdleSecs)
	records, err := m.storage.List(ctx, m.network)
	if err != nil {
		return fmt.Errorf("failed to list stored channels: %w", err)
	}
	records = orderRentCleanupScan(records, m.scanCursor)
	m.scanCursor = ""

	now := time.Now().Unix()
	var currentSlot *uint64
	txsUsed, closesUsed := 0, 0
	var reclaimCandidates []reclaimCandidate
	rpcClient := AccountFetchRPC(m.signer, m.network)

	for _, record := range records {
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
			if err := m.deleteIfPastOpenGrace(ctx, record); err != nil {
				opts.reportError(err, record.ChannelID)
			}
			continue
		}

		status := generated.ChannelStatus(channel.Status)
		if status == generated.ChannelStatus_Closing && !m.sealClosingChannels {
			continue
		}
		switch status {
		case generated.ChannelStatus_Open, generated.ChannelStatus_Closing, generated.ChannelStatus_Sealed:
			if status == generated.ChannelStatus_Open && !openChannelDue(m.abandonPolicy, record, now, opts.AbandonGraceSecs, maxIdleSecs) {
				continue
			}
			if status == generated.ChannelStatus_Closing && now < channel.ClosureStartedAt+int64(channel.GracePeriod) {
				continue
			}
			if closesUsed >= opts.MaxClosesPerRun {
				continue
			}
			if record.PayTo == "" {
				opts.reportError(fmt.Errorf("channel %s has no stored payTo; cannot rebuild its distribution", record.ChannelID), record.ChannelID)
				continue
			}
			signature, err := m.submitCloseOrDistribute(ctx, record, channel, channelID)
			if err != nil {
				opts.reportError(err, record.ChannelID)
				continue
			}
			closesUsed++
			txsUsed++
			if opts.OnClose != nil {
				opts.OnClose(RentCleanupCloseResult{
					ChannelID:   record.ChannelID,
					Transaction: signature,
					Action:      closeAction(status),
				})
			}
			m.deleteIfGone(ctx, rpcClient, channelID, record.ChannelID, opts)

		case generated.ChannelStatus_Distributed:
			slot, err := m.currentSlot(ctx, &currentSlot)
			if err != nil {
				opts.reportError(err, record.ChannelID)
				continue
			}
			if slot > channel.OpenSlot+OpenSlotWindow {
				reclaimCandidates = append(reclaimCandidates, reclaimCandidate{
					channelID: channelID,
					rentPayer: channel.RentPayer,
				})
			}

		default:
			opts.reportError(fmt.Errorf("channel %s has unrecognized status %s", record.ChannelID, ChannelStatusString(status)), record.ChannelID)
		}
	}

	m.submitReclaimBatches(ctx, rpcClient, reclaimCandidates, opts)
	return nil
}

// Discover finds Distributed channels this facilitator paid rent for that
// storage does not know about and adds them, so Cleanup reclaims them later.
func (m *PaymentChannelRentCleanupManager) Discover(ctx context.Context, opts RentDiscoveryOptions) error {
	m.passMu.Lock()
	defer m.passMu.Unlock()

	getter, ok := m.signer.(interface {
		GetProgramAccounts(context.Context, string, solana.PublicKey, *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error)
	})
	if !ok {
		return fmt.Errorf("%s.Discover requires GetProgramAccounts on the signer", m.label)
	}
	querier := signerProgramAccounts{signer: getter, network: m.network}
	records, err := m.storage.List(ctx, m.network)
	if err != nil {
		return fmt.Errorf("failed to list stored channels: %w", err)
	}
	known := make(map[string]struct{}, len(records))
	for _, record := range records {
		known[record.ChannelID] = struct{}{}
	}

	var currentSlot *uint64
	var discovered []string
	now := time.Now()
	for _, managed := range m.signer.GetAddresses(ctx, m.network) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		found, err := DiscoverChannelsByRentPayer(ctx, querier, managed)
		if err != nil {
			opts.reportError(fmt.Errorf("discovery failed for rent payer %s: %w", managed, err), "")
			continue
		}
		slot, err := m.currentSlot(ctx, &currentSlot)
		if err != nil {
			return err
		}
		for _, channel := range found {
			id := channel.ChannelID.String()
			if _, exists := known[id]; exists {
				continue
			}
			known[id] = struct{}{}
			if generated.ChannelStatus(channel.Channel.Status) != generated.ChannelStatus_Distributed {
				continue
			}
			if slot <= channel.Channel.OpenSlot+OpenSlotWindow {
				continue
			}
			if err := m.storage.RecordActivity(ctx, PaymentChannelRecord{
				ChannelID:      id,
				LastActivityAt: now,
				Network:        m.network,
			}); err != nil {
				opts.reportError(err, id)
				continue
			}
			discovered = append(discovered, id)
		}
	}
	if len(discovered) > 0 && opts.OnDiscover != nil {
		opts.OnDiscover(RentDiscoveryResult{ChannelIDs: discovered})
	}
	return nil
}

type signerProgramAccounts struct {
	signer interface {
		GetProgramAccounts(context.Context, string, solana.PublicKey, *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error)
	}
	network string
}

func (q signerProgramAccounts) GetProgramAccounts(ctx context.Context, opts *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error) {
	return q.signer.GetProgramAccounts(ctx, q.network, ProgramID, opts)
}

func (m *PaymentChannelRentCleanupManager) currentSlot(ctx context.Context, cache **uint64) (uint64, error) {
	if *cache != nil {
		return **cache, nil
	}
	slot, err := m.signer.GetSlot(ctx, m.network, SlotCommitment)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch the current slot: %w", err)
	}
	*cache = &slot
	return slot, nil
}

type reclaimCandidate struct {
	channelID solana.PublicKey
	rentPayer solana.PublicKey
}

func orderRentCleanupScan(records []PaymentChannelRecord, cursor string) []PaymentChannelRecord {
	sorted := make([]PaymentChannelRecord, len(records))
	copy(sorted, records)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].ChannelID < sorted[j].ChannelID })
	if cursor == "" {
		return sorted
	}
	for i, record := range sorted {
		if record.ChannelID == cursor {
			rotated := make([]PaymentChannelRecord, 0, len(sorted))
			rotated = append(rotated, sorted[i:]...)
			rotated = append(rotated, sorted[:i]...)
			return rotated
		}
	}
	return sorted
}

func openChannelDue(policy OpenAbandonPolicy, record PaymentChannelRecord, nowSecs, abandonGraceSecs, maxIdleSecs int64) bool {
	switch policy {
	case OpenAbandonPolicyExpiry:
		return nowSecs >= record.ExpiresAt+abandonGraceSecs
	case OpenAbandonPolicyIdle:
		if record.ExpiresAt != 0 {
			return nowSecs >= record.ExpiresAt+abandonGraceSecs
		}
		if maxIdleSecs <= 0 {
			return false
		}
		return nowSecs >= record.LastActivityAt.Unix()+maxIdleSecs
	default:
		return false
	}
}

func closeAction(status generated.ChannelStatus) RentCleanupCloseAction {
	switch status {
	case generated.ChannelStatus_Open:
		return RentCleanupCloseAbandon
	case generated.ChannelStatus_Closing:
		return RentCleanupCloseForced
	default:
		return RentCleanupCloseDistribute
	}
}

func (m *PaymentChannelRentCleanupManager) submitCloseOrDistribute(
	ctx context.Context,
	record PaymentChannelRecord,
	channel *generated.Channel,
	channelID solana.PublicKey,
) (string, error) {
	feePayer, err := m.resolveFeePayer(ctx, channel.Payee)
	if err != nil {
		return "", err
	}
	tokenProgram, err := solana.PublicKeyFromBase58(record.TokenProgram)
	if err != nil {
		return "", fmt.Errorf("channel %s has an invalid stored tokenProgram: %w", record.ChannelID, err)
	}
	distribute, err := BuildDistributeInstruction(DistributeInstructionArgs{
		Channel:      channelID,
		Payer:        channel.Payer,
		Payee:        channel.Payee,
		RentPayer:    channel.RentPayer,
		Mint:         channel.Mint,
		TokenProgram: tokenProgram,
		Splits:       []Split{{Recipient: record.PayTo, BPS: BasisPointsDenominator}},
		Network:      m.network,
	})
	if err != nil {
		return "", err
	}

	var instructions []solana.Instruction
	switch generated.ChannelStatus(channel.Status) {
	case generated.ChannelStatus_Open:
		settle, err := BuildSettleAndSealInstructions(SettleAndSealBuildArgs{ChannelID: channelID, Payee: channel.Payee})
		if err != nil {
			return "", err
		}
		instructions = append(append([]solana.Instruction(nil), settle...), distribute)
	case generated.ChannelStatus_Closing:
		instructions = []solana.Instruction{BuildSealInstruction(channelID), distribute}
	default:
		instructions = []solana.Instruction{distribute}
	}
	return SubmitChannelTransactionWithSigner(ctx, m.signer, m.signer, feePayer, m.network, instructions, SubmitSettleOptions{
		ComputeUnitLimit:              m.settleComputeUnitLimit,
		ComputeUnitPriceMicroLamports: m.computeUnitPriceMicroLamports,
	})
}

func (m *PaymentChannelRentCleanupManager) submitReclaimBatches(
	ctx context.Context,
	rpcClient ChannelRPC,
	candidates []reclaimCandidate,
	opts RentCleanupOptions,
) {
	if opts.MaxTxsPerSigner <= 0 || len(candidates) == 0 {
		return
	}
	byRentPayer := make(map[solana.PublicKey][]reclaimCandidate)
	var order []solana.PublicKey
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

func (m *PaymentChannelRentCleanupManager) submitReclaimGroup(
	ctx context.Context,
	rpcClient ChannelRPC,
	rentPayer solana.PublicKey,
	group []reclaimCandidate,
	opts RentCleanupOptions,
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
			instructions = append(instructions, BuildReclaimInstruction(candidate.channelID, candidate.rentPayer))
			channelIDs = append(channelIDs, candidate.channelID.String())
		}
		reclaimLimit := ReclaimComputeUnitLimit(len(batch))
		signature, err := SubmitChannelTransactionWithSigner(ctx, m.signer, m.signer, feePayer, m.network, instructions, SubmitSettleOptions{
			ComputeUnitLimit:              &reclaimLimit,
			ComputeUnitPriceMicroLamports: m.computeUnitPriceMicroLamports,
		})
		if err != nil {
			for _, channelID := range channelIDs {
				opts.reportError(err, channelID)
			}
			continue
		}
		if opts.OnReclaim != nil {
			opts.OnReclaim(RentCleanupReclaimResult{ChannelIDs: channelIDs, Transaction: signature})
		}
		for _, channelID := range channelIDs {
			if err := m.storage.Delete(ctx, m.network, channelID); err != nil {
				opts.reportError(err, channelID)
			}
		}
	}
}

func (m *PaymentChannelRentCleanupManager) refreshReclaimBatch(
	ctx context.Context,
	rpcClient ChannelRPC,
	batch []reclaimCandidate,
	opts RentCleanupOptions,
) []reclaimCandidate {
	live := make([]reclaimCandidate, 0, len(batch))
	for _, candidate := range batch {
		channel, exists, err := fetchChannelAccount(ctx, rpcClient, candidate.channelID)
		if err != nil {
			opts.reportError(err, candidate.channelID.String())
			continue
		}
		if !exists {
			if err := m.storage.Delete(ctx, m.network, candidate.channelID.String()); err != nil {
				opts.reportError(err, candidate.channelID.String())
			}
			continue
		}
		if generated.ChannelStatus(channel.Status) != generated.ChannelStatus_Distributed {
			continue
		}
		live = append(live, reclaimCandidate{channelID: candidate.channelID, rentPayer: channel.RentPayer})
	}
	return live
}

func (m *PaymentChannelRentCleanupManager) deleteIfGone(
	ctx context.Context,
	rpcClient ChannelRPC,
	channelID solana.PublicKey,
	storedID string,
	opts RentCleanupOptions,
) {
	exists, err := ChannelExists(ctx, rpcClient, channelID)
	if err != nil {
		opts.reportError(err, storedID)
		return
	}
	if exists {
		return
	}
	if err := m.storage.Delete(ctx, m.network, storedID); err != nil {
		opts.reportError(err, storedID)
	}
}

// deleteIfPastOpenGrace drops an index row whose account is missing, once the
// open grace has elapsed. A pending open is kept so a later confirmation still
// has its row.
func (m *PaymentChannelRentCleanupManager) deleteIfPastOpenGrace(ctx context.Context, record PaymentChannelRecord) error {
	if time.Now().Before(record.LastActivityAt.Add(time.Duration(OpenIndexGraceSecs) * time.Second)) {
		return nil
	}
	return m.storage.Delete(ctx, record.Network, record.ChannelID)
}

func (m *PaymentChannelRentCleanupManager) resolveFeePayer(ctx context.Context, address solana.PublicKey) (solana.PublicKey, error) {
	for _, managed := range m.signer.GetAddresses(ctx, m.network) {
		if managed.Equals(address) {
			return address, nil
		}
	}
	return solana.PublicKey{}, fmt.Errorf("channel key %s is not in the facilitator signer set", address)
}
