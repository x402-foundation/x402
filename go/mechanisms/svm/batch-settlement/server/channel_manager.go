package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"sync"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

// RedemptionRequest is the facilitator settle body a redemption pass submits.
type RedemptionRequest struct {
	X402Version int
	Payload     any
	Accepted    types.PaymentRequirements
}

// RedemptionSettler submits a server-authored redemption payload.
type RedemptionSettler func(ctx context.Context, request RedemptionRequest, requirements types.PaymentRequirements) (*x402.SettleResponse, error)

// ClaimResult is the outcome of a successful onchain claim batch.
type ClaimResult struct {
	Vouchers    int
	Transaction string
}

// SettleResult is the outcome of a successful distribute batch.
type SettleResult struct {
	Transaction string
}

// SealResult is the outcome of a successful seal on a channel the payer is closing.
type SealResult struct {
	Channel     string
	Transaction string
}

// WatermarkReader reads one confirmed u64 watermark. ok is false when the account is absent.
type WatermarkReader func(ctx context.Context, channelID string) (amount uint64, ok bool, err error)

// BatchChannelManagerConfig configures autonomous redemption.
//
// Channel state comes from the facilitator's responses (`extra.channelStates`)
// or is inferred from what the manager submitted, except a distribute's payout
// watermark, which is never inferred. The chain is read only
// through ReadSettledWatermark, ReadPayoutWatermark, or RPCURL, never through
// an implicit public RPC.
type BatchChannelManagerConfig struct {
	Store   ChannelStore
	Settle  RedemptionSettler
	Network string
	// Capacity returns the facilitator's advertised batch capacity, read at each
	// pass. Nil, or zero fields, mean none was advertised.
	Capacity            func() RedemptionCapacity
	MaxChannelsPerBatch int
	// RPCURL enables chain reads through this endpoint. Empty disables them
	// unless a watermark reader is set.
	RPCURL string
	// ReadPayoutWatermark overrides the payout watermark read; setting it enables chain reads.
	ReadPayoutWatermark WatermarkReader
	// ReadSettledWatermark overrides the settled watermark read; setting it enables chain reads.
	ReadSettledWatermark WatermarkReader
	OnClaim              func(ClaimResult)
	OnSettle             func(SettleResult)
	OnSeal               func(SealResult)
	OnError              func(error)
	ReceiverAuthorizer   svm.ReceiverAuthorizerSigner
}

// RedemptionCapacity is the batch capacity a facilitator advertises in /supported.
// A zero field means the facilitator advertised none.
type RedemptionCapacity struct {
	MaxClaimChannels  int
	MaxSettleChannels int
}

// RedemptionResult is what one redemption pass moved.
type RedemptionResult struct {
	Claimed     []string
	Distributed []string
	Sealed      []string
}

// StopOptions controls BatchChannelManager.Stop.
type StopOptions struct {
	Flush bool
}

// BatchChannelManager claims accumulated vouchers and distributes what they settle.
type BatchChannelManager struct {
	config       BatchChannelManagerConfig
	passMu       sync.Mutex
	lifeMu       sync.Mutex
	running      bool
	stop         chan struct{}
	loop         chan struct{}
	graceElapsed map[string]struct{}
}

// NewBatchChannelManager builds a worker over a store and a way to submit redemption payloads.
func NewBatchChannelManager(config BatchChannelManagerConfig) *BatchChannelManager {
	return &BatchChannelManager{
		config:       config,
		graceElapsed: map[string]struct{}{},
	}
}

// Redeem runs one redemption pass. Passes are serialized, so a slow pass cannot overlap the next.
func (m *BatchChannelManager) Redeem(ctx context.Context) (RedemptionResult, error) {
	m.passMu.Lock()
	defer m.passMu.Unlock()
	return m.runPass(ctx)
}

// Start redeems every intervalSecs until Stop.
func (m *BatchChannelManager) Start(intervalSecs int) {
	m.lifeMu.Lock()
	defer m.lifeMu.Unlock()
	if m.running {
		return
	}
	m.running = true
	m.stop = make(chan struct{})
	m.loop = make(chan struct{})
	stop := m.stop
	loop := m.loop
	go func() {
		defer close(loop)
		ticker := time.NewTicker(time.Duration(intervalSecs) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if _, err := m.Redeem(context.Background()); err != nil {
					m.report(err)
				}
			}
		}
	}()
}

// Stop ends the interval and waits for a pass already under way.
func (m *BatchChannelManager) Stop(ctx context.Context, opts StopOptions) error {
	m.lifeMu.Lock()
	if !m.running {
		m.lifeMu.Unlock()
		return nil
	}
	m.running = false
	close(m.stop)
	loop := m.loop
	m.lifeMu.Unlock()

	if opts.Flush {
		if _, err := m.Redeem(ctx); err != nil {
			m.report(err)
		}
	}
	<-loop
	return nil
}

func (m *BatchChannelManager) runPass(ctx context.Context) (RedemptionResult, error) {
	lister, ok := m.config.Store.(channelLister)
	if !ok {
		return RedemptionResult{}, errors.New("batch channel manager requires a channel store that can list its channels")
	}
	channels, err := lister.List()
	if err != nil {
		return RedemptionResult{}, err
	}
	claimed, sealed, err := m.claim(ctx, channels)
	if err != nil {
		return RedemptionResult{}, err
	}
	channels, err = lister.List()
	if err != nil {
		return RedemptionResult{}, err
	}
	distributed, err := m.distribute(ctx, channels)
	if err != nil {
		return RedemptionResult{}, err
	}
	return RedemptionResult{Claimed: claimed, Distributed: distributed, Sealed: sealed}, nil
}

func (m *BatchChannelManager) claim(ctx context.Context, channels []ChannelState) ([]string, []string, error) {
	var claimable, closing []ChannelState
	for _, channel := range channels {
		if channel.HighestVoucherSignature == "" || channel.SignedMaxClaimable <= channel.Settled {
			continue
		}
		switch channel.Status {
		case ChannelStatusOpen:
			claimable = append(claimable, channel)
		case ChannelStatusClosing:
			closing = append(closing, channel)
		}
	}
	result := &passOutcome{claimed: []string{}, sealed: []string{}}
	for _, group := range m.groupByTerms(claimable) {
		for _, batch := range chunk(group.channels, m.claimBatchSize()) {
			if err := m.claimBatch(ctx, batch, group.requirements, result, false); err != nil {
				return nil, nil, err
			}
		}
	}
	for _, channel := range closing {
		sealed, err := m.seal(ctx, channel)
		if err != nil {
			return nil, nil, err
		}
		if sealed {
			result.sealed = append(result.sealed, channel.ChannelID)
		}
	}
	return result.claimed, result.sealed, nil
}

type passOutcome struct {
	claimed []string
	sealed  []string
}

// resynced is true once a resync re-claim has run in this chain, so a second
// mismatch is reported rather than retried.
func (m *BatchChannelManager) claimBatch(ctx context.Context, batch []ChannelState, requirements types.PaymentRequirements, result *passOutcome, resynced bool) error {
	claims := make([]batchsettlement.BatchVoucherClaim, 0, len(batch))
	for _, channel := range batch {
		claims = append(claims, batchsettlement.BatchVoucherClaim{
			ChannelID:     channel.ChannelID,
			ChannelConfig: channel.ChannelConfig,
			Voucher: batchsettlement.BatchVoucher{
				ChannelID:          channel.ChannelID,
				ExpiresAt:          channel.HighestVoucherExpiresAt,
				MaxClaimableAmount: strconv.FormatUint(channel.SignedMaxClaimable, 10),
				Signature:          channel.HighestVoucherSignature,
			},
		})
	}
	response, err := m.submit(ctx, batchsettlement.BatchClaimPayload{Type: batchsettlement.PayloadTypeClaim, Claims: claims}, requirements)
	if err != nil {
		return err
	}
	if !response.Success {
		if response.ErrorReason == batchsettlement.ErrChannelClosing {
			if len(batch) > 1 {
				for _, channel := range batch {
					if err := m.claimBatch(ctx, []ChannelState{channel}, requirements, result, resynced); err != nil {
						return err
					}
				}
				return nil
			}
			sealed, err := m.seal(ctx, batch[0])
			if err != nil {
				return err
			}
			if sealed {
				result.sealed = append(result.sealed, batch[0].ChannelID)
			}
			return nil
		}
		if response.ErrorReason == batchsettlement.ErrCumulativeAmountMismatch {
			return m.resyncClaim(ctx, batch, requirements, response, result, resynced)
		}
		m.reportClaimFailure(response)
		return nil
	}
	if string(response.Network) != m.config.Network {
		m.report(fmt.Errorf("%s claim response bound to another network", batchsettlement.Scheme))
		return nil
	}
	accepts, hasAccepts := extraField(response.Extra, "accepts")
	if hasAccepts {
		if !claimAcceptsMatch(accepts, batch) {
			m.report(fmt.Errorf("%s claim missing confirmed settled watermark", batchsettlement.Scheme))
			return nil
		}
	}
	claimedInBatch := 0
	for _, channel := range batch {
		settled := channel.SignedMaxClaimable
		if !hasAccepts && m.hasSettledReader() {
			observed, ok, err := m.readSettledWatermark(ctx, channel.ChannelID)
			if err != nil {
				m.report(err)
				continue
			}
			if !ok || observed < channel.SignedMaxClaimable {
				m.report(errors.New("confirmed settled watermark unavailable or behind the claim"))
				continue
			}
			settled = observed
		}
		if err := m.recordObserved(channel.ChannelID, observedChannel{settled: settled}); err != nil {
			return err
		}
		result.claimed = append(result.claimed, channel.ChannelID)
		claimedInBatch++
	}
	if claimedInBatch > 0 && m.config.OnClaim != nil {
		m.config.OnClaim(ClaimResult{Transaction: response.Transaction, Vouchers: claimedInBatch})
	}
	return nil
}

func (m *BatchChannelManager) reportClaimFailure(response *x402.SettleResponse) {
	m.report(fmt.Errorf("%s claim failed: %s", batchsettlement.Scheme, reasonOrUnknown(response.ErrorReason)))
}

// resyncClaim's resynced channels are not new claims, so they do not reach OnClaim.
func (m *BatchChannelManager) resyncClaim(ctx context.Context, batch []ChannelState, requirements types.PaymentRequirements, response *x402.SettleResponse, result *passOutcome, resynced bool) error {
	states := m.adoptChannelStates(response, batch)
	var behind []ChannelState
	for _, channel := range batch {
		settled, ok := m.observeSettled(ctx, channel.ChannelID, states)
		if !ok || settled < channel.SignedMaxClaimable {
			behind = append(behind, channel)
			continue
		}
		if err := m.recordObserved(channel.ChannelID, observedChannel{settled: settled}); err != nil {
			return err
		}
	}
	if len(behind) == len(batch) || (len(behind) > 0 && resynced) {
		m.reportClaimFailure(response)
		return nil
	}
	if len(behind) > 0 {
		return m.claimBatch(ctx, behind, requirements, result, true)
	}
	return nil
}

func (m *BatchChannelManager) seal(ctx context.Context, channel ChannelState) (bool, error) {
	now := time.Now().Unix()
	graceElapsed := channel.CloseRequestedAt > 0 && now >= channel.CloseRequestedAt+int64(channel.WithdrawDelay)
	if graceElapsed {
		if _, reported := m.graceElapsed[channel.ChannelID]; !reported {
			m.graceElapsed[channel.ChannelID] = struct{}{}
			m.report(fmt.Errorf(
				"%s channel %s grace period elapsed: voucher value above the onchain watermark can no longer be sealed",
				batchsettlement.Scheme, channel.ChannelID,
			))
		}
		return false, nil
	}
	if err := m.record(channel.ChannelID, func(state ChannelState) ChannelState {
		if state.Status == ChannelStatusOpen {
			state.Status = ChannelStatusClosing
		}
		return state
	}); err != nil {
		return false, err
	}
	requirements := m.termsFor(channel)
	expiresAt := channel.HighestVoucherExpiresAt
	payload := batchsettlement.BatchSealPayload{
		Type:          batchsettlement.PayloadTypeSeal,
		ChannelID:     channel.ChannelID,
		ChannelConfig: channel.ChannelConfig,
		Voucher: batchsettlement.BatchVoucher{
			ChannelID:          channel.ChannelID,
			ExpiresAt:          expiresAt,
			MaxClaimableAmount: strconv.FormatUint(channel.SignedMaxClaimable, 10),
			Signature:          channel.HighestVoucherSignature,
		},
	}
	if m.config.ReceiverAuthorizer != nil {
		closeAuthorization, err := batchsettlement.SignCloseAuthorization(ctx, m.config.ReceiverAuthorizer, batchsettlement.CloseAuthorizationBinding{
			Network:            m.config.Network,
			FeePayer:           channel.FeePayer,
			ChannelID:          channel.ChannelID,
			MaxClaimableAmount: batchsettlement.BigU64(channel.SignedMaxClaimable),
			VoucherExpiresAt:   expiresAt,
			ValidBefore:        now + int64(requirements.MaxTimeoutSeconds),
		})
		if err != nil {
			return false, err
		}
		payload.CloseAuthorization = &closeAuthorization
	}
	response, err := m.submit(ctx, payload, requirements)
	if err != nil {
		return false, err
	}
	if !response.Success || string(response.Network) != m.config.Network {
		if !response.Success && response.ErrorReason == batchsettlement.ErrCloseState {
			paidOut, err := m.resyncSeal(ctx, channel, response)
			if err != nil || paidOut {
				return false, err
			}
		}
		m.report(fmt.Errorf("%s seal failed: %s", batchsettlement.Scheme, reasonOrUnknown(response.ErrorReason)))
		return false, nil
	}
	final := channel.SignedMaxClaimable
	if err := m.recordObserved(channel.ChannelID, observedChannel{status: ChannelStatusDistributed, settled: final, payout: final}); err != nil {
		return false, err
	}
	if m.config.OnSeal != nil {
		m.config.OnSeal(SealResult{Channel: channel.ChannelID, Transaction: response.Transaction})
	}
	return true, nil
}

// resyncSeal reports whether the channel is already paid out, which needs no
// further seal. A sealed channel is recorded but not sent for `settle`, because
// the facilitator's sealed `distribute` finalizes it. A resynced seal is not a
// new one, so OnSeal is not called.
func (m *BatchChannelManager) resyncSeal(ctx context.Context, channel ChannelState, response *x402.SettleResponse) (bool, error) {
	observed, ok := m.adoptChannelStates(response, []ChannelState{channel})[channel.ChannelID]
	if !ok && m.config.RPCURL != "" {
		read, err := m.readSettlement(ctx, channel.ChannelID)
		if err != nil {
			m.report(err)
		}
		if read != nil {
			observed, ok = *read, true
		}
	}
	if !ok {
		return false, nil
	}
	switch observed.status {
	case batchsettlement.ChannelStatusDistributed:
		return true, m.recordObserved(channel.ChannelID, observed)
	case batchsettlement.ChannelStatusSealed:
		return false, m.recordObserved(channel.ChannelID, observed)
	default:
		return false, nil
	}
}

func (m *BatchChannelManager) distribute(ctx context.Context, channels []ChannelState) ([]string, error) {
	var payable []ChannelState
	for _, channel := range channels {
		if channel.Status == ChannelStatusOpen && channel.Settled > channel.PayoutWatermark {
			payable = append(payable, channel)
		}
	}
	distributed := []string{}
	for _, group := range m.groupByTerms(payable) {
		for _, batch := range chunk(group.channels, m.settleBatchSize()) {
			entries := make([]batchsettlement.BatchSettleChannel, 0, len(batch))
			for _, channel := range batch {
				entries = append(entries, batchsettlement.BatchSettleChannel{
					ChannelID:     channel.ChannelID,
					ChannelConfig: channel.ChannelConfig,
				})
			}
			response, err := m.submit(ctx, batchsettlement.BatchSettlePayload{Type: batchsettlement.PayloadTypeSettle, Channels: entries}, group.requirements)
			if err != nil {
				return nil, err
			}
			if !response.Success {
				if response.ErrorReason == batchsettlement.ErrCumulativeAmountMismatch && len(m.recordPayouts(ctx, batch, m.adoptChannelStates(response, batch))) > 0 {
					continue
				}
				m.report(fmt.Errorf("%s distribute failed: %s", batchsettlement.Scheme, reasonOrUnknown(response.ErrorReason)))
				continue
			}
			if string(response.Network) != m.config.Network {
				m.report(fmt.Errorf("%s distribute response bound to another network", batchsettlement.Scheme))
				continue
			}
			if listed, present := extraField(response.Extra, "channels"); present && !distributeChannelsMatch(listed, batch) {
				m.report(fmt.Errorf("%s distribute response channel mismatch", batchsettlement.Scheme))
				continue
			}
			states := m.adoptChannelStates(response, batch)
			if states == nil && !m.hasPayoutReader() {
				m.report(errors.New("distribute confirmed but payout unknown: facilitator sent no channelStates and neither RPCURL nor ReadPayoutWatermark is set"))
			}
			paidOut := m.recordPayouts(ctx, batch, states)
			distributed = append(distributed, paidOut...)
			if len(paidOut) > 0 && m.config.OnSettle != nil {
				m.config.OnSettle(SettleResult{Transaction: response.Transaction})
			}
		}
	}
	return distributed, nil
}

// recordPayouts records the confirmed payout watermarks of batch and returns the
// channels paid up to their settled value. A confirmed distribute may answer for
// an earlier sweep that a later claim has passed, so it never stands in for the
// payout watermark: a channel without one stays payable for the next pass.
func (m *BatchChannelManager) recordPayouts(ctx context.Context, batch []ChannelState, states map[string]observedChannel) []string {
	var covered []string
	for _, channel := range batch {
		observed, ok := m.observePayout(ctx, channel, states)
		if !ok {
			continue
		}
		if err := m.recordObserved(channel.ChannelID, observed); err != nil {
			m.report(err)
			continue
		}
		if observed.payout >= channel.Settled {
			covered = append(covered, channel.ChannelID)
		}
	}
	return covered
}

// observePayout is a channel's confirmed payout watermark: the facilitator's
// state, else a configured reader.
func (m *BatchChannelManager) observePayout(ctx context.Context, channel ChannelState, states map[string]observedChannel) (observedChannel, bool) {
	if state, ok := states[channel.ChannelID]; ok {
		return state, true
	}
	if !m.hasPayoutReader() {
		return observedChannel{}, false
	}
	paid, ok, err := m.readPayoutWatermark(ctx, channel.ChannelID)
	if err != nil {
		m.report(err)
		return observedChannel{}, false
	}
	if !ok || paid > channel.Deposit {
		m.report(errors.New("confirmed payout watermark unavailable or invalid"))
		return observedChannel{}, false
	}
	return observedChannel{payout: paid}, true
}

// observeSettled is a channel's confirmed settled watermark from the
// facilitator's state or a configured reader.
func (m *BatchChannelManager) observeSettled(ctx context.Context, channelID string, states map[string]observedChannel) (uint64, bool) {
	if state, ok := states[channelID]; ok {
		return state.settled, true
	}
	if !m.hasSettledReader() {
		return 0, false
	}
	settled, ok, err := m.readSettledWatermark(ctx, channelID)
	if err != nil {
		m.report(err)
		return 0, false
	}
	return settled, ok
}

// recordObserved raises a channel's watermarks to the observed ones (a zero value
// leaves its field alone) and marks it sealed or distributed once the chain says it is.
func (m *BatchChannelManager) recordObserved(channelID string, observed observedChannel) error {
	return m.record(channelID, func(state ChannelState) ChannelState {
		state.Settled = max(state.Settled, observed.settled)
		state.PayoutWatermark = max(state.PayoutWatermark, observed.payout)
		switch {
		case observed.status == batchsettlement.ChannelStatusDistributed:
			state.Status = ChannelStatusDistributed
		case observed.status == batchsettlement.ChannelStatusSealed && state.Status != ChannelStatusDistributed:
			state.Status = ChannelStatusSealed
		}
		state.OnchainSyncedAt = time.Now().UnixMilli()
		return state
	})
}

func (m *BatchChannelManager) hasSettledReader() bool {
	return m.config.ReadSettledWatermark != nil || m.config.RPCURL != ""
}

func (m *BatchChannelManager) hasPayoutReader() bool {
	return m.config.ReadPayoutWatermark != nil || m.config.RPCURL != ""
}

type observedChannel struct {
	status  string
	settled uint64
	payout  uint64
}

// adoptChannelStates returns response's `extra.channelStates` keyed by channel,
// or nil unless the response is bound to this network and names exactly the
// batch's channels. Every entry must satisfy payout <= settled <= deposit.
func (m *BatchChannelManager) adoptChannelStates(response *x402.SettleResponse, batch []ChannelState) map[string]observedChannel {
	if string(response.Network) != m.config.Network {
		return nil
	}
	return parseChannelStates(response.Extra, batch)
}

func parseChannelStates(extra map[string]any, batch []ChannelState) map[string]observedChannel {
	raw, present := extraField(extra, batchsettlement.ExtraChannelStates)
	if !present {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var entries []batchsettlement.BatchRedemptionChannelState
	if err := json.Unmarshal(encoded, &entries); err != nil || len(entries) != len(batch) {
		return nil
	}
	observed := make(map[string]observedChannel, len(entries))
	for _, entry := range entries {
		state, ok := parseChannelState(entry)
		if !ok {
			return nil
		}
		if _, duplicate := observed[entry.ChannelID]; duplicate {
			return nil
		}
		observed[entry.ChannelID] = state
	}
	for _, channel := range batch {
		if _, named := observed[channel.ChannelID]; !named {
			return nil
		}
	}
	return observed
}

func parseChannelState(entry batchsettlement.BatchRedemptionChannelState) (observedChannel, bool) {
	switch entry.Status {
	case batchsettlement.ChannelStatusOpen, batchsettlement.ChannelStatusClosing, batchsettlement.ChannelStatusSealed, batchsettlement.ChannelStatusDistributed:
	default:
		return observedChannel{}, false
	}
	settled, settledErr := paymentchannels.ParseU64(entry.TotalClaimed, "totalClaimed")
	payout, payoutErr := paymentchannels.ParseU64(entry.PayoutWatermark, "payoutWatermark")
	deposit, depositErr := paymentchannels.ParseU64(entry.Balance, "balance")
	if settledErr != nil || payoutErr != nil || depositErr != nil || payout > settled || settled > deposit {
		return observedChannel{}, false
	}
	return observedChannel{status: entry.Status, settled: settled, payout: payout}, true
}

// readPayoutWatermark and readSettledWatermark require a reader: callers check
// hasPayoutReader and hasSettledReader first.
func (m *BatchChannelManager) readPayoutWatermark(ctx context.Context, channelID string) (uint64, bool, error) {
	if m.config.ReadPayoutWatermark != nil {
		return m.config.ReadPayoutWatermark(ctx, channelID)
	}
	observed, err := m.readSettlement(ctx, channelID)
	if err != nil || observed == nil {
		return 0, false, err
	}
	return observed.payout, true, nil
}

func (m *BatchChannelManager) readSettledWatermark(ctx context.Context, channelID string) (uint64, bool, error) {
	if m.config.ReadSettledWatermark != nil {
		return m.config.ReadSettledWatermark(ctx, channelID)
	}
	observed, err := m.readSettlement(ctx, channelID)
	if err != nil || observed == nil {
		return 0, false, err
	}
	return observed.settled, true, nil
}

// readSettlement returns nil when the channel account is absent.
func (m *BatchChannelManager) readSettlement(ctx context.Context, channelID string) (*observedChannel, error) {
	client, err := svm.CreateRPCClient(m.config.Network, m.config.RPCURL)
	if err != nil {
		return nil, err
	}
	accountKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return nil, err
	}
	account, err := client.GetAccountInfoWithOpts(ctx, accountKey, &rpc.GetAccountInfoOpts{
		Encoding:   solana.EncodingBase64,
		Commitment: paymentchannels.StateCommitment,
	})
	if err != nil {
		if errors.Is(err, rpc.ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if account == nil || account.Value == nil {
		return nil, nil
	}
	if !account.Value.Owner.Equals(paymentchannels.ProgramID) {
		return nil, errors.New("unexpected channel account owner")
	}
	decoded, err := paymentchannels.DecodeChannel(account.Value.Data.GetBinary())
	if err != nil {
		return nil, err
	}
	return &observedChannel{
		status:  batchsettlement.RedemptionStatus(generated.ChannelStatus(decoded.Status)),
		settled: decoded.Settlement.Settled,
		payout:  decoded.Settlement.PayoutWatermark,
	}, nil
}

func (m *BatchChannelManager) record(channelID string, updater func(ChannelState) ChannelState) error {
	_, err := m.config.Store.Update(channelID, func(current *ChannelState) (ChannelState, error) {
		if current == nil {
			return ChannelState{}, fmt.Errorf("channel %s vanished mid-redemption", channelID)
		}
		return updater(*current), nil
	})
	return err
}

func (m *BatchChannelManager) submit(ctx context.Context, payload any, requirements types.PaymentRequirements) (*x402.SettleResponse, error) {
	response, err := m.config.Settle(ctx, RedemptionRequest{
		X402Version: 2,
		Payload:     payload,
		Accepted:    requirements,
	}, requirements)
	var settleErr *x402.SettleError
	if errors.As(err, &settleErr) {
		return &x402.SettleResponse{
			Success:      false,
			ErrorReason:  settleErr.ErrorReason,
			ErrorMessage: settleErr.ErrorMessage,
			Payer:        settleErr.Payer,
			Transaction:  settleErr.Transaction,
			Network:      settleErr.Network,
		}, nil
	}
	return response, err
}

// claimBatchSize is the number of channels in one claim. It uses advertised
// maxClaimChannels (4 when absent, at most V1MaxClaimChannels), then MaxChannelsPerBatch when that is lower.
func (m *BatchChannelManager) claimBatchSize() int {
	return m.batchSize(m.advertised().MaxClaimChannels, batchsettlement.V1MaxClaimChannels)
}

// settleBatchSize is the number of channels in one settle. It uses advertised
// maxSettleChannels (4 when absent, at most V1MaxSettleChannels), then MaxChannelsPerBatch when that is lower.
func (m *BatchChannelManager) settleBatchSize() int {
	return m.batchSize(m.advertised().MaxSettleChannels, batchsettlement.V1MaxSettleChannels)
}

func (m *BatchChannelManager) advertised() RedemptionCapacity {
	if m.config.Capacity == nil {
		return RedemptionCapacity{}
	}
	return m.config.Capacity()
}

// batchSize never exceeds ceiling, the protocol maximum: a facilitator
// misadvertising a larger capacity would otherwise get batches the wire guard
// rejects.
func (m *BatchChannelManager) batchSize(advertised, ceiling int) int {
	capacity := maxChannelsPerBatch
	if advertised > 0 {
		capacity = min(advertised, ceiling)
	}
	size := m.config.MaxChannelsPerBatch
	if size == 0 || size > capacity {
		size = capacity
	}
	if size < 1 {
		size = 1
	}
	return size
}

func advertisedCapacity(value any) int {
	var n float64
	switch v := value.(type) {
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case uint32:
		n = float64(v)
	case float64:
		n = v
	case json.Number:
		parsed, err := v.Int64()
		if err != nil {
			return 0
		}
		n = float64(parsed)
	default:
		return 0
	}
	if n < 1 || n != math.Trunc(n) || n > math.MaxInt32 {
		return 0
	}
	return int(n)
}

type redemptionGroup struct {
	requirements types.PaymentRequirements
	channels     []ChannelState
}

// Receiver, mint, and withdraw delay come from ChannelConfig. The facilitator checks those fields.
func (m *BatchChannelManager) termsFor(channel ChannelState) types.PaymentRequirements {
	extra := map[string]interface{}{
		batchsettlement.ExtraFeePayer:           channel.FeePayer,
		batchsettlement.ExtraTokenProgram:       channel.TokenProgram,
		batchsettlement.ExtraWithdrawDelay:      channel.ChannelConfig.WithdrawDelay,
		batchsettlement.ExtraReceiverAuthorizer: channel.ChannelConfig.ReceiverAuthorizer,
	}
	if channel.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer {
		extra[batchsettlement.ExtraOperator] = channel.ChannelConfig.PayerAuthorizer
		extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
	}
	return types.PaymentRequirements{
		Scheme:            batchsettlement.Scheme,
		Network:           m.config.Network,
		Asset:             channel.ChannelConfig.Token,
		Amount:            "0",
		PayTo:             channel.ChannelConfig.Receiver,
		MaxTimeoutSeconds: redemptionTimeoutSeconds,
		Extra:             extra,
	}
}

func (m *BatchChannelManager) groupByTerms(channels []ChannelState) []redemptionGroup {
	var groups []redemptionGroup
	index := map[string]int{}
	for _, channel := range channels {
		requirements := m.termsFor(channel)
		encoded, _ := json.Marshal(requirements)
		key := string(encoded)
		position, seen := index[key]
		if !seen {
			position = len(groups)
			index[key] = position
			groups = append(groups, redemptionGroup{requirements: requirements})
		}
		groups[position].channels = append(groups[position].channels, channel)
	}
	return groups
}

func (m *BatchChannelManager) report(err error) {
	if err != nil && m.config.OnError != nil {
		m.config.OnError(err)
	}
}

func chunk(items []ChannelState, size int) [][]ChannelState {
	var batches [][]ChannelState
	for index := 0; index < len(items); index += size {
		end := index + size
		if end > len(items) {
			end = len(items)
		}
		batches = append(batches, items[index:end])
	}
	return batches
}

func reasonOrUnknown(reason string) string {
	if reason == "" {
		return "unknown"
	}
	return reason
}

func extraField(extra map[string]any, field string) (any, bool) {
	if extra == nil {
		return nil, false
	}
	value, present := extra[field]
	return value, present
}

func claimAcceptsMatch(accepts any, batch []ChannelState) bool {
	list, ok := accepts.([]any)
	if !ok || len(list) != len(batch) {
		return false
	}
	for _, channel := range batch {
		matches := 0
		var total string
		var found bool
		for _, item := range list {
			record, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if id, _ := record["channelId"].(string); id == channel.ChannelID {
				matches++
				if claimed, ok := record["totalClaimed"].(string); ok {
					total = claimed
					found = true
				}
			}
		}
		if matches != 1 || !found || total != strconv.FormatUint(channel.SignedMaxClaimable, 10) {
			return false
		}
	}
	return true
}

func distributeChannelsMatch(listed any, batch []ChannelState) bool {
	ids, ok := stringList(listed)
	if !ok || len(ids) != len(batch) {
		return false
	}
	seen := map[string]struct{}{}
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			return false
		}
		seen[id] = struct{}{}
	}
	for _, channel := range batch {
		if _, ok := seen[channel.ChannelID]; !ok {
			return false
		}
	}
	return true
}

func stringList(value any) ([]string, bool) {
	switch typed := value.(type) {
	case []string:
		return typed, true
	case []any:
		out := make([]string, len(typed))
		for i, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			out[i] = text
		}
		return out, true
	default:
		return nil, false
	}
}
