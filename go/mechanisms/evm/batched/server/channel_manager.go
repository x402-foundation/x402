package server

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

// ChannelManagerConfig holds the dependencies for a channel manager.
type ChannelManagerConfig struct {
	Scheme      *BatchedEvmScheme
	Facilitator x402.FacilitatorClient
	Network     x402.Network
}

// AutoSettlementConfig configures auto claim/settle/refund behavior.
type AutoSettlementConfig struct {
	// ClaimIntervalSecs claims on a fixed interval.
	ClaimIntervalSecs int
	// ClaimOnIdleSecs claims when channels are idle for this long.
	ClaimOnIdleSecs int
	// ClaimThreshold claims when total claimable exceeds this amount.
	ClaimThreshold string
	// MaxClaimsPerBatch limits the number of vouchers per claim tx.
	MaxClaimsPerBatch int
	// ClaimOnWithdrawal claims all when a withdrawal is detected.
	ClaimOnWithdrawal bool
	// SettleIntervalSecs settles on a fixed interval.
	SettleIntervalSecs int
	// SettleThreshold settles when total claimed exceeds this amount.
	SettleThreshold string
	// RefundOnIdleSecs cooperatively refunds channels idle for this long.
	RefundOnIdleSecs int
	// TickSecs is how often the manager evaluates triggers. Defaults to 5.
	TickSecs int
	// OnClaim is called after a successful claim.
	OnClaim func(ClaimResult)
	// OnSettle is called after a successful settle.
	OnSettle func(SettleResult)
	// OnRefund is called after a successful refund.
	OnRefund func(RefundResult)
	// OnError is called when any auto-settlement operation fails.
	OnError func(error)
}

// ClaimResult holds the result of a claim operation.
type ClaimResult struct {
	Vouchers    int
	Transaction string
}

// SettleResult holds the result of a settle operation.
type SettleResult struct {
	Transaction string
}

// RefundResult holds the result of a refund operation.
type RefundResult struct {
	Channels    []string
	Transaction string
}

// BatchedChannelManager handles auto-settlement of batched payment channels.
type BatchedChannelManager struct {
	scheme      *BatchedEvmScheme
	facilitator x402.FacilitatorClient
	network     x402.Network

	// Auto-settlement state
	ticker         *time.Ticker
	stopCh         chan struct{}
	lastClaimTime  time.Time
	lastSettleTime time.Time
	pendingSettle  bool
	config         AutoSettlementConfig
	running        bool
	tickInProgress int32 // atomic

	mu sync.Mutex
}

// NewBatchedChannelManager creates a new channel manager.
func NewBatchedChannelManager(config ChannelManagerConfig) *BatchedChannelManager {
	return &BatchedChannelManager{
		scheme:      config.Scheme,
		facilitator: config.Facilitator,
		network:     config.Network,
	}
}

// GetClaimableVouchersOpts filters claimable vouchers by idle time.
type GetClaimableVouchersOpts struct {
	IdleSecs int // Filter sessions idle for at least this many seconds
}

// GetClaimableVouchers returns voucher claims ready for on-chain settlement.
//
// A voucher is claimable when its `chargedCumulativeAmount` exceeds what has
// already been claimed on-chain. An optional `IdleSecs` filter skips sessions
// that received a request within the last `IdleSecs` seconds.
func (m *BatchedChannelManager) GetClaimableVouchers(opts *GetClaimableVouchersOpts) ([]batched.BatchedVoucherClaim, error) {
	sessions, err := m.scheme.storage.List()
	if err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	claims := make([]batched.BatchedVoucherClaim, 0)

	for _, session := range sessions {
		if opts != nil && opts.IdleSecs > 0 {
			idleMs := now - session.LastRequestTimestamp
			if idleMs < int64(opts.IdleSecs)*1000 {
				continue
			}
		}

		charged, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
		claimed, _ := new(big.Int).SetString(session.TotalClaimed, 10)
		if charged == nil || claimed == nil {
			continue
		}
		if charged.Cmp(claimed) <= 0 {
			continue
		}

		claims = append(claims, batched.BatchedVoucherClaim{
			Voucher: struct {
				Channel            batched.ChannelConfig `json:"channel"`
				MaxClaimableAmount string                `json:"maxClaimableAmount"`
			}{
				Channel:            session.ChannelConfig,
				MaxClaimableAmount: session.SignedMaxClaimable,
			},
			Signature:    session.Signature,
			TotalClaimed: session.ChargedCumulativeAmount,
		})
	}

	return claims, nil
}

// GetWithdrawalPendingSessions returns sessions that have a pending payer-initiated
// withdrawal (withdrawRequestedAt > 0).
func (m *BatchedChannelManager) GetWithdrawalPendingSessions() ([]*ChannelSession, error) {
	sessions, err := m.scheme.storage.List()
	if err != nil {
		return nil, err
	}
	var result []*ChannelSession
	for _, session := range sessions {
		if session.WithdrawRequestedAt > 0 {
			result = append(result, session)
		}
	}
	return result, nil
}

// Claim collects and claims outstanding vouchers.
type ClaimOptions struct {
	MaxClaimsPerBatch int
	IdleSecs          int
}

func (m *BatchedChannelManager) Claim(ctx context.Context, opts *ClaimOptions) ([]ClaimResult, error) {
	idleSecs := 0
	maxClaims := 50
	if opts != nil {
		if opts.IdleSecs > 0 {
			idleSecs = opts.IdleSecs
		}
		if opts.MaxClaimsPerBatch > 0 {
			maxClaims = opts.MaxClaimsPerBatch
		}
	}

	claims, err := m.GetClaimableVouchers(&GetClaimableVouchersOpts{IdleSecs: idleSecs})
	if err != nil {
		return nil, fmt.Errorf("failed to get claimable vouchers: %w", err)
	}

	if len(claims) == 0 {
		return nil, nil
	}

	// Batch claims
	var results []ClaimResult
	for i := 0; i < len(claims); i += maxClaims {
		end := i + maxClaims
		if end > len(claims) {
			end = len(claims)
		}
		batch := claims[i:end]

		result, err := m.executeClaim(ctx, batch)
		if err != nil {
			return results, fmt.Errorf("claim batch failed: %w", err)
		}
		results = append(results, *result)
	}

	return results, nil
}

// Settle transfers claimed funds to the receiver.
func (m *BatchedChannelManager) Settle(ctx context.Context) (*SettleResult, error) {
	settle := &batched.BatchedSettlePayload{
		Type:     "settle",
		Receiver: m.scheme.receiverAddress,
		Token:    m.getToken(),
	}
	resp, err := m.facilitatorSettle(ctx, settle.ToMap())
	if err != nil {
		return nil, err
	}
	return &SettleResult{Transaction: resp.Transaction}, nil
}

// facilitatorSettle marshals the (payload, requirements) pair this manager uses
// for its claim/settle/refund calls and forwards them to the facilitator.
func (m *BatchedChannelManager) facilitatorSettle(ctx context.Context, payloadMap map[string]interface{}) (*x402.SettleResponse, error) {
	payloadBytes, err := json.Marshal(map[string]interface{}{
		"x402Version": 2,
		"payload":     payloadMap,
		"accepted": map[string]interface{}{
			"scheme":  batched.SchemeBatched,
			"network": string(m.network),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	requirementsBytes, err := json.Marshal(map[string]interface{}{
		"scheme":  batched.SchemeBatched,
		"network": string(m.network),
		"payTo":   m.scheme.receiverAddress,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal requirements: %w", err)
	}

	return m.facilitator.Settle(ctx, payloadBytes, requirementsBytes)
}

// Refund cooperatively refunds the given channels. For each channel, claims
// any outstanding vouchers and refunds the unclaimed balance back to the payer.
func (m *BatchedChannelManager) Refund(ctx context.Context, channelIds []string) (*RefundResult, error) {
	if len(channelIds) == 0 {
		return nil, nil
	}

	var refundedChannels []string
	var lastTxHash string

	for _, channelId := range channelIds {
		normalizedId := batched.NormalizeChannelId(channelId)
		session, err := m.scheme.storage.Get(normalizedId)
		if err != nil || session == nil {
			continue
		}

		// Build claim entry from current session state
		claimEntry := batched.BatchedVoucherClaim{
			Voucher: struct {
				Channel            batched.ChannelConfig `json:"channel"`
				MaxClaimableAmount string                `json:"maxClaimableAmount"`
			}{
				Channel:            session.ChannelConfig,
				MaxClaimableAmount: session.SignedMaxClaimable,
			},
			Signature:    session.Signature,
			TotalClaimed: session.ChargedCumulativeAmount,
		}

		// Calculate refund amount: balance - chargedCumulativeAmount
		balance, _ := new(big.Int).SetString(session.Balance, 10)
		charged, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
		if balance == nil || charged == nil {
			continue
		}
		refundAmount := new(big.Int).Sub(balance, charged)
		if refundAmount.Sign() <= 0 {
			continue
		}

		// Pre-sign if server has authorizerSigner; otherwise facilitator auto-signs.
		nonce := fmt.Sprintf("%d", session.RefundNonce)
		refund := &batched.BatchedEnrichedRefundPayload{
			Type:          "refund",
			ChannelConfig: session.ChannelConfig,
			Voucher: batched.BatchedVoucherFields{
				ChannelId:          normalizedId,
				MaxClaimableAmount: session.SignedMaxClaimable,
				Signature:          session.Signature,
			},
			Amount:      refundAmount.String(),
			RefundNonce: nonce,
			Claims:      []batched.BatchedVoucherClaim{claimEntry},
		}

		if m.scheme.receiverAuthorizerSigner != nil {
			authSig, err := m.scheme.SignRefund(ctx, normalizedId, refundAmount.String(), nonce, string(m.network))
			if err != nil {
				return nil, fmt.Errorf("sign refund for %s: %w", normalizedId, err)
			}
			claimAuthSig, err := m.scheme.SignClaimBatch(ctx, []batched.BatchedVoucherClaim{claimEntry}, string(m.network))
			if err != nil {
				return nil, fmt.Errorf("sign claim batch for %s: %w", normalizedId, err)
			}
			refund.RefundAuthorizerSignature = evm.BytesToHex(authSig)
			refund.ClaimAuthorizerSignature = evm.BytesToHex(claimAuthSig)
		}

		resp, err := m.facilitatorSettle(ctx, refund.ToMap())
		if err != nil {
			return nil, fmt.Errorf("refund settle for %s: %w", normalizedId, err)
		}
		if !resp.Success {
			return nil, fmt.Errorf("refund settle for %s failed: %s — %s", normalizedId, resp.ErrorReason, resp.ErrorMessage)
		}

		lastTxHash = resp.Transaction
		refundedChannels = append(refundedChannels, normalizedId)

		// Delete the session after successful refund
		_ = m.scheme.storage.Delete(normalizedId)
	}

	if len(refundedChannels) == 0 {
		return nil, nil
	}

	return &RefundResult{
		Channels:    refundedChannels,
		Transaction: lastTxHash,
	}, nil
}

// ClaimAndSettle claims then settles.
func (m *BatchedChannelManager) ClaimAndSettle(ctx context.Context, opts *ClaimOptions) (*SettleResult, error) {
	_, err := m.Claim(ctx, opts)
	if err != nil {
		return nil, err
	}
	return m.Settle(ctx)
}

// Start begins auto-settlement with the given configuration.
func (m *BatchedChannelManager) Start(config AutoSettlementConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		return
	}

	m.config = config
	m.running = true
	m.lastClaimTime = time.Now()
	m.lastSettleTime = time.Now()

	tickSecs := config.TickSecs
	if tickSecs <= 0 {
		tickSecs = 5
	}

	m.ticker = time.NewTicker(time.Duration(tickSecs) * time.Second)
	m.stopCh = make(chan struct{})

	go func() {
		for {
			select {
			case <-m.ticker.C:
				m.tick()
			case <-m.stopCh:
				return
			}
		}
	}()
}

// Stop halts auto-settlement. If flush is true, performs a final ClaimAndSettle.
func (m *BatchedChannelManager) Stop(ctx context.Context, flush bool) error {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return nil
	}

	m.running = false
	m.ticker.Stop()
	close(m.stopCh)
	m.mu.Unlock()

	if flush {
		_, err := m.ClaimAndSettle(ctx, nil)
		return err
	}

	return nil
}

func (m *BatchedChannelManager) tick() {
	if !atomic.CompareAndSwapInt32(&m.tickInProgress, 0, 1) {
		return // Skip if previous tick is still running
	}
	defer atomic.StoreInt32(&m.tickInProgress, 0)

	ctx := context.Background()
	config := m.config
	now := time.Now()

	// Check claim triggers
	shouldClaim := false
	claimOpts := &ClaimOptions{}

	if config.MaxClaimsPerBatch > 0 {
		claimOpts.MaxClaimsPerBatch = config.MaxClaimsPerBatch
	}

	// Time-based claim
	if config.ClaimIntervalSecs > 0 && now.Sub(m.lastClaimTime) >= time.Duration(config.ClaimIntervalSecs)*time.Second {
		shouldClaim = true
	}

	// Idle-based claim
	if config.ClaimOnIdleSecs > 0 {
		claimOpts.IdleSecs = config.ClaimOnIdleSecs
		shouldClaim = true
	}

	// Withdrawal-based claim: if a payer initiated a withdrawal, claim their vouchers
	if config.ClaimOnWithdrawal {
		withdrawals, err := m.GetWithdrawalPendingSessions()
		if err == nil && len(withdrawals) > 0 {
			claimable, err := m.GetClaimableVouchers(nil)
			if err == nil {
				withdrawalPayers := make(map[string]bool)
				for _, w := range withdrawals {
					withdrawalPayers[strings.ToLower(w.ChannelConfig.Payer)] = true
				}
				for _, c := range claimable {
					if withdrawalPayers[strings.ToLower(c.Voucher.Channel.Payer)] {
						shouldClaim = true
						break
					}
				}
			}
		}
	}

	// Threshold-based claim
	if config.ClaimThreshold != "" {
		threshold, ok := new(big.Int).SetString(config.ClaimThreshold, 10)
		if ok {
			claims, err := m.GetClaimableVouchers(nil)
			if err == nil {
				total := big.NewInt(0)
				for _, claim := range claims {
					tc, _ := new(big.Int).SetString(claim.TotalClaimed, 10)
					if tc != nil {
						total.Add(total, tc)
					}
				}
				if total.Cmp(threshold) > 0 {
					shouldClaim = true
				}
			}
		}
	}

	if shouldClaim {
		results, err := m.Claim(ctx, claimOpts)
		if err != nil {
			if config.OnError != nil {
				config.OnError(fmt.Errorf("auto-claim failed: %w", err))
			}
		} else if len(results) > 0 {
			m.lastClaimTime = now
			m.pendingSettle = true
			if config.OnClaim != nil {
				for _, result := range results {
					config.OnClaim(result)
				}
			}
		}
	}

	// Check settle triggers
	shouldSettle := config.SettleIntervalSecs > 0 &&
		now.Sub(m.lastSettleTime) >= time.Duration(config.SettleIntervalSecs)*time.Second &&
		m.pendingSettle

	if shouldSettle {
		result, err := m.Settle(ctx)
		if err != nil {
			if config.OnError != nil {
				config.OnError(fmt.Errorf("auto-settle failed: %w", err))
			}
		} else if result != nil {
			m.lastSettleTime = now
			m.pendingSettle = false
			if config.OnSettle != nil {
				config.OnSettle(*result)
			}
		}
	}

	// Check refund triggers (idle channels)
	if config.RefundOnIdleSecs > 0 {
		sessions, err := m.scheme.storage.List()
		if err == nil {
			nowMs := now.UnixMilli()
			var refundChannelIds []string
			for _, session := range sessions {
				idleMs := nowMs - session.LastRequestTimestamp
				if idleMs >= int64(config.RefundOnIdleSecs)*1000 {
					refundChannelIds = append(refundChannelIds, session.ChannelId)
				}
			}
			if len(refundChannelIds) > 0 {
				result, err := m.Refund(ctx, refundChannelIds)
				if err != nil {
					if config.OnError != nil {
						config.OnError(fmt.Errorf("auto-refund failed: %w", err))
					}
				} else if result != nil && config.OnRefund != nil {
					config.OnRefund(*result)
				}
			}
		}
	}
}

func (m *BatchedChannelManager) executeClaim(ctx context.Context, claims []batched.BatchedVoucherClaim) (*ClaimResult, error) {
	// Pre-sign with the receiver's authorizer when configured; otherwise the
	// facilitator auto-signs via its own AuthorizerSigner.
	claim := &batched.BatchedClaimPayload{Type: "claim", Claims: claims}
	if m.scheme.receiverAuthorizerSigner != nil {
		sig, err := m.scheme.SignClaimBatch(ctx, claims, string(m.network))
		if err != nil {
			return nil, fmt.Errorf("failed to sign claim batch: %w", err)
		}
		claim.ClaimAuthorizerSignature = evm.BytesToHex(sig)
	}

	resp, err := m.facilitatorSettle(ctx, claim.ToMap())
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("claim settle failed: %s — %s", resp.ErrorReason, resp.ErrorMessage)
	}

	return &ClaimResult{
		Vouchers:    len(claims),
		Transaction: resp.Transaction,
	}, nil
}

func (m *BatchedChannelManager) getToken() string {
	sessions, err := m.scheme.storage.List()
	if err != nil || len(sessions) == 0 {
		return ""
	}
	return sessions[0].ChannelConfig.Token
}
