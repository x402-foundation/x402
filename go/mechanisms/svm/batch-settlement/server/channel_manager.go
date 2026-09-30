package server

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
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
type BatchChannelManagerConfig struct {
	Store                ChannelStore
	Settle               RedemptionSettler
	Requirements         types.PaymentRequirements
	MaxChannelsPerBatch  int
	RPCURL               string
	ReadPayoutWatermark  WatermarkReader
	ReadSettledWatermark WatermarkReader
	OnClaim              func(ClaimResult)
	OnSettle             func(SettleResult)
	OnSeal               func(SealResult)
	OnError              func(error)
	ReceiverAuthorizer   svm.ReceiverAuthorizerSigner
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
	var unclaimed []ChannelState
	for _, channel := range channels {
		if channel.HighestVoucherSignature != "" && channel.SignedMaxClaimable > channel.Settled {
			unclaimed = append(unclaimed, channel)
		}
	}
	var claimable, closing []ChannelState
	for _, channel := range unclaimed {
		if channel.Status == ChannelStatusOpen {
			claimable = append(claimable, channel)
		}
		if channel.Status == ChannelStatusClosing {
			closing = append(closing, channel)
		}
	}
	result := &passOutcome{claimed: []string{}, sealed: []string{}}
	for _, batch := range chunk(claimable, m.batchSize()) {
		if err := m.claimBatch(ctx, batch, result); err != nil {
			return nil, nil, err
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

func (m *BatchChannelManager) claimBatch(ctx context.Context, batch []ChannelState, result *passOutcome) error {
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
	response, err := m.submit(ctx, batchsettlement.BatchClaimPayload{Type: batchsettlement.PayloadTypeClaim, Claims: claims})
	if err != nil {
		return err
	}
	if !response.Success {
		if response.ErrorReason == batchsettlement.ErrChannelClosing {
			if len(batch) > 1 {
				for _, channel := range batch {
					if err := m.claimBatch(ctx, []ChannelState{channel}, result); err != nil {
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
		m.report(fmt.Errorf("%s claim failed: %s", batchsettlement.Scheme, reasonOrUnknown(response.ErrorReason)))
		return nil
	}
	if string(response.Network) != m.config.Requirements.Network {
		m.report(fmt.Errorf("%s claim response bound to another network", batchsettlement.Scheme))
		return nil
	}
	if accepts, present := extraField(response.Extra, "accepts"); present {
		if !claimAcceptsMatch(accepts, batch) {
			m.report(fmt.Errorf("%s claim missing confirmed settled watermark", batchsettlement.Scheme))
			return nil
		}
	}
	claimedInBatch := 0
	for _, channel := range batch {
		settled := channel.SignedMaxClaimable
		if _, present := extraField(response.Extra, "accepts"); !present {
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
		if err := m.record(channel.ChannelID, func(state ChannelState) ChannelState {
			if state.Settled > settled {
				settled = state.Settled
			}
			state.OnchainSyncedAt = time.Now().UnixMilli()
			state.Settled = settled
			return state
		}); err != nil {
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
	feePayer, _ := m.config.Requirements.Extra[batchsettlement.ExtraFeePayer].(string)
	if feePayer == "" {
		m.report(fmt.Errorf("%s seal requires requirements.extra.feePayer", batchsettlement.Scheme))
		return false, nil
	}
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
			Network:            m.config.Requirements.Network,
			FeePayer:           feePayer,
			ChannelID:          channel.ChannelID,
			MaxClaimableAmount: batchsettlement.BigU64(channel.SignedMaxClaimable),
			VoucherExpiresAt:   expiresAt,
			ValidBefore:        now + int64(m.config.Requirements.MaxTimeoutSeconds),
		})
		if err != nil {
			return false, err
		}
		payload.CloseAuthorization = &closeAuthorization
	}
	response, err := m.submit(ctx, payload)
	if err != nil {
		return false, err
	}
	if !response.Success || string(response.Network) != m.config.Requirements.Network {
		m.report(fmt.Errorf("%s seal failed: %s", batchsettlement.Scheme, reasonOrUnknown(response.ErrorReason)))
		return false, nil
	}
	finalAmount := channel.SignedMaxClaimable
	if err := m.record(channel.ChannelID, func(state ChannelState) ChannelState {
		if state.PayoutWatermark < finalAmount {
			state.PayoutWatermark = finalAmount
		}
		if state.Settled < finalAmount {
			state.Settled = finalAmount
		}
		state.OnchainSyncedAt = time.Now().UnixMilli()
		state.Status = ChannelStatusDistributed
		return state
	}); err != nil {
		return false, err
	}
	if m.config.OnSeal != nil {
		m.config.OnSeal(SealResult{Channel: channel.ChannelID, Transaction: response.Transaction})
	}
	return true, nil
}

func (m *BatchChannelManager) distribute(ctx context.Context, channels []ChannelState) ([]string, error) {
	var payable []ChannelState
	for _, channel := range channels {
		if channel.Status == ChannelStatusOpen && channel.Settled > channel.PayoutWatermark {
			payable = append(payable, channel)
		}
	}
	distributed := []string{}
	for _, batch := range chunk(payable, m.batchSize()) {
		entries := make([]batchsettlement.BatchSettleChannel, 0, len(batch))
		for _, channel := range batch {
			entries = append(entries, batchsettlement.BatchSettleChannel{
				ChannelID:     channel.ChannelID,
				ChannelConfig: channel.ChannelConfig,
			})
		}
		response, err := m.submit(ctx, batchsettlement.BatchSettlePayload{Type: batchsettlement.PayloadTypeSettle, Channels: entries})
		if err != nil {
			return nil, err
		}
		if !response.Success {
			m.report(fmt.Errorf("%s distribute failed: %s", batchsettlement.Scheme, reasonOrUnknown(response.ErrorReason)))
			continue
		}
		if string(response.Network) != m.config.Requirements.Network {
			m.report(fmt.Errorf("%s distribute response bound to another network", batchsettlement.Scheme))
			continue
		}
		if listed, present := extraField(response.Extra, "channels"); present && !distributeChannelsMatch(listed, batch) {
			m.report(fmt.Errorf("%s distribute response channel mismatch", batchsettlement.Scheme))
			continue
		}
		distributedInBatch := 0
		for _, channel := range batch {
			paid, ok, err := m.readPayoutWatermark(ctx, channel.ChannelID)
			if err != nil {
				m.report(err)
				continue
			}
			if !ok || paid > channel.Deposit {
				m.report(errors.New("confirmed payout watermark unavailable or invalid"))
				continue
			}
			if err := m.record(channel.ChannelID, func(state ChannelState) ChannelState {
				if state.PayoutWatermark < paid {
					state.PayoutWatermark = paid
				}
				state.OnchainSyncedAt = time.Now().UnixMilli()
				return state
			}); err != nil {
				m.report(err)
				continue
			}
			if paid >= channel.Settled {
				distributed = append(distributed, channel.ChannelID)
				distributedInBatch++
			}
		}
		if distributedInBatch > 0 && m.config.OnSettle != nil {
			m.config.OnSettle(SettleResult{Transaction: response.Transaction})
		}
	}
	return distributed, nil
}

func (m *BatchChannelManager) readPayoutWatermark(ctx context.Context, channelID string) (uint64, bool, error) {
	if m.config.ReadPayoutWatermark != nil {
		return m.config.ReadPayoutWatermark(ctx, channelID)
	}
	settlement, err := m.readSettlement(ctx, channelID)
	if err != nil || settlement == nil {
		return 0, false, err
	}
	return settlement.payout, true, nil
}

func (m *BatchChannelManager) readSettledWatermark(ctx context.Context, channelID string) (uint64, bool, error) {
	if m.config.ReadSettledWatermark != nil {
		return m.config.ReadSettledWatermark(ctx, channelID)
	}
	settlement, err := m.readSettlement(ctx, channelID)
	if err != nil || settlement == nil {
		return 0, false, err
	}
	return settlement.settled, true, nil
}

type settlementWatermarks struct {
	settled uint64
	payout  uint64
}

func (m *BatchChannelManager) readSettlement(ctx context.Context, channelID string) (*settlementWatermarks, error) {
	client, err := svm.CreateRPCClient(m.config.Requirements.Network, m.config.RPCURL)
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
	return &settlementWatermarks{settled: decoded.Settlement.Settled, payout: decoded.Settlement.PayoutWatermark}, nil
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

func (m *BatchChannelManager) submit(ctx context.Context, payload any) (*x402.SettleResponse, error) {
	return m.config.Settle(ctx, RedemptionRequest{
		X402Version: 2,
		Payload:     payload,
		Accepted:    m.config.Requirements,
	}, m.config.Requirements)
}

func (m *BatchChannelManager) batchSize() int {
	size := m.config.MaxChannelsPerBatch
	if size == 0 {
		size = maxChannelsPerBatch
	}
	if size < 1 {
		size = 1
	}
	if size > maxChannelsPerBatch {
		size = maxChannelsPerBatch
	}
	return size
}

func (m *BatchChannelManager) report(err error) {
	if err != nil && m.config.OnError != nil {
		m.config.OnError(err)
	}
}

func chunk(items []ChannelState, size int) [][]ChannelState {
	if size < 1 {
		size = 1
	}
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
