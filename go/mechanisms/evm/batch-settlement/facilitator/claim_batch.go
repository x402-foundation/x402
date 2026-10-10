package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

const (
	multicallAttempts = 3
	multicallBackoff  = 100 * time.Millisecond
	// afterClaimTimeout bounds bookkeeping for a claim that already landed.
	afterClaimTimeout = 30 * time.Second
)

// claimSlice preflights one claim batch, then submits it.
// Simulation failure splits the batch. AfterClaim runs only for batches that land.
func (m *FacilitatorChannelManager) claimSlice(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	rows []*FacilitatorChannel,
	opts *FacilitatorClaimOptions,
) ([]FacilitatorClaimResult, error) {
	prepared, err := m.prepareClaimBatch(ctx, network, claims, rows)
	if err != nil {
		return nil, err
	}
	results, err := m.submitClaimLeaf(ctx, network, prepared, rows, opts)
	if err != nil && ctx.Err() == nil {
		return results, &batchClaimError{err: err}
	}
	return results, err
}

// batchClaimError is a per-batch submission failure. Claim reports it and continues.
// Query and preflight read failures stay unwrapped so Claim returns them.
type batchClaimError struct {
	err error
}

func (e *batchClaimError) Error() string { return e.err.Error() }

func (e *batchClaimError) Unwrap() error { return e.err }

func (m *FacilitatorChannelManager) prepareClaimBatch(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	rows []*FacilitatorChannel,
) ([]batchsettlement.BatchSettlementVoucherClaim, error) {
	filtered, skipped := m.filterClaimAuthorizer(claims)
	if skipped > 0 {
		m.logger.Info("batch-settlement: skipped claims with a different receiverAuthorizer", "skipped", skipped, "network", network)
	}
	if len(filtered) == 0 {
		return nil, nil
	}
	views, err := m.readClaimChannels(ctx, network, filtered)
	if err != nil {
		return nil, err
	}
	kept := make([]batchsettlement.BatchSettlementVoucherClaim, 0, len(filtered))
	conflicts := 0
	lookup := rowLookup(ctx, m.storage, rows)
	for _, claim := range filtered {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, err
		}
		view, ok := views[strings.ToLower(channelID)]
		if !ok {
			continue
		}
		stored, err := lookup(channelID)
		if err != nil {
			return nil, err
		}
		if stored != nil && stored.PendingClaim != nil {
			skip, resolveErr := m.resolvePendingClaim(ctx, channelID, stored, view.totalClaimed)
			if resolveErr != nil {
				if errors.Is(resolveErr, errChannelConflict) {
					conflicts++
					continue
				}
				return nil, resolveErr
			}
			if skip {
				continue
			}
		}
		charged, chargedOk := storage.ParseUint256(claim.TotalClaimed)
		if !chargedOk {
			continue
		}
		if view.totalClaimed.Cmp(charged) >= 0 {
			if unreconciledClaimDelta(stored, view.totalClaimed) {
				m.logger.Warn("batch-settlement: onchain totalClaimed advanced without an attested claim marker", "channel_id", channelID, "network", network)
			}
			if err := m.applyPreflightSettleDelta(ctx, network, channelID, claim.Voucher.Channel.Receiver, claim.Voucher.Channel.Token, view.totalClaimed, rows); err != nil {
				return nil, err
			}
			if err := m.syncClaimMirror(ctx, channelID, nil, view.totalClaimed, 0, false); err != nil {
				if errors.Is(err, errChannelConflict) {
					conflicts++
					continue
				}
				return nil, err
			}
			continue
		}
		if view.balance.Cmp(view.totalClaimed) <= 0 {
			m.logger.Info("batch-settlement: drained channel", "channel_id", channelID, "network", network)
			if err := m.applyPreflightSettleDelta(ctx, network, channelID, claim.Voucher.Channel.Receiver, claim.Voucher.Channel.Token, view.totalClaimed, rows); err != nil {
				return nil, err
			}
			if err := m.syncClaimMirror(ctx, channelID, view.balance, view.totalClaimed, view.withdrawAt, true); err != nil {
				if errors.Is(err, errChannelConflict) {
					conflicts++
					continue
				}
				return nil, err
			}
			continue
		}
		amount := charged
		if view.balance.Cmp(amount) < 0 {
			amount = view.balance
		}
		claim.TotalClaimed = amount.String()
		kept = append(kept, claim)
	}
	if conflicts > 0 {
		m.logger.Info("batch-settlement: claim preflight skipped channels with update conflicts", "network", network, "conflict", conflicts)
	}
	return kept, nil
}

func (m *FacilitatorChannelManager) filterClaimAuthorizer(
	claims []batchsettlement.BatchSettlementVoucherClaim,
) ([]batchsettlement.BatchSettlementVoucherClaim, int) {
	if m.authorizerSigner == nil || m.authorizerSigner.Address() == "" {
		return claims, 0
	}
	want := m.authorizerSigner.Address()
	kept := make([]batchsettlement.BatchSettlementVoucherClaim, 0, len(claims))
	skipped := 0
	for _, claim := range claims {
		if !strings.EqualFold(claim.Voucher.Channel.ReceiverAuthorizer, want) {
			skipped++
			continue
		}
		kept = append(kept, claim)
	}
	return kept, skipped
}

type claimChannelView struct {
	balance      *big.Int
	totalClaimed *big.Int
	withdrawAt   int
}

// readClaimChannels reads channels and pendingWithdrawals for the batch in one multicall.
func (m *FacilitatorChannelManager) readClaimChannels(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
) (map[string]claimChannelView, error) {
	type row struct {
		key string
		id  common.Hash
	}
	rows := make([]row, 0, len(claims))
	calls := make([]evm.MulticallCall, 0, len(claims)*2)
	for _, claim := range claims {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, err
		}
		id := common.HexToHash(channelID)
		rows = append(rows, row{key: strings.ToLower(channelID), id: id})
		calls = append(calls,
			evm.MulticallCall{
				Address:      batchsettlement.BatchSettlementAddress,
				ABI:          batchsettlement.BatchSettlementChannelsABI,
				FunctionName: "channels",
				Args:         []interface{}{id},
			},
			evm.MulticallCall{
				Address:      batchsettlement.BatchSettlementAddress,
				ABI:          batchsettlement.BatchSettlementPendingWithdrawalsABI,
				FunctionName: "pendingWithdrawals",
				Args:         []interface{}{id},
			},
		)
	}
	results, err := m.readMulticall(ctx, network, calls)
	if err != nil {
		return nil, err
	}
	out := make(map[string]claimChannelView, len(rows))
	for i, item := range rows {
		channelResult := results[i*2]
		withdrawResult := results[i*2+1]
		if !channelResult.Success() || !withdrawResult.Success() {
			m.logger.Warn("batch-settlement: claim preflight failed", "channel_id", item.key, "network", network)
			continue
		}
		balance, totalClaimed, err := parseChannelsResult(channelResult.Result)
		if err != nil {
			m.logger.Warn("batch-settlement: claim preflight failed", "channel_id", item.key, "network", network)
			continue
		}
		withdrawAt, err := parsePendingWithdrawAt(withdrawResult.Result)
		if err != nil {
			m.logger.Warn("batch-settlement: claim preflight failed", "channel_id", item.key, "network", network)
			continue
		}
		out[item.key] = claimChannelView{
			balance:      balance,
			totalClaimed: totalClaimed,
			withdrawAt:   withdrawAt,
		}
	}
	return out, nil
}

// readMulticall calls Multicall up to three times.
// Backoff is 100ms, then 200ms. A canceled context is not retried.
func (m *FacilitatorChannelManager) readMulticall(
	ctx context.Context,
	network string,
	calls []evm.MulticallCall,
) ([]evm.MulticallResult, error) {
	var last error
	for attempt := 0; attempt < multicallAttempts; attempt++ {
		if attempt > 0 {
			delay := multicallBackoff << (attempt - 1)
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
		results, err := evm.Multicall(ctx, m.signer, calls)
		if err == nil && len(results) == len(calls) {
			return results, nil
		}
		if err == nil {
			err = fmt.Errorf("multicall returned %d results, want %d", len(results), len(calls))
		}
		last = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		m.logger.Warn("batch-settlement: multicall attempt failed", "attempt", attempt+1, "network", network, "error", err)
	}
	return nil, last
}

func parseChannelsResult(raw interface{}) (*big.Int, *big.Int, error) {
	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return nil, nil, fmt.Errorf("channels returned %T, want balance and totalClaimed", raw)
	}
	balance, ok := outputs[0].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("channels balance returned %T, want *big.Int", outputs[0])
	}
	totalClaimed, ok := outputs[1].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("channels totalClaimed returned %T, want *big.Int", outputs[1])
	}
	return balance, totalClaimed, nil
}

func parsePendingWithdrawAt(raw interface{}) (int, error) {
	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return 0, fmt.Errorf("pendingWithdrawals returned %T, want amount and initiatedAt", raw)
	}
	initiatedAt, ok := outputs[1].(*big.Int)
	if !ok {
		return 0, fmt.Errorf("pendingWithdrawals initiatedAt returned %T, want *big.Int", outputs[1])
	}
	return int(initiatedAt.Int64()), nil
}

func (m *FacilitatorChannelManager) submitClaimLeaf(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	rows []*FacilitatorChannel,
	opts *FacilitatorClaimOptions,
) ([]FacilitatorClaimResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(claims) == 0 {
		return nil, nil
	}
	counts := make([]uint64, 0, len(claims))
	begun := make([]attestedClaim, 0, len(claims))
	kept := make([]batchsettlement.BatchSettlementVoucherClaim, 0, len(claims))
	now := time.Now().UnixMilli()
	ones := make([]attestedClaim, len(claims))
	results := make([]beginResult, len(claims))
	errs := make([]error, len(claims))
	forEachChannel(len(claims), func(i int) {
		channelID, err := batchsettlement.ComputeChannelId(claims[i].Voucher.Channel, network)
		if err != nil {
			errs[i] = err
			return
		}
		ones[i], results[i], errs[i] = beginAttestedClaim(ctx, m.storage, channelID, claims[i], now)
	})
	var (
		beginErr                                            error
		busy, superseded, alreadyClaimed, missing, conflict int
	)
	for i, claim := range claims {
		if errs[i] != nil {
			if errors.Is(errs[i], errChannelConflict) {
				conflict++
				continue
			}
			if beginErr == nil {
				beginErr = errs[i]
			}
			continue
		}
		switch results[i] {
		case beginStarted:
			begun = append(begun, ones[i])
			kept = append(kept, claim)
			counts = append(counts, chargeCountUint(ones[i].Count))
		case beginBusy:
			busy++
		case beginSuperseded:
			superseded++
		case beginAlreadyClaimed:
			alreadyClaimed++
		case beginMissing:
			missing++
		default:
			if beginErr == nil {
				beginErr = fmt.Errorf("unexpected begin result %d", results[i])
			}
		}
	}
	if beginErr != nil {
		_ = abortAttestedClaims(ctx, m.storage, begun)
		return nil, beginErr
	}
	if skipped := busy + superseded + alreadyClaimed + missing + conflict; skipped > 0 {
		m.logger.Info("batch-settlement: claim batch skipped channels",
			"network", network,
			"busy", busy,
			"superseded", superseded,
			"already_claimed", alreadyClaimed,
			"missing", missing,
			"conflict", conflict,
		)
	}
	if len(kept) == 0 {
		return nil, nil
	}
	asset := kept[0].Voucher.Channel.Token
	payTo := kept[0].Voucher.Channel.Receiver
	payload := &batchsettlement.BatchSettlementClaimPayload{Type: "claim", Claims: kept}
	dataSuffix, err := m.resolveBuilderSuffix(network, payload.ToMap(), asset, payTo, batchsettlement.ChargeCountsMetadata(counts))
	if err != nil {
		_ = abortAttestedClaims(ctx, m.storage, begun)
		return nil, err
	}
	claimed := map[string]struct{}{}
	response, err := SubmitClaim(ctx, SubmitClaimInput{
		Network:    network,
		Claims:     kept,
		DataSuffix: dataSuffix,
		OnClaimed:  func(ids map[string]struct{}) { claimed = ids },
	}, m.submitContext())
	landed, releaseErr := releaseAttestedClaims(ctx, m.storage, begun, err, response)
	if landed {
		afterCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), afterClaimTimeout)
		defer cancel()
		if afterErr := afterClaim(afterCtx, m.storage, kept, network, m.settleTargetStorage, rows, begun, claimed); afterErr != nil {
			return nil, afterErr
		}
		if releaseErr != nil {
			return nil, releaseErr
		}
		return []FacilitatorClaimResult{{
			Network:     network,
			Vouchers:    len(kept),
			Transaction: response.Transaction,
		}}, nil
	}
	if err != nil {
		if releaseErr != nil {
			return nil, releaseErr
		}
		return nil, err
	}
	if releaseErr != nil {
		return nil, releaseErr
	}
	if response == nil || response.ErrorReason != ErrClaimSimulationFailed {
		return nil, fmt.Errorf("%s", formatFailure("Claim", response))
	}
	if len(kept) == 1 {
		channelID, idErr := batchsettlement.ComputeChannelId(kept[0].Voucher.Channel, network)
		if idErr != nil {
			return nil, idErr
		}
		simErr := fmt.Errorf("claim simulation failed for channel %s on %s", channelID, network)
		reportClaimError(m.logger, opts, simErr, channelID)
		if syncErr := m.resyncFailedClaim(ctx, channelID); syncErr != nil {
			return nil, syncErr
		}
		return nil, nil
	}
	mid := len(kept) / 2
	left, leftErr := m.submitClaimLeaf(ctx, network, kept[:mid], rows, opts)
	if leftErr != nil {
		return left, leftErr
	}
	right, rightErr := m.submitClaimLeaf(ctx, network, kept[mid:], rows, opts)
	return append(left, right...), rightErr
}

func (m *FacilitatorChannelManager) resyncFailedClaim(ctx context.Context, channelID string) error {
	state, err := ReadChannelState(ctx, m.signer, channelID)
	if err != nil {
		return err
	}
	return m.syncClaimMirror(ctx, channelID, state.Balance, state.TotalClaimed, state.WithdrawRequestedAt, true)
}

// syncClaimMirror writes onchain mirror fields. TotalClaimed only moves forward.
// full also overwrites Balance, WithdrawRequestedAt, and OnchainSyncedAt.
func (m *FacilitatorChannelManager) syncClaimMirror(
	ctx context.Context,
	channelID string,
	balance *big.Int,
	totalClaimed *big.Int,
	withdrawAt int,
	full bool,
) error {
	now := time.Now().UnixMilli()
	return updateChannelStrict(ctx, m.storage, channelID, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil {
			return current
		}
		next := current.Clone()
		changed := false
		if totalClaimed != nil {
			merged := storage.MaxUint256String(current.TotalClaimed, totalClaimed.String())
			if merged != current.TotalClaimed {
				next.TotalClaimed = merged
				changed = true
			}
		}
		if full && balance != nil && next.Balance != balance.String() {
			next.Balance = balance.String()
			changed = true
		}
		if full && next.WithdrawRequestedAt != withdrawAt {
			next.WithdrawRequestedAt = withdrawAt
			changed = true
		}
		if !changed {
			return current
		}
		next.OnchainSyncedAt = now
		return next
	})
}

// applyPreflightSettleDelta records a claim that landed without AfterClaim.
// The delta is onchain totalClaimed minus the stored watermark.
func (m *FacilitatorChannelManager) applyPreflightSettleDelta(
	ctx context.Context,
	network, channelID, receiver, token string,
	onchain *big.Int,
	rows []*FacilitatorChannel,
) error {
	if onchain == nil {
		return nil
	}
	storedClaimed := "0"
	stored, err := rowLookup(ctx, m.storage, rows)(channelID)
	if err != nil {
		return err
	}
	if stored != nil && stored.TotalClaimed != "" {
		storedClaimed = stored.TotalClaimed
	}
	return applyClaimedSettleDelta(ctx, m.settleTargetStorage, network, receiver, token, onchain.String(), storedClaimed)
}
