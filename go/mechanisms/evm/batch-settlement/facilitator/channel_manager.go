package facilitator

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

const defaultSettleQueryPageSize = 100

// IsChannelFinished reports whether this channel has no remaining claim, refund, or withdraw work.
func IsChannelFinished(channel *FacilitatorChannel, chargeCount int) bool {
	if chargeCount != 0 || channel == nil || channel.PendingClaim != nil {
		return false
	}
	if uintCmp(channel.ChargedCumulativeAmount, channel.TotalClaimed) > 0 {
		return false
	}
	return uintCmp(channel.Balance, channel.TotalClaimed) <= 0
}

// ShouldDeleteNeverClaimedRefundRow deletes a finished idle-refund row that never claimed onchain.
func ShouldDeleteNeverClaimedRefundRow(
	keepFinishedRows bool,
	channel *FacilitatorChannel,
	chargeCount int,
	appliedTotalClaimed string,
) bool {
	if keepFinishedRows {
		return false
	}
	if !IsChannelFinished(channel, chargeCount) {
		return false
	}
	claimed, ok := storage.ParseUint256(appliedTotalClaimed)
	return ok && claimed.Sign() == 0
}

// ShouldDeleteFinishedChannelAtSettle deletes a claimed finished row after receiver pending hits zero.
func ShouldDeleteFinishedChannelAtSettle(
	keepFinishedRows bool,
	channel *FacilitatorChannel,
	chargeCount int,
) bool {
	if keepFinishedRows {
		return false
	}
	return IsChannelFinished(channel, chargeCount)
}

// FacilitatorChannelManagerConfig is storage, signers, submit mode, and retention.
type FacilitatorChannelManagerConfig struct {
	Storage storage.ChannelStorage[*FacilitatorChannel]
	// LockStorage reserves a channel for the whole idle refund. Claim, settle,
	// and retention deletes do not use it. Nil falls back to Storage when
	// Storage implements ChannelLockStorage; otherwise idle refund runs without
	// a reservation and logs once.
	LockStorage         storage.ChannelLockStorage
	Signer              evm.FacilitatorEvmSigner
	AuthorizerSigner    batchsettlement.AuthorizerSigner
	AuthorizerSubmitter evm.FacilitatorEvmSigner
	SubmitMode          SubmitMode
	KeepFinishedRows    bool
	Context             *x402.FacilitatorContext
	// SettleTargetStorage tracks claimed (network, receiver, token) pairs.
	// Nil derives pairs from channel rows with totalClaimed > 0.
	SettleTargetStorage storage.SettleTargetStorage
	// Logger receives facilitator events. Nil uses slog.Default().
	Logger *slog.Logger
}

// atomicAmountPattern matches an integer atomic token amount. A leading "$" is rejected.
var atomicAmountPattern = regexp.MustCompile(`^\d+$`)

// TokenAmountGate is a per-token amount threshold for claim and settle.
type TokenAmountGate struct {
	// DefaultAssetAmount is a money string ("$1") for assets evm.FindDefaultAsset knows. Empty leaves them ungated.
	DefaultAssetAmount string
	// Assets override the dollar amount with an integer atomic threshold.
	Assets []TokenAtomicAmount
}

// TokenAtomicAmount is an explicit atomic threshold for one network and asset.
type TokenAtomicAmount struct {
	Network string
	Asset   string
	// Amount is an integer atomic string. A dollar value is a config error.
	Amount string
}

// Resolve returns the atomic threshold. ok is false when the token is ungated.
func (g TokenAmountGate) Resolve(network, token string) (atomic *big.Int, ok bool, err error) {
	for i := range g.Assets {
		entry := g.Assets[i]
		if !gateNetworkMatches(entry.Network, network) || !gateAssetMatches(entry.Asset, token, network) {
			continue
		}
		if !atomicAmountPattern.MatchString(entry.Amount) {
			return nil, false, fmt.Errorf(
				"token amount gate: asset amount must be an integer atomic amount, not a dollar value; got %q",
				entry.Amount,
			)
		}
		parsed, parsedOK := new(big.Int).SetString(entry.Amount, 10)
		if !parsedOK {
			return nil, false, fmt.Errorf(
				"token amount gate: asset amount must be an integer atomic amount, not a dollar value; got %q",
				entry.Amount,
			)
		}
		return parsed, true, nil
	}

	amount := strings.TrimSpace(g.DefaultAssetAmount)
	if amount == "" {
		return nil, false, nil
	}
	info := evm.FindDefaultAsset(token, network)
	if info == nil {
		return nil, false, nil
	}
	parsedMoney, err := x402.ParseMoneyString(amount)
	if err != nil {
		return nil, false, err
	}
	raw, err := x402.ConvertToTokenAmount(parsedMoney, info.Decimals)
	if err != nil {
		return nil, false, err
	}
	parsed, parsedOK := new(big.Int).SetString(raw, 10)
	if !parsedOK {
		return nil, false, fmt.Errorf("token amount gate: converted amount %q is not an integer", raw)
	}
	return parsed, true, nil
}

// active reports whether a dollar amount or an explicit asset is set.
func (g TokenAmountGate) active() bool {
	return strings.TrimSpace(g.DefaultAssetAmount) != "" || len(g.Assets) > 0
}

func gateNetworkMatches(pattern, network string) bool {
	if strings.EqualFold(pattern, network) {
		return true
	}
	return x402.MatchesNetwork(x402.Network(pattern), x402.Network(network))
}

func gateAssetMatches(entryAsset, token, network string) bool {
	if strings.EqualFold(entryAsset, token) {
		return true
	}
	info := evm.FindDefaultAsset(token, network)
	return info != nil && strings.EqualFold(info.Symbol, entryAsset)
}

// FacilitatorClaimOptions is optional batching and idle filter for Claim.
type FacilitatorClaimOptions struct {
	MaxClaimsPerBatch int
	IdleSecs          *int
	// MinUnclaimed is the per-token unclaimed threshold. Zero keeps any positive amount.
	MinUnclaimed TokenAmountGate
	// UnclaimedDesc sorts claimable rows highest-unclaimed first.
	UnclaimedDesc bool
	// MaxTxsPerRun caps claim transactions per run. The default selector reads
	// at most MaxTxsPerRun * MaxClaimsPerBatch rows.
	MaxTxsPerRun int
	// SelectClaimRows overrides claim selection. Nil queries up to capacity,
	// then orders withdraw-pending rows ahead of the highest unclaimed.
	SelectClaimRows func(ctx context.Context, query func(storage.ChannelQuery) ([]*FacilitatorChannel, error), capacity int) ([]*FacilitatorChannel, error)
	// OnError receives a batch failure. channelID is empty for a batch-level
	// failure and set for a row isolated by bisect. Nil logs the error.
	OnError func(err error, channelID string)
}

// FacilitatorRefundOptions bounds one idle-refund pass. IdleSecs must be > 0.
type FacilitatorRefundOptions struct {
	IdleSecs int
	Limit    int
	OnError  func(err error, channelID string)
}

// FacilitatorSettleOptions is optional batching and pending filters for Settle.
type FacilitatorSettleOptions struct {
	// MinPending skips onchain pending at or below the per-token threshold. Zero settles any positive pending.
	MinPending          TokenAmountGate
	MaxSettlesPerTx     int
	MaxTxsPerRun        int
	SettleQueryPageSize int
	// OnError receives a batch failure. target is nil for a batch-level failure.
	// Nil logs the error.
	OnError func(err error, target *storage.SettleTarget)
}

// FacilitatorAutoConfig is interval, idle-refund, and callback configuration.
type FacilitatorAutoConfig struct {
	ClaimIntervalSecs  *int
	SettleIntervalSecs *int
	RefundIntervalSecs *int
	RefundIdleSecs     *int
	MaxClaimsPerBatch  int
	OnClaim            func(FacilitatorClaimResult)
	OnSettle           func(FacilitatorSettleResult)
	OnRefund           func(FacilitatorRefundResult)
	OnError            func(error)
}

// FacilitatorClaimResult is one submitted claim batch.
type FacilitatorClaimResult struct {
	Network     string
	Vouchers    int
	Transaction string
}

// FacilitatorSettleResult is one settle transaction.
type FacilitatorSettleResult struct {
	Network     string
	Receiver    string
	Token       string
	Transaction string
}

// FacilitatorRefundResult is one refunded or claim-only channel.
type FacilitatorRefundResult struct {
	Network     string
	Channel     string
	Transaction string
}

type autoJob string

const (
	autoJobClaim  autoJob = "claim"
	autoJobSettle autoJob = "settle"
	autoJobRefund autoJob = "refund"
)

var autoJobPriority = []autoJob{autoJobClaim, autoJobSettle, autoJobRefund}

func formatFailure(operation string, response *x402.SettleResponse) string {
	reason := "unknown"
	msg := ""
	if response != nil {
		if response.ErrorReason != "" {
			reason = response.ErrorReason
		}
		msg = response.ErrorMessage
	}
	return fmt.Sprintf("%s failed: %s — %s", operation, reason, msg)
}

// AfterClaim records settle targets, then merges claimed totals and subtracts each pending claim marker.
// The marker is matched on ClaimedTo == claim.TotalClaimed.
// Call only after a successful onchain claim whose rows all emitted Claimed.
func AfterClaim(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	targetStore storage.SettleTargetStorage,
) error {
	return afterClaim(ctx, store, claims, network, targetStore, nil, nil, nil)
}

// afterClaim records settle-target deltas, then applies each channel marker.
// begun holds the markers this caller wrote. A channel without an entry matches its marker on ClaimedTo.
// claimed holds the ClaimRowKeys of the Claimed events in the receipt. Only the rows they match
// were attested onchain (each event once), so only those markers are subtracted; a no-op row keeps
// its count pending for the channel's next claim. A nil claimed means every row emitted Claimed.
// Deltas come from the pre-finish watermark. A crash replay may add a delta twice.
// ObserveSettlePending replaces the cache with the onchain pending, so the extra amount does not stick.
func afterClaim(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	targetStore storage.SettleTargetStorage,
	known []*FacilitatorChannel,
	begun []attestedClaim,
	claimed map[string]struct{},
) error {
	items := make(map[string]attestedClaim, len(begun))
	for _, item := range begun {
		items[strings.ToLower(item.ChannelID)] = item
	}
	deltas, err := settleTargetClaimDeltas(ctx, store, claims, network, known)
	if err != nil {
		return err
	}
	if len(deltas) > 0 {
		if targetStore == nil {
			return fmt.Errorf("settle target storage is required")
		}
		for _, delta := range deltas {
			if err := targetStore.RecordClaimed(ctx, delta); err != nil {
				return err
			}
		}
	}
	attestedChannels := attestedChannelIDs(claims, network, claimed)
	finishErrs := make([]error, len(claims))
	forEachChannel(len(claims), func(i int) {
		channelID, err := batchsettlement.ComputeChannelId(claims[i].Voucher.Channel, network)
		if err != nil {
			finishErrs[i] = err
			return
		}
		claimedTo := claims[i].TotalClaimed
		item, ok := items[strings.ToLower(channelID)]
		if !ok {
			item = attestedClaim{ChannelID: channelID, ClaimedTo: claimedTo}
		}
		attested := attestedChannels[strings.ToLower(channelID)]
		finishErrs[i] = retryChannelUpdate(ctx, func() error {
			return finishAttestedClaim(ctx, store, channelID, claimedTo, item, attested)
		})
	})
	return errors.Join(finishErrs...)
}

// attestedChannelIDs returns the lowercase channelIds with at least one claim row that emitted
// Claimed. A row matches the event with the same (channelId, totalClaimed), and each event matches
// at most one row, so a no-op duplicate row never attests. A channel's rows are snapshots of one
// counter and share one marker, so it is subtracted once per channel. A nil claimed means the
// caller did not gate on the receipt, so every row counts.
func attestedChannelIDs(
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	claimed map[string]struct{},
) map[string]bool {
	out := make(map[string]bool, len(claims))
	unconsumed := make(map[string]struct{}, len(claimed))
	for key := range claimed {
		unconsumed[key] = struct{}{}
	}
	for _, claim := range claims {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			continue
		}
		if claimed == nil {
			out[strings.ToLower(channelID)] = true
			continue
		}
		rowKey := batchsettlement.ClaimRowKey(channelID, claim.TotalClaimed)
		if _, ok := unconsumed[rowKey]; ok {
			delete(unconsumed, rowKey)
			out[strings.ToLower(channelID)] = true
		}
	}
	return out
}

// rowEmittedClaimed reports whether the claim row for channelID set totalClaimed and emitted
// Claimed. A nil claimed means the caller did not gate on the receipt, so every row counts.
func rowEmittedClaimed(claimed map[string]struct{}, channelID, totalClaimed string) bool {
	if claimed == nil {
		return true
	}
	_, ok := claimed[batchsettlement.ClaimRowKey(channelID, totalClaimed)]
	return ok
}

func rowLookup(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	known []*FacilitatorChannel,
) func(channelID string) (*FacilitatorChannel, error) {
	rows := make(map[string]*FacilitatorChannel, len(known))
	for _, row := range known {
		if row != nil {
			rows[strings.ToLower(row.ChannelId)] = row
		}
	}
	return func(channelID string) (*FacilitatorChannel, error) {
		if row := rows[strings.ToLower(channelID)]; row != nil {
			return row, nil
		}
		return store.Get(ctx, channelID)
	}
}

func settleTargetClaimDeltas(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	known []*FacilitatorChannel,
) ([]storage.SettleTargetClaimDelta, error) {
	lookup := rowLookup(ctx, store, known)
	type aggregated struct {
		receiver string
		token    string
		amount   *big.Int
	}
	byPair := make(map[string]*aggregated)
	order := make([]string, 0)
	for _, claim := range claims {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, err
		}
		stored, err := lookup(channelID)
		if err != nil {
			return nil, err
		}
		oldClaimed := "0"
		if stored != nil {
			oldClaimed = stored.TotalClaimed
		}
		delta := claimDeltaAmount(claim.TotalClaimed, oldClaimed)
		if delta == nil {
			continue
		}
		pairKey := strings.ToLower(claim.Voucher.Channel.Receiver) + "\x00" + strings.ToLower(claim.Voucher.Channel.Token)
		slot := byPair[pairKey]
		if slot == nil {
			slot = &aggregated{
				receiver: claim.Voucher.Channel.Receiver,
				token:    claim.Voucher.Channel.Token,
				amount:   new(big.Int),
			}
			byPair[pairKey] = slot
			order = append(order, pairKey)
		}
		slot.amount.Add(slot.amount, delta)
	}
	out := make([]storage.SettleTargetClaimDelta, 0, len(order))
	for _, pairKey := range order {
		slot := byPair[pairKey]
		out = append(out, storage.SettleTargetClaimDelta{
			Network:  network,
			Receiver: slot.receiver,
			Token:    slot.token,
			Amount:   slot.amount,
		})
	}
	return out, nil
}

// claimDeltaAmount is newClaimed - oldClaimed when the claim moved the watermark forward.
func claimDeltaAmount(newClaimed, oldClaimed string) *big.Int {
	next, ok := storage.ParseUint256(newClaimed)
	if !ok || next.Sign() <= 0 {
		return nil
	}
	prev := new(big.Int)
	if parsed, ok := storage.ParseUint256(oldClaimed); ok {
		prev = parsed
	}
	if next.Cmp(prev) <= 0 {
		return nil
	}
	return new(big.Int).Sub(next, prev)
}

func applyClaimedSettleDelta(
	ctx context.Context,
	targets storage.SettleTargetStorage,
	network, receiver, token, newClaimed, oldClaimed string,
) error {
	delta := claimDeltaAmount(newClaimed, oldClaimed)
	if delta == nil {
		return nil
	}
	if targets == nil {
		return fmt.Errorf("settle target storage is required")
	}
	return targets.RecordClaimed(ctx, storage.SettleTargetClaimDelta{
		Network:  network,
		Receiver: receiver,
		Token:    token,
		Amount:   delta,
	})
}

func refundClaimedTotal(
	stored string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	extra map[string]interface{},
) string {
	if extra != nil {
		if claimed, ok := extra["totalClaimed"].(string); ok && claimed != "" {
			return claimed
		}
	}
	best := stored
	for _, claim := range claims {
		if uintCmp(claim.TotalClaimed, best) > 0 {
			best = claim.TotalClaimed
		}
	}
	return best
}

// FacilitatorChannelManager is the facilitator-side claim / settle / idle-refund scheduler.
type FacilitatorChannelManager struct {
	storage             storage.ChannelStorage[*FacilitatorChannel]
	lockStorage         storage.ChannelLockStorage
	signer              evm.FacilitatorEvmSigner
	authorizerSigner    batchsettlement.AuthorizerSigner
	authorizerSubmitter evm.FacilitatorEvmSigner
	submitMode          SubmitMode
	keepFinishedRows    bool
	context             *x402.FacilitatorContext
	settleTargetStorage storage.SettleTargetStorage
	logger              *slog.Logger
	idleRefundLockWarn  sync.Once

	mu            sync.Mutex
	timers        map[autoJob]*time.Ticker
	stopChans     map[autoJob]chan struct{}
	running       bool
	pendingJobs   map[autoJob]struct{}
	drainingJobs  bool
	autoConfig    FacilitatorAutoConfig
	pendingSettle bool
}

// NewFacilitatorChannelManager creates a facilitator channel manager.
func NewFacilitatorChannelManager(config FacilitatorChannelManagerConfig) (*FacilitatorChannelManager, error) {
	if err := AssertDirectAuthorizerSubmitter(config.SubmitMode, config.AuthorizerSigner, config.AuthorizerSubmitter); err != nil {
		return nil, err
	}
	lockStorage := channelLockStorage(config.LockStorage, config.Storage)
	submitMode := config.SubmitMode
	if submitMode == "" {
		submitMode = SubmitModeRelay
	}
	settleTargets := config.SettleTargetStorage
	if settleTargets == nil {
		settleTargets = storage.NewChannelSettleTargets(config.Storage)
	}
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &FacilitatorChannelManager{
		storage:             config.Storage,
		lockStorage:         lockStorage,
		signer:              config.Signer,
		authorizerSigner:    config.AuthorizerSigner,
		authorizerSubmitter: config.AuthorizerSubmitter,
		submitMode:          submitMode,
		keepFinishedRows:    config.KeepFinishedRows,
		context:             config.Context,
		settleTargetStorage: settleTargets,
		logger:              logger,
		timers:              make(map[autoJob]*time.Ticker),
		stopChans:           make(map[autoJob]chan struct{}),
		pendingJobs:         make(map[autoJob]struct{}),
	}, nil
}

// Claim claims eligible vouchers, grouped by network, withdraw-pending first.
// A failed batch is reported through OnError and skipped. Successful batches
// are still applied. The error is set only for a query failure or a canceled context.
func (m *FacilitatorChannelManager) Claim(ctx context.Context, opts *FacilitatorClaimOptions) ([]FacilitatorClaimResult, error) {
	maxClaimsPerBatch := 100
	if opts != nil && opts.MaxClaimsPerBatch > 0 {
		maxClaimsPerBatch = opts.MaxClaimsPerBatch
	}
	rows, err := m.loadClaimRows(ctx, opts, maxClaimsPerBatch)
	if err != nil {
		return nil, err
	}
	maxTxsPerRun := 0
	if opts != nil && opts.MaxTxsPerRun > 0 {
		maxTxsPerRun = opts.MaxTxsPerRun
	}
	byNetwork, order := groupByNetwork(rows)
	results := make([]FacilitatorClaimResult, 0)

	for _, network := range order {
		group := byNetwork[network]
		claims := storage.SelectClaimableVouchers(channelBases(group), &storage.SelectClaimableOptions{Now: time.Now().UnixMilli()})
		if len(claims) == 0 {
			continue
		}
		txCount := 0
		for i := 0; i < len(claims); i += maxClaimsPerBatch {
			if err := ctx.Err(); err != nil {
				return results, err
			}
			if maxTxsPerRun > 0 && txCount >= maxTxsPerRun {
				break
			}
			end := i + maxClaimsPerBatch
			if end > len(claims) {
				end = len(claims)
			}
			batchResults, err := m.claimSlice(ctx, network, claims[i:end], group, opts)
			if err != nil {
				if ctx.Err() != nil {
					return results, ctx.Err()
				}
				var batchErr *batchClaimError
				if errors.As(err, &batchErr) {
					reportClaimError(m.logger, opts, batchErr.err, "")
					txCount++
					continue
				}
				return results, err
			}
			if len(batchResults) == 0 {
				continue
			}
			txCount += len(batchResults)
			results = append(results, batchResults...)
		}
	}
	return results, nil
}

type receiverPendingRead struct {
	target  storage.SettleTarget
	pending *big.Int
}

// Settle settles eligible receiver pairs and cleans up when pending reaches zero.
// One receivers() eth_call selects one settle tx. That tx submits the pairs
// from that read that are above MinPending, and does not take pairs from the
// next read. A failed read is skipped when another batch succeeds. Every read
// failing is returned.
func (m *FacilitatorChannelManager) Settle(
	ctx context.Context,
	opts *FacilitatorSettleOptions,
) ([]FacilitatorSettleResult, error) {
	maxSettlesPerTx, maxTxsPerRun, pageSize, gate := settlePassLimits(opts)
	receiverBudget := maxSettlesPerTx * maxTxsPerRun
	targets, err := m.collectSettleTargetPages(ctx, pageSize, receiverBudget)
	if err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		return nil, nil
	}

	byNetwork := make(map[string][]storage.SettleTarget)
	networkOrder := make([]string, 0)
	for _, target := range targets {
		if _, ok := byNetwork[target.Network]; !ok {
			networkOrder = append(networkOrder, target.Network)
		}
		byNetwork[target.Network] = append(byNetwork[target.Network], target)
	}

	results := make([]FacilitatorSettleResult, 0)
	var failed []error
	readAny := false
	for _, network := range networkOrder {
		group := byNetwork[network]
		txCount := 0
		for i := 0; i < len(group) && txCount < maxTxsPerRun; i += maxSettlesPerTx {
			if err := ctx.Err(); err != nil {
				return results, err
			}
			end := i + maxSettlesPerTx
			if end > len(group) {
				end = len(group)
			}
			batch := group[i:end]
			reads, readAt, err := m.readReceiverPendingChunk(ctx, batch)
			if err != nil {
				if ctx.Err() != nil {
					return results, ctx.Err()
				}
				failed = append(failed, fmt.Errorf("receiver pending read of %d: %w", len(batch), err))
				continue
			}
			readAny = true
			eligible, err := m.receiversToSettle(ctx, reads, gate, opts, readAt)
			if err != nil {
				return results, err
			}
			if len(eligible) == 0 {
				continue
			}
			payload := &batchsettlement.BatchSettlementSettlePayload{
				Type:     "settle",
				Receiver: eligible[0].Receiver,
				Token:    eligible[0].Token,
			}
			dataSuffix, err := m.resolveBuilderSuffix(network, payload.ToMap(), eligible[0].Token, eligible[0].Receiver, nil)
			if err != nil {
				if ctx.Err() != nil {
					return results, ctx.Err()
				}
				reportSettleError(m.logger, opts, err, nil)
				continue
			}
			submissions, skipped, err := submitSettleMulticall(ctx, m.logger, m.signer, x402.Network(network), eligible, dataSuffix)
			for _, skip := range skipped {
				target := skip.target
				if opts != nil && opts.OnError != nil {
					opts.OnError(skip.err, &target)
				}
			}
			batchResults := settleResultsFromSubmissions(string(network), submissions)
			results = append(results, batchResults...)
			if err != nil {
				if ctx.Err() != nil {
					return results, ctx.Err()
				}
				reportSettleError(m.logger, opts, err, nil)
			}
			if len(submissions) == 0 {
				continue
			}
			txCount++
			for _, sub := range submissions {
				if err := m.confirmSettledTargets(ctx, sub.targets, opts); err != nil {
					return results, err
				}
			}
		}
	}
	if !readAny && len(failed) > 0 {
		return results, errors.Join(failed...)
	}
	for _, err := range failed {
		reportSettleError(m.logger, opts, err, nil)
	}
	return results, nil
}

// receiversToSettle keeps pairs from one receivers() read that this batch's tx will submit.
func (m *FacilitatorChannelManager) receiversToSettle(
	ctx context.Context,
	reads []receiverPendingRead,
	gate TokenAmountGate,
	opts *FacilitatorSettleOptions,
	readAt int64,
) ([]storage.SettleTarget, error) {
	m.observeSettlePending(ctx, reads, time.Now().UnixMilli(), readAt)
	eligible := make([]storage.SettleTarget, 0, len(reads))
	for _, row := range reads {
		if row.pending.Sign() == 0 {
			if err := m.cleanupSettledPair(ctx, row.target, readAt); err != nil {
				target := row.target
				reportSettleError(m.logger, opts, err, &target)
			}
			continue
		}
		atomic, gated, err := gate.Resolve(row.target.Network, row.target.Token)
		if err != nil {
			return nil, err
		}
		if gated && row.pending.Cmp(atomic) <= 0 {
			continue
		}
		eligible = append(eligible, row.target)
	}
	return eligible, nil
}

// confirmSettledTargets re-reads the pairs one settle tx just submitted.
func (m *FacilitatorChannelManager) confirmSettledTargets(
	ctx context.Context,
	targets []storage.SettleTarget,
	opts *FacilitatorSettleOptions,
) error {
	confirm, readAt, err := m.readReceiverPendingChunk(ctx, targets)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		reportSettleError(m.logger, opts, fmt.Errorf("receiver pending confirm of %d: %w", len(targets), err), nil)
		return nil
	}
	m.observeSettlePending(ctx, confirm, time.Now().UnixMilli(), readAt)
	for _, row := range confirm {
		if row.pending.Sign() != 0 {
			continue
		}
		if err := m.cleanupSettledPair(ctx, row.target, readAt); err != nil {
			target := row.target
			reportSettleError(m.logger, opts, err, &target)
		}
	}
	return nil
}

func (m *FacilitatorChannelManager) observeSettlePending(ctx context.Context, reads []receiverPendingRead, atMillis, readAt int64) {
	observer, ok := m.settleTargetStorage.(storage.SettleTargetObserver)
	if !ok || len(reads) == 0 {
		return
	}
	obs := make([]storage.SettleTargetObservation, 0, len(reads))
	for _, row := range reads {
		obs = append(obs, storage.SettleTargetObservation{
			Target:        row.target,
			Pending:       row.pending,
			AtMillis:      atMillis,
			UpdatedBefore: readAt,
		})
	}
	if err := observer.ObserveSettlePending(ctx, obs); err != nil {
		m.logger.Warn("batch-settlement: observe settle pending", "error", err)
	}
}

func settlePassLimits(opts *FacilitatorSettleOptions) (maxSettlesPerTx, maxTxsPerRun, pageSize int, gate TokenAmountGate) {
	maxSettlesPerTx = 100
	maxTxsPerRun = 100
	pageSize = defaultSettleQueryPageSize
	if opts != nil {
		if opts.MaxSettlesPerTx > 0 {
			maxSettlesPerTx = opts.MaxSettlesPerTx
		}
		if opts.MaxTxsPerRun > 0 {
			maxTxsPerRun = opts.MaxTxsPerRun
		}
		if opts.SettleQueryPageSize > 0 {
			pageSize = opts.SettleQueryPageSize
		}
		gate = opts.MinPending
	}
	return maxSettlesPerTx, maxTxsPerRun, pageSize, gate
}

func (m *FacilitatorChannelManager) collectSettleTargetPages(
	ctx context.Context,
	pageSize int,
	budget int,
) ([]storage.SettleTarget, error) {
	if budget <= 0 {
		return nil, nil
	}
	out := make([]storage.SettleTarget, 0, budget)
	cursor := ""
	for len(out) < budget {
		limit := pageSize
		if budget-len(out) < limit {
			limit = budget - len(out)
		}
		// The per-token gate is applied after the on-chain read.
		page, err := m.settleTargetStorage.ListSettleTargets(ctx, storage.SettleQuery{
			Limit:  &limit,
			Cursor: cursor,
		})
		if err != nil {
			return nil, err
		}
		if page == nil || len(page.Items) == 0 {
			break
		}
		out = append(out, page.Items...)
		if page.Cursor == "" || len(out) >= budget {
			break
		}
		cursor = page.Cursor
	}
	return out, nil
}

// readReceiverPendingChunk is one receivers() eth_call for a single settle batch.
// readAt is captured before the call so a claim that lands during the read keeps its settle row.
func (m *FacilitatorChannelManager) readReceiverPendingChunk(
	ctx context.Context,
	targets []storage.SettleTarget,
) ([]receiverPendingRead, int64, error) {
	if len(targets) == 0 {
		return nil, 0, nil
	}
	readAt := time.Now().UnixMilli()
	network := targets[0].Network
	calls := make([]evm.MulticallCall, 0, len(targets))
	for _, target := range targets {
		calls = append(calls, evm.MulticallCall{
			Address:      batchsettlement.BatchSettlementAddress,
			ABI:          batchsettlement.BatchSettlementReceiversABI,
			FunctionName: "receivers",
			Args:         []interface{}{common.HexToAddress(target.Receiver), common.HexToAddress(target.Token)},
		})
	}
	results, err := m.readMulticall(ctx, network, calls)
	if err != nil {
		return nil, 0, err
	}
	out := make([]receiverPendingRead, 0, len(targets))
	for i, target := range targets {
		if !results[i].Success() {
			m.logger.Warn("batch-settlement: settle receiver read failed", "receiver", target.Receiver, "token", target.Token, "network", target.Network)
			continue
		}
		totalClaimed, totalSettled, parseErr := parseReceiversMulticallResult(results[i].Result)
		if parseErr != nil {
			m.logger.Warn("batch-settlement: settle receiver read failed", "receiver", target.Receiver, "token", target.Token, "network", target.Network, "error", parseErr)
			continue
		}
		pending := new(big.Int).Sub(totalClaimed, totalSettled)
		if pending.Sign() < 0 {
			pending = new(big.Int)
		}
		out = append(out, receiverPendingRead{target: target, pending: pending})
	}
	return out, readAt, nil
}

func parseReceiversMulticallResult(raw interface{}) (*big.Int, *big.Int, error) {
	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return nil, nil, fmt.Errorf("receivers returned %T, want two uint128 values", raw)
	}
	totalClaimed, ok := outputs[0].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalClaimed returned %T, want *big.Int", outputs[0])
	}
	totalSettled, ok := outputs[1].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalSettled returned %T, want *big.Int", outputs[1])
	}
	return totalClaimed, totalSettled, nil
}

func (m *FacilitatorChannelManager) cleanupSettledPair(
	ctx context.Context,
	target storage.SettleTarget,
	readAt int64,
) error {
	if err := m.settleTargetStorage.RemoveSettleTarget(ctx, target, readAt); err != nil {
		return err
	}
	if m.keepFinishedRows {
		return nil
	}
	deleteFinished := func(row *FacilitatorChannel) error {
		if row == nil {
			return nil
		}
		_, err := m.storage.UpdateChannel(ctx, row.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
			if current == nil || !ShouldDeleteFinishedChannelAtSettle(m.keepFinishedRows, current, current.ChargeCount) {
				return current
			}
			return nil
		})
		return err
	}
	if scanner, ok := m.storage.(storage.ChannelReceiverTokenScanner[*FacilitatorChannel]); ok {
		return scanner.ScanByReceiverToken(ctx, target.Network, target.Receiver, target.Token, deleteFinished)
	}
	rows, err := storage.QueryChannelsByReceiverToken(ctx, m.storage, target.Network, target.Receiver, target.Token)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := deleteFinished(row); err != nil {
			return err
		}
	}
	return nil
}

// ClaimAndSettle claims eligible vouchers then settles.
func (m *FacilitatorChannelManager) ClaimAndSettle(ctx context.Context, opts *FacilitatorClaimOptions) (claims []FacilitatorClaimResult, settle []FacilitatorSettleResult, err error) {
	claims, claimErr := m.Claim(ctx, opts)
	if len(claims) > 0 {
		var settleErr error
		settle, settleErr = m.Settle(ctx, nil)
		if settleErr != nil {
			return claims, nil, errors.Join(claimErr, settleErr)
		}
	}
	return claims, settle, claimErr
}

// RefundIdleChannels refunds idle channels that still hold escrow.
// A failure on one channel is reported through OnError and the pass continues.
func (m *FacilitatorChannelManager) RefundIdleChannels(ctx context.Context, opts FacilitatorRefundOptions) ([]FacilitatorRefundResult, error) {
	if opts.IdleSecs <= 0 {
		return nil, fmt.Errorf("refund idleSecs must be greater than 0")
	}
	idleAt := time.Now().UnixMilli() - int64(opts.IdleSecs)*1000
	channels, err := m.queryRefundable(ctx, &idleAt, opts.Limit)
	if err != nil {
		return nil, err
	}
	return m.refundChannels(ctx, channels, &idleAt, opts.OnError)
}

func (m *FacilitatorChannelManager) queryRefundable(ctx context.Context, idleAt *int64, limit int) ([]*FacilitatorChannel, error) {
	if limit <= 0 {
		limit = 100
	}
	page, err := storage.QueryChannels(ctx, m.storage, storage.ChannelQuery{
		Kind:           storage.QueryKindIdleRefundable,
		IdleAtOrBefore: idleAt,
		Limit:          &limit,
	}, nil)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (m *FacilitatorChannelManager) refundChannels(ctx context.Context, channels []*FacilitatorChannel, idleAt *int64, onError func(error, string)) ([]FacilitatorRefundResult, error) {
	results := make([]FacilitatorRefundResult, 0)
	for _, channel := range channels {
		if err := ctx.Err(); err != nil {
			return results, err
		}
		if channel == nil {
			continue
		}
		result, err := m.refundReserved(ctx, channel, idleAt)
		if err != nil {
			if ctx.Err() != nil {
				return results, ctx.Err()
			}
			reportRefundError(m.logger, onError, err, channel.ChannelId)
			continue
		}
		if result != nil {
			results = append(results, *result)
		}
	}
	return results, nil
}

// refundReserved holds the admission lock for one idle refund, re-reads the row,
// and releases the lock when the refund returns. The TTL is storage.MaxPendingTtlMs,
// the same ceiling as a verify lock. A channel that is already reserved is skipped.
// Without a lock store the queried row is refunded as-is.
func (m *FacilitatorChannelManager) refundReserved(ctx context.Context, queried *FacilitatorChannel, idleAt *int64) (*FacilitatorRefundResult, error) {
	target := queried
	if m.lockStorage == nil {
		m.idleRefundLockWarn.Do(func() {
			m.logger.Warn("batch-settlement: idle refund running without an admission lock")
		})
	} else {
		owner, err := newRefundLockOwner()
		if err != nil {
			return nil, err
		}
		acquired, err := m.lockStorage.Acquire(ctx, queried.ChannelId, owner, storage.MaxPendingTtlMs)
		if err != nil {
			return nil, err
		}
		if !acquired {
			return nil, nil
		}
		defer m.releaseRefundLock(ctx, queried.ChannelId, owner)
		fresh, err := m.storage.Get(ctx, queried.ChannelId)
		if err != nil {
			return nil, err
		}
		if !storage.MatchesChannelQuery(fresh.Base(), storage.ChannelQuery{
			Kind:           storage.QueryKindIdleRefundable,
			IdleAtOrBefore: idleAt,
		}) {
			return nil, nil
		}
		target = fresh
	}
	return m.refundChannel(ctx, target)
}

func (m *FacilitatorChannelManager) releaseRefundLock(ctx context.Context, channelId, owner string) {
	if err := m.lockStorage.Release(ctx, channelId, owner); err != nil {
		m.logger.Warn("batch-settlement: idle refund lock release failed", "channel_id", channelId, "error", err)
	}
}

func newRefundLockOwner() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

func (m *FacilitatorChannelManager) refundChannel(ctx context.Context, target *FacilitatorChannel) (*FacilitatorRefundResult, error) {
	claims := rebuildClaims(target)
	bal, _ := new(big.Int).SetString(target.Balance, 10)
	charged, _ := new(big.Int).SetString(target.ChargedCumulativeAmount, 10)
	if bal == nil {
		bal = new(big.Int)
	}
	if charged == nil {
		charged = new(big.Int)
	}
	refundAmount := new(big.Int).Sub(bal, charged)

	if refundAmount.Sign() <= 0 && len(claims) == 0 {
		return nil, nil
	}
	if refundAmount.Sign() <= 0 {
		results, err := m.claimSlice(ctx, target.Network, claims, []*FacilitatorChannel{target}, nil)
		if err != nil {
			return nil, err
		}
		if len(results) == 0 {
			return nil, nil
		}
		return &FacilitatorRefundResult{
			Network:     target.Network,
			Channel:     target.ChannelId,
			Transaction: results[0].Transaction,
		}, nil
	}

	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: target.ChannelConfig,
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          target.ChannelId,
			MaxClaimableAmount: target.SignedMaxClaimable,
			Signature:          target.Signature,
		},
		Amount:      refundAmount.String(),
		RefundNonce: fmt.Sprintf("%d", target.RefundNonce),
		Claims:      claims,
	}
	dataSuffix, err := m.resolveBuilderSuffix(target.Network, payload.ToMap(), target.ChannelConfig.Token, target.ChannelConfig.Receiver, nil)
	if err != nil {
		return nil, err
	}
	var begun []attestedClaim
	if len(claims) > 0 {
		one, result, beginErr := beginAttestedClaim(ctx, m.storage, target.ChannelId, claims[0], time.Now().UnixMilli())
		if beginErr != nil {
			return nil, beginErr
		}
		switch result {
		case beginStarted:
		case beginBusy, beginSuperseded, beginAlreadyClaimed, beginMissing:
			return nil, errAttestedClaimBusy
		default:
			return nil, fmt.Errorf("unexpected begin result %d", result)
		}
		begun = []attestedClaim{one}
		dataSuffix, err = m.resolveBuilderSuffix(target.Network, payload.ToMap(), target.ChannelConfig.Token, target.ChannelConfig.Receiver,
			batchsettlement.ChargeCountsMetadata([]uint64{chargeCountUint(one.Count)}))
		if err != nil {
			_ = abortAttestedClaims(ctx, m.storage, begun)
			return nil, err
		}
	}
	claimed := map[string]struct{}{}
	response, err := SubmitRefund(ctx, SubmitRefundInput{
		Network:    target.Network,
		Payload:    payload,
		DataSuffix: dataSuffix,
		OnClaimed:  func(ids map[string]struct{}) { claimed = ids },
	}, m.submitContext())
	landed, releaseErr := releaseAttestedClaims(ctx, m.storage, begun, err, response)
	if err != nil {
		if releaseErr != nil {
			return nil, releaseErr
		}
		return nil, err
	}
	if releaseErr != nil && !landed {
		return nil, releaseErr
	}
	if !landed {
		return nil, fmt.Errorf("%s", formatFailure("Refund", response))
	}
	if err := m.afterRefund(ctx, target, claims, begun, claimed, response); err != nil {
		return nil, err
	}
	if releaseErr != nil {
		return nil, releaseErr
	}
	return &FacilitatorRefundResult{
		Network:     target.Network,
		Channel:     target.ChannelId,
		Transaction: response.Transaction,
	}, nil
}

func (m *FacilitatorChannelManager) afterRefund(
	ctx context.Context,
	target *FacilitatorChannel,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	begun []attestedClaim,
	claimed map[string]struct{},
	response *x402.SettleResponse,
) error {
	var refunded map[string]interface{}
	if response != nil && response.Extra != nil {
		refunded, _ = response.Extra["channelState"].(map[string]interface{})
	}
	if len(claims) > 0 {
		current, err := m.storage.Get(ctx, target.ChannelId)
		if err != nil {
			return err
		}
		oldClaimed := target.TotalClaimed
		if current != nil && current.TotalClaimed != "" {
			oldClaimed = current.TotalClaimed
		}
		newClaimed := refundClaimedTotal(oldClaimed, claims, refunded)
		if err := applyClaimedSettleDelta(ctx, m.settleTargetStorage, target.Network, target.ChannelConfig.Receiver, target.ChannelConfig.Token, newClaimed, oldClaimed); err != nil {
			return err
		}
		item := attestedClaim{ChannelID: target.ChannelId, ClaimedTo: claims[0].TotalClaimed}
		if len(begun) > 0 {
			item = begun[0]
		}
		if err := finishAttestedClaim(ctx, m.storage, target.ChannelId, newClaimed, item, rowEmittedClaimed(claimed, target.ChannelId, claims[0].TotalClaimed)); err != nil {
			return err
		}
	}

	if err := updateChannelStrict(ctx, m.storage, target.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		return applyRefundChannel(current, claims, refunded, m.keepFinishedRows)
	}); err != nil {
		return err
	}
	return nil
}

func applyRefundChannel(
	current *FacilitatorChannel,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	refunded map[string]interface{},
	keepFinishedRows bool,
) *FacilitatorChannel {
	if current == nil {
		return current
	}
	next := current.Clone()
	if len(claims) > 0 {
		for _, claim := range claims {
			applyClaimedAmount(next, claim.TotalClaimed)
		}
	}
	if refunded != nil {
		if v, ok := refunded["balance"].(string); ok {
			next.Balance = v
		}
		if v, ok := refunded["totalClaimed"].(string); ok {
			next.TotalClaimed = storage.MaxUint256String(next.TotalClaimed, v)
		}
		next.RefundNonce = refundNonceFromExtra(current.RefundNonce, refunded)
		if n, ok := extraNumber(refunded["withdrawRequestedAt"]); ok {
			next.WithdrawRequestedAt = n
		}
	}
	if ShouldDeleteNeverClaimedRefundRow(keepFinishedRows, next, next.ChargeCount, next.TotalClaimed) {
		return nil
	}
	return next
}

func applyClaimedAmount(next *FacilitatorChannel, claimed string) {
	claimedAmount, ok := new(big.Int).SetString(claimed, 10)
	if !ok || claimedAmount.Sign() < 0 {
		return
	}
	currentClaimed, ok := new(big.Int).SetString(next.TotalClaimed, 10)
	if !ok || currentClaimed.Sign() < 0 {
		return
	}
	if claimedAmount.Cmp(currentClaimed) <= 0 {
		return
	}
	next.TotalClaimed = claimedAmount.String()
}

func (m *FacilitatorChannelManager) resolveBuilderSuffix(
	network string,
	payload map[string]interface{},
	asset string,
	payTo string,
	metadata map[string]any,
) ([]byte, error) {
	return evm.ResolveDataSuffix(m.context, scheduledSuffixContext(network, payload, asset, payTo, metadata))
}

func (m *FacilitatorChannelManager) submitContext() SubmitContext {
	return SubmitContext{
		SubmitMode:          m.submitMode,
		Signer:              m.signer,
		AuthorizerSigner:    m.authorizerSigner,
		AuthorizerSubmitter: m.authorizerSubmitter,
	}
}

// scheduledSuffixContext builds the suffix context for a facilitator-initiated transaction.
// metadata is the optional ERC-8021 `m` field (for example the claim charge counts).
func scheduledSuffixContext(network string, payload map[string]interface{}, asset, payTo string, metadata map[string]any) evm.DataSuffixContext {
	accepted := types.PaymentRequirements{
		Scheme:            batchsettlement.SchemeBatched,
		Network:           network,
		Asset:             asset,
		Amount:            "0",
		PayTo:             payTo,
		MaxTimeoutSeconds: 0,
		Extra:             map[string]interface{}{},
	}
	return evm.DataSuffixContext{
		Payload: types.PaymentPayload{
			X402Version: 2,
			Accepted:    accepted,
			Payload:     payload,
		},
		Requirements: accepted,
		Metadata:     metadata,
	}
}

func groupByNetwork(channels []*FacilitatorChannel) (map[string][]*FacilitatorChannel, []string) {
	groups := make(map[string][]*FacilitatorChannel)
	order := make([]string, 0)
	for _, channel := range channels {
		if _, ok := groups[channel.Network]; !ok {
			order = append(order, channel.Network)
		}
		groups[channel.Network] = append(groups[channel.Network], channel)
	}
	return groups, order
}

func channelBases(channels []*FacilitatorChannel) []*storage.Channel {
	out := make([]*storage.Channel, 0, len(channels))
	for _, ch := range channels {
		if ch != nil {
			out = append(out, ch.Base())
		}
	}
	return out
}
