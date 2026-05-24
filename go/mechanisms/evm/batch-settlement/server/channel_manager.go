package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"strings"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

// ChannelManagerConfig wires the channel manager to its dependencies.
//
// Receiver and Token are required: the manager calls
// `settle(receiver, token)` directly, so storage may be empty when settle()
// fires, for example immediately after a flush.
type ChannelManagerConfig struct {
	Scheme      *BatchSettlementEvmScheme
	Facilitator x402.FacilitatorClient
	Receiver    string
	Token       string
	Network     x402.Network
}

// AutoSettlementContext is the policy context passed to caller-provided
// claim/settle/refund selectors.
type AutoSettlementContext struct {
	Now            int64
	LastClaimTime  int64
	LastSettleTime int64
	PendingSettle  bool
}

// ClaimChannelSelector picks the channel set the manager should consider for
// claiming on each pass. Returning a subset of `channels` is the supported way
// to express custom claim policy (e.g. only channels with non-trivial pending
// amounts).
type ClaimChannelSelector func(channels []*ChannelSession, ctx AutoSettlementContext) ([]*ChannelSession, error)

// ShouldSettleFunc decides whether a settle pass should fire for this tick.
// Return false to skip; the next interval will re-evaluate.
type ShouldSettleFunc func(ctx AutoSettlementContext) (bool, error)

// RefundChannelSelector picks idle channels for cooperative refund.
type RefundChannelSelector func(channels []*ChannelSession, ctx AutoSettlementContext) ([]*ChannelSession, error)

// ClaimOptions tunes a one-shot Claim call.
type ClaimOptions struct {
	// MaxClaimsPerBatch caps the number of vouchers per facilitator claim tx.
	// Defaults to 100.
	MaxClaimsPerBatch int
	// IdleSecs filters out channels that received a request within the last
	// `IdleSecs` seconds. Zero means "no idle filter".
	IdleSecs int
	// SelectClaimChannels narrows the channel set considered for claiming.
	SelectClaimChannels ClaimChannelSelector
}

// AutoSettlementConfig configures interval-driven auto claim/settle/refund.
//
// Each *IntervalSecs schedules an independent timer; passing zero leaves that
// job disabled. Selector callbacks let callers express custom claim/refund
// policy (e.g. claim only after a withdrawal trigger, refund only stale
// channels).
type AutoSettlementConfig struct {
	ClaimIntervalSecs    int
	SettleIntervalSecs   int
	RefundIntervalSecs   int
	MaxClaimsPerBatch    int
	SelectClaimChannels  ClaimChannelSelector
	ShouldSettle         ShouldSettleFunc
	SelectRefundChannels RefundChannelSelector
	OnClaim              func(ClaimResult)
	OnSettle             func(SettleResult)
	OnRefund             func(RefundResult)
	OnError              func(error)
}

// ClaimResult is one batch worth of claim submission.
type ClaimResult struct {
	Vouchers    int
	Transaction string
}

// SettleResult is one settle transaction.
type SettleResult struct {
	Transaction string
}

// RefundResult is one cooperative refund transaction (one channel).
//
// Each refunded channel returns one result.
type RefundResult struct {
	Channel     string
	Transaction string
}

type autoJob string

const (
	autoJobClaim  autoJob = "claim"
	autoJobSettle autoJob = "settle"
	autoJobRefund autoJob = "refund"
)

// autoJobPriority orders the queue: claim drains before settle drains before
// refund.
var autoJobPriority = []autoJob{autoJobClaim, autoJobSettle, autoJobRefund}

// BatchSettlementChannelManager handles auto-settlement of batched payment channels.
// Provides one-shot operations (Claim, Settle, ClaimAndSettle, Refund,
// RefundIdleChannels) and an interval runner via Start/Stop.
type BatchSettlementChannelManager struct {
	scheme      *BatchSettlementEvmScheme
	facilitator x402.FacilitatorClient
	receiver    string
	token       string
	network     x402.Network

	mu               sync.Mutex
	timers           map[autoJob]*time.Ticker
	stopCh           chan struct{}
	wg               sync.WaitGroup
	autoSettleConfig AutoSettlementConfig
	running          bool
	lastClaimTime    int64
	lastSettleTime   int64
	pendingSettle    bool
	pendingJobs      map[autoJob]struct{}
	pendingJobsCh    chan struct{}
}

// NewBatchSettlementChannelManager creates a new channel manager.
func NewBatchSettlementChannelManager(config ChannelManagerConfig) *BatchSettlementChannelManager {
	return &BatchSettlementChannelManager{
		scheme:      config.Scheme,
		facilitator: config.Facilitator,
		receiver:    config.Receiver,
		token:       config.Token,
		network:     config.Network,
	}
}

// hasLivePendingRequest returns true when the channel currently has a
// non-expired payer request reservation.
func hasLivePendingRequest(s *ChannelSession, nowMs int64) bool {
	return s != nil && s.PendingRequest != nil && s.PendingRequest.ExpiresAt > nowMs
}

// formatFacilitatorFailure renders a SettleResponse error consistently across
// claim/settle/refund operations.
func formatFacilitatorFailure(operation string, resp *x402.SettleResponse) string {
	if resp == nil {
		return fmt.Sprintf("%s failed: nil response", operation)
	}
	reason := resp.ErrorReason
	if reason == "" {
		reason = "unknown"
	}
	return fmt.Sprintf("%s failed: %s — %s", operation, reason, resp.ErrorMessage)
}

// ----- One-shot operations ---------------------------------------------------

// GetClaimableVouchersOpts filters claimable vouchers by idle time.
type GetClaimableVouchersOpts struct {
	IdleSecs int
}

// GetClaimableVouchers returns voucher claims ready for onchain settlement.
// Skips entries whose `chargedCumulativeAmount` does not exceed `totalClaimed`.
func (m *BatchSettlementChannelManager) GetClaimableVouchers(opts *GetClaimableVouchersOpts) ([]batchsettlement.BatchSettlementVoucherClaim, error) {
	channels, err := m.scheme.storage.List()
	if err != nil {
		return nil, err
	}
	idleSecs := 0
	if opts != nil {
		idleSecs = opts.IdleSecs
	}
	return m.collectClaimsFromChannels(channels, idleSecs), nil
}

// GetWithdrawalPendingSessions returns sessions that have a pending payer-initiated
// withdrawal (withdrawRequestedAt > 0).
func (m *BatchSettlementChannelManager) GetWithdrawalPendingSessions() ([]*ChannelSession, error) {
	channels, err := m.scheme.storage.List()
	if err != nil {
		return nil, err
	}
	out := make([]*ChannelSession, 0, len(channels))
	for _, c := range channels {
		if c.WithdrawRequestedAt > 0 {
			out = append(out, c)
		}
	}
	return out, nil
}

// Claim collects claimable vouchers and submits them in batches.
func (m *BatchSettlementChannelManager) Claim(ctx context.Context, opts *ClaimOptions) ([]ClaimResult, error) {
	resolved := normalizeClaimOptions(opts)
	channels, err := m.selectClaimTargets(resolved.SelectClaimChannels)
	if err != nil {
		return nil, err
	}
	return m.claimFromChannels(ctx, channels, resolved.MaxClaimsPerBatch, resolved.IdleSecs)
}

// Settle transfers claimed funds to the receiver via a `settle(receiver, token)` call.
func (m *BatchSettlementChannelManager) Settle(ctx context.Context) (*SettleResult, error) {
	payload := m.buildSettlePaymentPayloadMap()
	resp, err := m.facilitatorSettle(ctx, payload)
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("%s", formatFacilitatorFailure("Settle", resp))
	}
	m.mu.Lock()
	m.pendingSettle = false
	m.mu.Unlock()
	return &SettleResult{Transaction: resp.Transaction}, nil
}

// ClaimAndSettle claims any eligible vouchers, then settles when claims fired.
func (m *BatchSettlementChannelManager) ClaimAndSettle(ctx context.Context, opts *ClaimOptions) ([]ClaimResult, *SettleResult, error) {
	claims, err := m.Claim(ctx, opts)
	if err != nil {
		return nil, nil, err
	}
	if len(claims) == 0 {
		return claims, nil, nil
	}
	settle, err := m.Settle(ctx)
	if err != nil {
		return claims, nil, err
	}
	return claims, settle, nil
}

// Refund refunds the listed channels. Channels with a live in-flight request
// reservation are skipped. Pass an empty slice to refund every stored channel.
func (m *BatchSettlementChannelManager) Refund(ctx context.Context, channelIds []string) ([]RefundResult, error) {
	channels, err := m.scheme.storage.List()
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	var targets []*ChannelSession
	if len(channelIds) == 0 {
		targets = channels
	} else {
		want := make(map[string]struct{}, len(channelIds))
		for _, id := range channelIds {
			want[strings.ToLower(id)] = struct{}{}
		}
		for _, c := range channels {
			if _, ok := want[strings.ToLower(c.ChannelId)]; ok {
				targets = append(targets, c)
			}
		}
	}
	live := make([]*ChannelSession, 0, len(targets))
	for _, c := range targets {
		if !hasLivePendingRequest(c, now) {
			live = append(live, c)
		}
	}
	if len(live) == 0 {
		return nil, nil
	}
	return m.refundChannels(ctx, live)
}

// RefundIdleChannels cooperatively refunds channels that have been idle for at
// least `idleSecs` seconds and still hold a non-zero balance.
func (m *BatchSettlementChannelManager) RefundIdleChannels(ctx context.Context, idleSecs int) ([]RefundResult, error) {
	channels, err := m.scheme.storage.List()
	if err != nil {
		return nil, err
	}
	idle := getIdleChannelsForRefund(channels, idleSecs)
	if len(idle) == 0 {
		return nil, nil
	}
	return m.refundChannels(ctx, idle)
}

// ----- Auto-settlement loop --------------------------------------------------

// Start begins auto-settlement with the given configuration. Each non-zero
// *IntervalSecs schedules an independent timer; jobs are queued and drained in
// {claim, settle, refund} priority.
func (m *BatchSettlementChannelManager) Start(config AutoSettlementConfig) {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return
	}
	now := time.Now().UnixMilli()
	m.lastClaimTime = now
	m.lastSettleTime = now
	m.running = true
	m.autoSettleConfig = config
	m.timers = make(map[autoJob]*time.Ticker)
	m.stopCh = make(chan struct{})
	m.pendingJobs = make(map[autoJob]struct{})
	m.pendingJobsCh = make(chan struct{}, 1)
	m.mu.Unlock()

	m.startAutoTimer(autoJobClaim, config.ClaimIntervalSecs)
	m.startAutoTimer(autoJobSettle, config.SettleIntervalSecs)
	m.startAutoTimer(autoJobRefund, config.RefundIntervalSecs)

	m.wg.Add(1)
	go m.drainLoop()
}

// Stop halts auto-settlement. When opts.Flush is true, runs a final
// ClaimAndSettle before returning.
type StopOptions struct {
	Flush bool
}

func (m *BatchSettlementChannelManager) Stop(ctx context.Context, opts *StopOptions) error {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return nil
	}
	m.running = false
	for _, t := range m.timers {
		t.Stop()
	}
	m.timers = nil
	m.pendingJobs = nil
	close(m.stopCh)
	m.mu.Unlock()

	m.wg.Wait()

	if opts != nil && opts.Flush {
		_, _, err := m.ClaimAndSettle(ctx, &ClaimOptions{
			MaxClaimsPerBatch:   m.autoSettleConfig.MaxClaimsPerBatch,
			SelectClaimChannels: m.autoSettleConfig.SelectClaimChannels,
		})
		return err
	}
	return nil
}

func (m *BatchSettlementChannelManager) startAutoTimer(job autoJob, intervalSecs int) {
	if intervalSecs <= 0 {
		return
	}
	ticker := time.NewTicker(time.Duration(intervalSecs) * time.Second)
	m.mu.Lock()
	m.timers[job] = ticker
	m.mu.Unlock()

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		for {
			select {
			case <-ticker.C:
				m.enqueueJob(job)
			case <-m.stopCh:
				return
			}
		}
	}()
}

func (m *BatchSettlementChannelManager) enqueueJob(job autoJob) {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	if m.pendingJobs == nil {
		m.pendingJobs = make(map[autoJob]struct{})
	}
	m.pendingJobs[job] = struct{}{}
	m.mu.Unlock()

	select {
	case m.pendingJobsCh <- struct{}{}:
	default:
		// drain loop already has a wakeup pending
	}
}

func (m *BatchSettlementChannelManager) drainLoop() {
	defer m.wg.Done()
	for {
		select {
		case <-m.stopCh:
			return
		case <-m.pendingJobsCh:
			for {
				job, ok := m.popNextPendingJob()
				if !ok {
					break
				}
				m.runAutoJob(job)
			}
		}
	}
}

func (m *BatchSettlementChannelManager) popNextPendingJob() (autoJob, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running || len(m.pendingJobs) == 0 {
		return "", false
	}
	for _, j := range autoJobPriority {
		if _, ok := m.pendingJobs[j]; ok {
			delete(m.pendingJobs, j)
			return j, true
		}
	}
	return "", false
}

func (m *BatchSettlementChannelManager) runAutoJob(job autoJob) {
	ctx := context.Background()
	switch job {
	case autoJobClaim:
		m.runClaimJob(ctx)
	case autoJobSettle:
		m.runSettleJob(ctx)
	case autoJobRefund:
		m.runRefundJob(ctx)
	}
}

func (m *BatchSettlementChannelManager) runClaimJob(ctx context.Context) {
	cfg := m.snapshotAutoSettlementConfig()
	results, err := m.Claim(ctx, &ClaimOptions{
		MaxClaimsPerBatch:   cfg.MaxClaimsPerBatch,
		SelectClaimChannels: cfg.SelectClaimChannels,
	})
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(fmt.Errorf("auto-claim: %w", err))
		}
		return
	}
	m.mu.Lock()
	m.lastClaimTime = time.Now().UnixMilli()
	m.mu.Unlock()
	for _, r := range results {
		if cfg.OnClaim != nil {
			cfg.OnClaim(r)
		}
	}
}

func (m *BatchSettlementChannelManager) runSettleJob(ctx context.Context) {
	cfg := m.snapshotAutoSettlementConfig()
	autoCtx := m.buildAutoSettlementContext(time.Now().UnixMilli())
	if !autoCtx.PendingSettle {
		return
	}
	if cfg.ShouldSettle != nil {
		ok, err := cfg.ShouldSettle(autoCtx)
		if err != nil {
			if cfg.OnError != nil {
				cfg.OnError(fmt.Errorf("auto-settle shouldSettle: %w", err))
			}
			return
		}
		if !ok {
			return
		}
	}
	result, err := m.Settle(ctx)
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(fmt.Errorf("auto-settle: %w", err))
		}
		return
	}
	m.mu.Lock()
	m.lastSettleTime = time.Now().UnixMilli()
	m.mu.Unlock()
	if result != nil && cfg.OnSettle != nil {
		cfg.OnSettle(*result)
	}
}

func (m *BatchSettlementChannelManager) runRefundJob(ctx context.Context) {
	cfg := m.snapshotAutoSettlementConfig()
	if cfg.SelectRefundChannels == nil {
		return
	}
	channels, err := m.scheme.storage.List()
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(fmt.Errorf("auto-refund list: %w", err))
		}
		return
	}
	autoCtx := m.buildAutoSettlementContext(time.Now().UnixMilli())
	targets, err := cfg.SelectRefundChannels(channels, autoCtx)
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(fmt.Errorf("auto-refund select: %w", err))
		}
		return
	}
	results, err := m.refundChannels(ctx, targets)
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(fmt.Errorf("auto-refund: %w", err))
		}
		return
	}
	for _, r := range results {
		if cfg.OnRefund != nil {
			cfg.OnRefund(r)
		}
	}
}

func (m *BatchSettlementChannelManager) snapshotAutoSettlementConfig() AutoSettlementConfig {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.autoSettleConfig
}

func (m *BatchSettlementChannelManager) buildAutoSettlementContext(nowMs int64) AutoSettlementContext {
	m.mu.Lock()
	defer m.mu.Unlock()
	return AutoSettlementContext{
		Now:            nowMs,
		LastClaimTime:  m.lastClaimTime,
		LastSettleTime: m.lastSettleTime,
		PendingSettle:  m.pendingSettle,
	}
}

// ----- internals --------------------------------------------------------------

type resolvedClaimOptions struct {
	MaxClaimsPerBatch   int
	IdleSecs            int
	SelectClaimChannels ClaimChannelSelector
}

func normalizeClaimOptions(opts *ClaimOptions) resolvedClaimOptions {
	out := resolvedClaimOptions{MaxClaimsPerBatch: 100}
	if opts != nil {
		if opts.MaxClaimsPerBatch > 0 {
			out.MaxClaimsPerBatch = opts.MaxClaimsPerBatch
		}
		out.IdleSecs = opts.IdleSecs
		out.SelectClaimChannels = opts.SelectClaimChannels
	}
	return out
}

func (m *BatchSettlementChannelManager) selectClaimTargets(selector ClaimChannelSelector) ([]*ChannelSession, error) {
	channels, err := m.scheme.storage.List()
	if err != nil {
		return nil, err
	}
	if selector == nil {
		return channels, nil
	}
	autoCtx := m.buildAutoSettlementContext(time.Now().UnixMilli())
	out, err := selector(channels, autoCtx)
	if err != nil {
		return nil, fmt.Errorf("selectClaimChannels: %w", err)
	}
	return out, nil
}

func (m *BatchSettlementChannelManager) collectClaimsFromChannels(channels []*ChannelSession, idleSecs int) []batchsettlement.BatchSettlementVoucherClaim {
	now := time.Now().UnixMilli()
	out := make([]batchsettlement.BatchSettlementVoucherClaim, 0, len(channels))
	for _, c := range channels {
		charged, _ := new(big.Int).SetString(c.ChargedCumulativeAmount, 10)
		claimed, _ := new(big.Int).SetString(c.TotalClaimed, 10)
		if charged == nil || claimed == nil || charged.Cmp(claimed) <= 0 {
			continue
		}
		if idleSecs > 0 {
			idleMs := now - c.LastRequestTimestamp
			if idleMs < int64(idleSecs)*1000 {
				continue
			}
		}
		out = append(out, batchsettlement.BatchSettlementVoucherClaim{
			Voucher: struct {
				Channel            batchsettlement.ChannelConfig `json:"channel"`
				MaxClaimableAmount string                        `json:"maxClaimableAmount"`
			}{
				Channel:            c.ChannelConfig,
				MaxClaimableAmount: c.SignedMaxClaimable,
			},
			Signature:    c.Signature,
			TotalClaimed: c.ChargedCumulativeAmount,
		})
	}
	return out
}

func (m *BatchSettlementChannelManager) claimFromChannels(
	ctx context.Context,
	channels []*ChannelSession,
	maxClaimsPerBatch int,
	idleSecs int,
) ([]ClaimResult, error) {
	all := m.collectClaimsFromChannels(channels, idleSecs)
	if len(all) == 0 {
		return nil, nil
	}
	results := make([]ClaimResult, 0)
	for i := 0; i < len(all); i += maxClaimsPerBatch {
		end := i + maxClaimsPerBatch
		if end > len(all) {
			end = len(all)
		}
		batch := all[i:end]
		res, err := m.submitClaim(ctx, batch)
		if err != nil {
			return results, err
		}
		results = append(results, *res)
		if err := m.updateClaimedSessions(batch); err != nil {
			log.Printf("[batched] post-claim storage update failed: %v", err)
		}
	}
	if len(results) > 0 {
		m.mu.Lock()
		m.pendingSettle = true
		m.mu.Unlock()
	}
	return results, nil
}

// submitClaim sends a single claim batch to the facilitator.
func (m *BatchSettlementChannelManager) submitClaim(ctx context.Context, claims []batchsettlement.BatchSettlementVoucherClaim) (*ClaimResult, error) {
	claim := &batchsettlement.BatchSettlementClaimPayload{Type: "claim", Claims: claims}
	if m.scheme.receiverAuthorizerSigner != nil {
		sig, err := m.scheme.SignClaimBatch(ctx, claims, string(m.network))
		if err != nil {
			return nil, fmt.Errorf("sign claim batch: %w", err)
		}
		claim.ClaimAuthorizerSignature = evm.BytesToHex(sig)
	}
	resp, err := m.facilitatorSettle(ctx, claim.ToMap())
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("%s", formatFacilitatorFailure("Claim", resp))
	}
	return &ClaimResult{Vouchers: len(claims), Transaction: resp.Transaction}, nil
}

// refundChannels refunds each eligible channel independently and returns one
// RefundResult per successful refund.
func (m *BatchSettlementChannelManager) refundChannels(ctx context.Context, channels []*ChannelSession) ([]RefundResult, error) {
	results := make([]RefundResult, 0, len(channels))
	now := time.Now().UnixMilli()
	for _, c := range channels {
		if hasLivePendingRequest(c, now) {
			continue
		}
		res, err := m.refundChannel(ctx, c)
		if err != nil {
			return results, err
		}
		if res != nil {
			results = append(results, *res)
		}
	}
	return results, nil
}

func (m *BatchSettlementChannelManager) refundChannel(ctx context.Context, target *ChannelSession) (*RefundResult, error) {
	normalizedId := batchsettlement.NormalizeChannelId(target.ChannelId)

	balance, _ := new(big.Int).SetString(target.Balance, 10)
	charged, _ := new(big.Int).SetString(target.ChargedCumulativeAmount, 10)
	if balance == nil || charged == nil {
		return nil, nil
	}
	refundAmount := new(big.Int).Sub(balance, charged)
	if refundAmount.Sign() <= 0 {
		return nil, nil
	}

	// Build the outstanding voucher claim that must be settled before the
	// refund can move the unclaimed balance.
	var claims []batchsettlement.BatchSettlementVoucherClaim
	totalClaimedBig, _ := new(big.Int).SetString(target.TotalClaimed, 10)
	if charged != nil && totalClaimedBig != nil && charged.Cmp(totalClaimedBig) > 0 {
		claims = []batchsettlement.BatchSettlementVoucherClaim{{
			Voucher: struct {
				Channel            batchsettlement.ChannelConfig `json:"channel"`
				MaxClaimableAmount string                        `json:"maxClaimableAmount"`
			}{
				Channel:            target.ChannelConfig,
				MaxClaimableAmount: target.SignedMaxClaimable,
			},
			Signature:    target.Signature,
			TotalClaimed: target.ChargedCumulativeAmount,
		}}
	}

	nonce := fmt.Sprintf("%d", target.RefundNonce)
	refund := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: target.ChannelConfig,
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          normalizedId,
			MaxClaimableAmount: target.SignedMaxClaimable,
			Signature:          target.Signature,
		},
		Amount:      refundAmount.String(),
		RefundNonce: nonce,
		Claims:      claims,
	}

	if m.scheme.receiverAuthorizerSigner != nil {
		authSig, err := m.scheme.SignRefund(ctx, normalizedId, refundAmount.String(), nonce, string(m.network))
		if err != nil {
			return nil, fmt.Errorf("sign refund for %s: %w", normalizedId, err)
		}
		refund.RefundAuthorizerSignature = evm.BytesToHex(authSig)
		if len(claims) > 0 {
			claimAuthSig, err := m.scheme.SignClaimBatch(ctx, claims, string(m.network))
			if err != nil {
				return nil, fmt.Errorf("sign claim batch for %s: %w", normalizedId, err)
			}
			refund.ClaimAuthorizerSignature = evm.BytesToHex(claimAuthSig)
		}
	}

	resp, err := m.facilitatorSettle(ctx, refund.ToMap())
	if err != nil {
		return nil, fmt.Errorf("refund settle for %s: %w", normalizedId, err)
	}
	if !resp.Success {
		return nil, fmt.Errorf("%s", formatFacilitatorFailure("Refund", resp))
	}

	// Drop the session so it doesn't churn through future refund cycles.
	_, _ = m.scheme.storage.UpdateChannel(normalizedId, func(current *ChannelSession) *ChannelSession {
		if current == nil {
			return current
		}
		if hasLivePendingRequest(current, time.Now().UnixMilli()) {
			return current
		}
		return nil
	})

	return &RefundResult{Channel: normalizedId, Transaction: resp.Transaction}, nil
}

// updateClaimedSessions advances each session's TotalClaimed to the just-claimed
// cumulative amount so GetClaimableVouchers stops returning the same channel
// until a fresh voucher pushes ChargedCumulativeAmount higher.
func (m *BatchSettlementChannelManager) updateClaimedSessions(claims []batchsettlement.BatchSettlementVoucherClaim) error {
	for _, claim := range claims {
		channelId, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, string(m.network))
		if err != nil {
			return fmt.Errorf("compute channel id: %w", err)
		}
		normalizedId := batchsettlement.NormalizeChannelId(channelId)
		claimedAmount, ok := new(big.Int).SetString(claim.TotalClaimed, 10)
		if !ok || claimedAmount == nil {
			continue
		}
		_, err = m.scheme.storage.UpdateChannel(normalizedId, func(current *ChannelSession) *ChannelSession {
			if current == nil {
				return current
			}
			curClaimed, _ := new(big.Int).SetString(current.TotalClaimed, 10)
			if curClaimed != nil && claimedAmount.Cmp(curClaimed) <= 0 {
				return current
			}
			next := *current
			next.TotalClaimed = claimedAmount.String()
			return &next
		})
		if err != nil {
			return fmt.Errorf("update session %s: %w", normalizedId, err)
		}
	}
	return nil
}

// getIdleChannelsForRefund returns channels that have been idle for at least
// `idleSecs` seconds and still hold a non-zero balance. Skips channels with a
// live in-flight request reservation.
//
// Callers wanting "refund all idle channels" should inline this predicate
// inside their SelectRefundChannels callback.
func getIdleChannelsForRefund(channels []*ChannelSession, idleSecs int) []*ChannelSession {
	if idleSecs <= 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	idleMs := int64(idleSecs) * 1000
	out := make([]*ChannelSession, 0, len(channels))
	for _, c := range channels {
		balance, _ := new(big.Int).SetString(c.Balance, 10)
		if balance == nil || balance.Sign() == 0 {
			continue
		}
		if hasLivePendingRequest(c, now) {
			continue
		}
		if now-c.LastRequestTimestamp < idleMs {
			continue
		}
		out = append(out, c)
	}
	return out
}

// buildSettlePaymentPayloadMap produces the v2 PaymentPayload JSON map for
// `settle(receiver, token)`. The manager passes `(payload, requirements)` to
// the FacilitatorClient as marshaled JSON, so we keep this as a map shape that
// matches `BatchSettlementSettlePayload.ToMap()`.
func (m *BatchSettlementChannelManager) buildSettlePaymentPayloadMap() map[string]interface{} {
	settle := &batchsettlement.BatchSettlementSettlePayload{
		Type:     "settle",
		Receiver: m.receiver,
		Token:    m.token,
	}
	return settle.ToMap()
}

// facilitatorSettle marshals the (payload, requirements) pair this manager uses
// for its claim/settle/refund calls and forwards them to the facilitator.
func (m *BatchSettlementChannelManager) facilitatorSettle(ctx context.Context, payloadMap map[string]interface{}) (*x402.SettleResponse, error) {
	payloadBytes, err := json.Marshal(map[string]interface{}{
		"x402Version": 2,
		"payload":     payloadMap,
		"accepted":    m.requirementsMap(),
	})
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}
	requirementsBytes, err := json.Marshal(m.requirementsMap())
	if err != nil {
		return nil, fmt.Errorf("marshal requirements: %w", err)
	}
	return m.facilitator.Settle(ctx, payloadBytes, requirementsBytes)
}

// requirementsMap returns the minimal PaymentRequirements shape used for the
// manager's own facilitator calls.
func (m *BatchSettlementChannelManager) requirementsMap() map[string]interface{} {
	return map[string]interface{}{
		"scheme":            batchsettlement.SchemeBatched,
		"network":           string(m.network),
		"asset":             m.token,
		"amount":            "0",
		"payTo":             m.receiver,
		"maxTimeoutSeconds": 0,
		"extra":             map[string]interface{}{},
	}
}
