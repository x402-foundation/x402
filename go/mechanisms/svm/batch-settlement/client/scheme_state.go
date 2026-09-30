package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/google/uuid"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

func (s *BatchSvmScheme) queueCredential(
	ctx context.Context,
	requirements types.PaymentRequirements,
	terms resolvedTerms,
	key string,
	existing openChannel,
	charge, cumulative uint64,
	expiresAt int64,
) (types.PaymentPayload, error) {
	var requestID string
	var auth *struct {
		requestID string
		expiresAt int64
	}
	mode := credentialClient
	if terms.voucherSigner == batchsettlement.VoucherSignerServer {
		mode = credentialServer
		requestID = uuid.NewString()
		auth = &struct {
			requestID string
			expiresAt int64
		}{requestID: requestID, expiresAt: expiresAt}
	}
	credential, err := credentialFor(ctx, mode, existing.tracker, charge, auth, false)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	var body map[string]any
	if credential.authorization != nil {
		body, err = batchsettlement.WireMap(batchsettlement.BatchAuthorizationPayload{
			Type:          batchsettlement.PayloadTypeAuthorization,
			ChannelConfig: existing.tracker.ChannelConfig,
			Authorization: *credential.authorization,
		})
	} else {
		body, err = batchsettlement.WireMap(batchsettlement.BatchVoucherPayload{
			Type:          batchsettlement.PayloadTypeVoucher,
			ChannelConfig: existing.tracker.ChannelConfig,
			Voucher:       *credential.voucher,
		})
	}
	if err != nil {
		return types.PaymentPayload{}, err
	}
	operationKey := key
	if requestID != "" {
		operationKey = key + OperationKeySeparator + requestID
	}
	confirmed := existing
	next := pendingChannel{
		openChannel:  openChannel{tracker: existing.tracker, deposit: existing.deposit},
		confirmed:    &confirmed,
		key:          key,
		operationKey: operationKey,
		amount:       requirements.Amount,
		cumulative:   cumulative,
		payment:      PendingPayment{Payload: body, X402Version: 2},
	}
	if err := s.rememberPending(next); err != nil {
		return types.PaymentPayload{}, err
	}
	return types.PaymentPayload{X402Version: 2, Payload: body}, nil
}

func (s *BatchSvmScheme) credential(
	ctx context.Context,
	terms resolvedTerms,
	tracker *BatchChannelTracker,
	charge uint64,
	expiresAt int64,
) (signedCredential, error) {
	if terms.voucherSigner == batchsettlement.VoucherSignerServer {
		return credentialFor(ctx, credentialServer, tracker, charge, &struct {
			requestID string
			expiresAt int64
		}{requestID: uuid.NewString(), expiresAt: expiresAt}, false)
	}
	return credentialFor(ctx, credentialClient, tracker, charge, nil, false)
}

func (s *BatchSvmScheme) createRefundPayload(
	ctx context.Context,
	x402Version int,
	requirements types.PaymentRequirements,
	options RefundPayloadOptions,
) (types.PaymentPayload, error) {
	cached := s.findCachedChannelForRoute(requirements)
	existing, lookup, terms, err := s.locateRefundChannel(ctx, requirements, cached)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	if existing == nil {
		return types.PaymentPayload{}, ErrNoBatchChannelToRefund
	}
	var blockhash *solana.Hash
	if options.WithTransaction {
		rpcClient, err := s.rpcClient(lookup.Network)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		resolved, err := svm.ResolveBlockhash(ctx, rpcClient, lookup)
		if err != nil {
			return types.PaymentPayload{}, err
		}
		blockhash = &resolved
	}
	serverMode := existing.tracker.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer
	expiresAt := time.Now().Unix() + int64(lookup.MaxTimeoutSeconds)
	var credential signedCredential
	if serverMode {
		credential, err = credentialFor(ctx, credentialServer, existing.tracker, 0, &struct {
			requestID string
			expiresAt int64
		}{requestID: uuid.NewString(), expiresAt: expiresAt}, false)
	} else {
		credential, err = credentialFor(ctx, credentialClient, existing.tracker, 0, nil, true)
	}
	if err != nil {
		return types.PaymentPayload{}, err
	}
	payload, err := BuildRefundPayload(ctx, BuildRefundArgs{
		Payer:         s.signer,
		FeePayer:      terms.feePayer,
		ChannelID:     existing.tracker.ChannelID,
		ChannelConfig: existing.tracker.ChannelConfig,
		Voucher:       credential.voucher,
		Authorization: credential.authorization,
		Blockhash:     blockhash,
		Memo:          terms.memo,
	})
	if err != nil {
		return types.PaymentPayload{}, err
	}
	body, err := batchsettlement.WireMap(payload)
	if err != nil {
		return types.PaymentPayload{}, err
	}
	return types.PaymentPayload{X402Version: x402Version, Payload: body}, nil
}

func (s *BatchSvmScheme) locateRefundChannel(
	ctx context.Context,
	requirements types.PaymentRequirements,
	cached *openChannel,
) (*openChannel, types.PaymentRequirements, resolvedTerms, error) {
	lookup := requirements
	if cached != nil {
		lookup = AlignRefundRequirements(requirements, cached.tracker.ChannelConfig)
	}

	searchLookup := lookup
	if cached == nil && voucherSignerOf(searchLookup.Extra) == batchsettlement.VoucherSignerServer {
		searchLookup = ClientSignedRefundRequirements(searchLookup)
	}

	terms, err := s.resolveRefundTerms(ctx, searchLookup, cached)
	if err != nil {
		return nil, lookup, resolvedTerms{}, err
	}

	existing, err := s.loadRefundChannel(ctx, searchLookup, terms, cached)
	if err != nil {
		return nil, lookup, resolvedTerms{}, err
	}
	if existing != nil {
		if cached == nil {
			lookup = AlignRefundRequirements(requirements, existing.tracker.ChannelConfig)
			terms, err = s.resolveRefundTerms(ctx, lookup, existing)
			if err != nil {
				return nil, lookup, resolvedTerms{}, err
			}
		}
		return existing, lookup, terms, nil
	}

	if cached == nil && voucherSignerOf(requirements.Extra) == batchsettlement.VoucherSignerServer {
		serverTerms, serverErr := s.resolveTerms(ctx, requirements)
		if serverErr != nil {
			var untrusted *UntrustedOperatorError
			if errors.As(serverErr, &untrusted) {
				return nil, lookup, terms, nil
			}
			return nil, lookup, resolvedTerms{}, serverErr
		}
		discovered, discoverErr := s.discoverChannel(ctx, requirements, serverTerms)
		if discoverErr != nil {
			return nil, lookup, resolvedTerms{}, discoverErr
		}
		if discovered != nil {
			lookup = AlignRefundRequirements(requirements, discovered.tracker.ChannelConfig)
			terms, err = s.resolveRefundTerms(ctx, lookup, discovered)
			if err != nil {
				return nil, lookup, resolvedTerms{}, err
			}
			return discovered, lookup, terms, nil
		}
	}

	return nil, lookup, terms, nil
}

func (s *BatchSvmScheme) loadRefundChannel(
	ctx context.Context,
	lookup types.PaymentRequirements,
	terms resolvedTerms,
	cached *openChannel,
) (*openChannel, error) {
	key := s.channelKey(lookup, terms.feePayer, terms.withdrawDelay)
	existing, err := s.loadChannel(key)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		existing = cached
	}
	if existing == nil {
		return s.discoverChannel(ctx, lookup, terms)
	}
	return existing, nil
}

func (s *BatchSvmScheme) resolveDepositAmount(
	requirements types.PaymentRequirements,
	requestAmount, needed uint64,
	payloadCtx x402.PaymentPayloadContext,
	trust *ResolvedServerSignedTrust,
	existingDeposit uint64,
) (uint64, error) {
	multiplier := DefaultDepositMultiplier
	if s.config.DepositPolicy != nil && s.config.DepositPolicy.DepositMultiplier != nil {
		multiplier = *s.config.DepositPolicy.DepositMultiplier
	}
	var configured *uint64
	if s.config.DepositAmount != nil {
		parsed, err := paymentchannels.ParseU64(s.config.DepositAmount, "depositAmount")
		if err != nil {
			return 0, err
		}
		configured = &parsed
	}
	announced := announcedMinDeposit(requirements.Extra, requestAmount)
	target, ok := batchsettlement.MulU64(requestAmount, uint64(multiplier))
	if !ok {
		return 0, fmt.Errorf("batch-settlement amount overflow")
	}
	if announced != nil {
		target = *announced
	}
	if configured != nil {
		target = *configured
	}
	proposed := needed
	if target > needed {
		proposed = target
	}
	if cap, ok := maxDepositFromSpendCap(payloadCtx.MaxAmountPerPayment, multiplier); ok {
		if needed > cap {
			return 0, fmt.Errorf(
				"required deposit %d exceeds depositMultiplier × spendControls.maxAmountPerPayment (%d); raise maxAmountPerPayment or depositMultiplier",
				needed, cap,
			)
		}
		if proposed > cap {
			proposed = cap
		}
	}
	if trust != nil && trust.MaxDeposit != nil {
		room, ok := batchsettlement.SubU64(*trust.MaxDeposit, existingDeposit)
		if !ok || needed > room {
			total := uint64(0)
			if trust.MaxDeposit != nil {
				total = *trust.MaxDeposit
			}
			return 0, fmt.Errorf(
				"required deposit %d exceeds the remaining serverSignedChannelsPolicy maxDeposit (%d total, %d already escrowed); raise maxDeposit for this operator or use a client-signed accept",
				needed, total, existingDeposit,
			)
		}
		if proposed > room {
			proposed = room
		}
	}
	return proposed, nil
}

func (s *BatchSvmScheme) discoverChannel(
	ctx context.Context,
	requirements types.PaymentRequirements,
	terms resolvedTerms,
) (*openChannel, error) {
	if s.discoverFn != nil {
		return s.discoverFn(ctx, requirements, terms)
	}
	if s.config.DiscoverChannels != nil && !*s.config.DiscoverChannels {
		return nil, nil
	}
	rpcClient, rpcErr := s.rpcClient(requirements.Network)
	if rpcErr != nil {
		return nil, nil //nolint:nilerr // discovery treats RPC setup failure as no channel found
	}
	scan := func(ctx context.Context, program solana.PublicKey, filters []rpc.RPCFilter) (rpc.GetProgramAccountsResult, error) {
		return rpcClient.GetProgramAccountsWithOpts(ctx, program, &rpc.GetProgramAccountsOpts{
			Commitment: rpc.CommitmentConfirmed,
			Encoding:   solana.EncodingBase64,
			Filters:    filters,
		})
	}
	found, discoverErr := paymentchannels.DiscoverChannelsByPayer(ctx, scan, s.signer.Address(), solana.PublicKey{})
	if discoverErr != nil {
		return nil, nil //nolint:nilerr // discovery treats scan failure as no channel found
	}
	salt, err := s.salt()
	if err != nil {
		return nil, err
	}
	authorized := s.signer.Address().String()
	if terms.operator != "" {
		authorized = terms.operator
	}
	usable := make([]paymentchannels.DiscoveredChannel, 0, len(found))
	for _, candidate := range found {
		channel := candidate.Channel
		if generated.ChannelStatus(channel.Status) != generated.ChannelStatus_Open || channel.ClosureStartedAt != 0 {
			continue
		}
		if channel.Payee.String() != terms.feePayer || channel.Mint.String() != requirements.Asset {
			continue
		}
		if channel.AuthorizedSigner.String() != authorized || int(channel.GracePeriod) != terms.withdrawDelay {
			continue
		}
		if channel.Salt != salt {
			continue
		}
		usable = append(usable, candidate)
	}
	sort.SliceStable(usable, func(i, j int) bool {
		return usable[i].Channel.OpenSlot > usable[j].Channel.OpenSlot
	})
	if len(usable) == 0 {
		return nil, nil
	}
	channel := usable[0]
	config := batchsettlement.BatchChannelConfig{
		Payer:              channel.Channel.Payer.String(),
		PayerAuthorizer:    channel.Channel.AuthorizedSigner.String(),
		Receiver:           requirements.PayTo,
		ReceiverAuthorizer: terms.receiverAuthorizer,
		Token:              channel.Channel.Mint.String(),
		WithdrawDelay:      int(channel.Channel.GracePeriod),
		Salt:               batchsettlement.FormatU64(channel.Channel.Salt),
		OpenSlot:           int64(channel.Channel.OpenSlot),
	}
	if terms.voucherSigner == batchsettlement.VoucherSignerServer {
		config.VoucherSigner = batchsettlement.VoucherSignerServer
	}
	if uint64(config.OpenSlot) != channel.Channel.OpenSlot {
		return nil, fmt.Errorf("openSlot must fit in a JavaScript safe integer")
	}
	return &openChannel{
		deposit: channel.Channel.Deposit,
		tracker: NewBatchChannelTracker(channel.ChannelID.String(), config, s.signer, channel.Channel.Settlement.Settled),
	}, nil
}

func (s *BatchSvmScheme) loadChannel(key string) (*openChannel, error) {
	if cached, ok := s.channels[key]; ok {
		return &cached, nil
	}
	if s.config.ChannelStorage == nil {
		return nil, nil
	}
	saved, err := s.config.ChannelStorage.Get(key)
	if err != nil || saved == nil {
		return nil, err
	}
	if len(saved.Pending) == 0 {
		channel := s.hydrateChannel(*saved)
		s.rememberChannel(key, channel)
		return &channel, nil
	}
	var confirmed *openChannel
	if saved.HasConfirmedState {
		channel := s.hydrateChannel(*saved)
		confirmed = &channel
		s.rememberChannel(key, channel)
	}
	tracker := NewBatchChannelTracker(saved.ChannelID, saved.ChannelConfig, s.signer, 0)
	if confirmed != nil {
		tracker = confirmed.tracker
	}
	for _, item := range saved.Pending {
		operationKey := item.OperationKey
		if operationKey == "" {
			operationKey = key
		}
		cumulative, err := paymentchannels.ParseU64(item.ChargedCumulativeAmount, "stored pending cumulative")
		if err != nil {
			return nil, err
		}
		deposit, err := paymentchannels.ParseU64(item.Deposit, "stored pending deposit")
		if err != nil {
			return nil, err
		}
		s.storePending(pendingChannel{
			openChannel:  openChannel{tracker: tracker, deposit: deposit},
			confirmed:    confirmed,
			key:          key,
			operationKey: operationKey,
			amount:       item.Amount,
			cumulative:   cumulative,
			payment:      item.Payment,
		})
	}
	return confirmed, nil
}

func (s *BatchSvmScheme) hydrateChannel(record BatchClientChannelRecord) openChannel {
	deposit, _ := paymentchannels.ParseU64(record.Deposit, "stored deposit")
	cumulative, _ := paymentchannels.ParseU64(record.ChargedCumulativeAmount, "stored chargedCumulativeAmount")
	return openChannel{
		deposit: deposit,
		tracker: NewBatchChannelTracker(record.ChannelID, record.ChannelConfig, s.signer, cumulative),
	}
}

func (s *BatchSvmScheme) toStorageRecord(channel openChannel, confirmed bool, pending []StoredPending) BatchClientChannelRecord {
	record := BatchClientChannelRecord{
		ChannelConfig:           channel.tracker.ChannelConfig,
		ChannelID:               channel.tracker.ChannelID,
		ChargedCumulativeAmount: batchsettlement.FormatU64(channel.tracker.Cumulative()),
		Deposit:                 batchsettlement.FormatU64(channel.deposit),
		HasConfirmedState:       confirmed,
		Pending:                 pending,
	}
	return record
}

func (s *BatchSvmScheme) persistPending(pending pendingChannel) error {
	if s.config.ChannelStorage == nil {
		return nil
	}
	all := s.pendingFor(pending.key)
	confirmedChannel, hasConfirmed := s.channels[pending.key]
	var confirmed *openChannel
	if hasConfirmed {
		confirmed = &confirmedChannel
	} else if pending.confirmed != nil {
		confirmed = pending.confirmed
	}
	recordChannel := openChannel{tracker: pending.tracker, deposit: pending.deposit}
	if confirmed != nil {
		recordChannel = *confirmed
	}
	stored := make([]StoredPending, 0, len(all))
	for _, item := range all {
		stored = append(stored, StoredPending{
			Amount:                  item.amount,
			ChargedCumulativeAmount: batchsettlement.FormatU64(item.cumulative),
			Deposit:                 batchsettlement.FormatU64(item.deposit),
			OperationKey:            item.operationKey,
			Payment:                 item.payment,
		})
	}
	return s.config.ChannelStorage.Set(pending.key, s.toStorageRecord(recordChannel, confirmed != nil, stored))
}

func (s *BatchSvmScheme) storePending(pending pendingChannel) {
	s.pending[pending.operationKey] = pending
	order := s.pendingOrder[pending.key]
	for _, operationKey := range order {
		if operationKey == pending.operationKey {
			return
		}
	}
	s.pendingOrder[pending.key] = append(order, pending.operationKey)
}

func (s *BatchSvmScheme) rememberPending(pending pendingChannel) error {
	s.storePending(pending)
	return s.persistPending(pending)
}

func (s *BatchSvmScheme) forgetPending(pending pendingChannel) {
	delete(s.pending, pending.operationKey)
	order := s.pendingOrder[pending.key]
	filtered := make([]string, 0, len(order))
	for _, operationKey := range order {
		if operationKey != pending.operationKey {
			filtered = append(filtered, operationKey)
		}
	}
	if len(filtered) == 0 {
		delete(s.pendingOrder, pending.key)
		return
	}
	s.pendingOrder[pending.key] = filtered
}

func (s *BatchSvmScheme) pendingFor(key string) []pendingChannel {
	order := s.pendingOrder[key]
	out := make([]pendingChannel, 0, len(order))
	for _, operationKey := range order {
		if pending, ok := s.pending[operationKey]; ok {
			out = append(out, pending)
		}
	}
	return out
}

func (s *BatchSvmScheme) rememberChannel(key string, channel openChannel) {
	if _, ok := s.channels[key]; !ok {
		s.channelOrder = append(s.channelOrder, key)
	}
	s.channels[key] = channel
}

func (s *BatchSvmScheme) handlePaymentResponse(ctx context.Context, response x402.PaymentResponseContext) (bool, error) {
	parsed, parseErr := batchsettlement.ParseBatchPayload(response.PaymentPayload.Payload)
	if parseErr != nil {
		return false, nil //nolint:nilerr // non-batch payload: ignore response
	}
	if parsed.Type != batchsettlement.PayloadTypeAuthorization &&
		parsed.Type != batchsettlement.PayloadTypeVoucher &&
		parsed.Type != batchsettlement.PayloadTypeDeposit {
		return false, nil
	}
	requestID := ""
	voucherChannelID := ""
	switch parsed.Type {
	case batchsettlement.PayloadTypeAuthorization:
		if parsed.Authorization != nil {
			requestID = parsed.Authorization.RequestID
		}
	case batchsettlement.PayloadTypeDeposit:
		if parsed.Authorization != nil {
			requestID = parsed.Authorization.RequestID
		}
		if parsed.Voucher != nil {
			voucherChannelID = parsed.Voucher.ChannelID
		}
	case batchsettlement.PayloadTypeVoucher:
		if parsed.Voucher != nil {
			voucherChannelID = parsed.Voucher.ChannelID
		}
	}
	findPending := func() (pendingChannel, bool) {
		for _, candidate := range s.pending {
			if requestID != "" {
				wire, err := batchsettlement.ParseBatchPayload(candidate.payment.Payload)
				if err != nil || wire.Type == batchsettlement.PayloadTypeVoucher || wire.Authorization == nil {
					continue
				}
				if wire.Authorization.RequestID == requestID {
					return candidate, true
				}
				continue
			}
			if candidate.tracker.ChannelID == voucherChannelID {
				return candidate, true
			}
		}
		return pendingChannel{}, false
	}
	pending, ok := findPending()
	if !ok && s.config.ChannelStorage != nil {
		terms, err := s.resolveTerms(ctx, response.Requirements)
		if err != nil {
			return false, err
		}
		if _, err := s.loadChannel(s.channelKey(response.Requirements, terms.feePayer, terms.withdrawDelay)); err != nil {
			return false, err
		}
		pending, ok = findPending()
	}
	if !ok {
		return false, nil
	}
	s.forgetPending(pending)

	success := response.SettleResponse != nil && response.SettleResponse.Success
	if !success {
		if err := s.restoreConfirmedChannel(pending); err != nil {
			return false, err
		}
		if response.PaymentRequired == nil {
			return false, nil
		}
		return s.adoptCorrectiveState(pending, *response.PaymentRequired)
	}

	extra := response.SettleResponse.Extra
	requestAmount, err := paymentchannels.ParseU64(response.Requirements.Amount, "requirements.amount")
	if err != nil {
		return false, err
	}
	localPrior := uint64(0)
	if pending.confirmed != nil {
		localPrior = pending.confirmed.tracker.Cumulative()
	}
	var charged uint64
	var confirmedCumulative uint64
	if pending.tracker.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer {
		voucher, voucherOK := parseWireVoucher(extra["voucher"])
		cumulative := uint64(0)
		cumulativeOK := false
		if voucherOK && batchsettlement.IsDigits(voucher.MaxClaimableAmount) {
			cumulative, err = paymentchannels.ParseU64(voucher.MaxClaimableAmount, "maxClaimableAmount")
			cumulativeOK = err == nil
		}
		if !voucherOK || !cumulativeOK || voucher.ChannelID != pending.tracker.ChannelID || voucher.ExpiresAt != 0 ||
			!voucherSignedBy(voucher, cumulative, pending.tracker.ChannelConfig.PayerAuthorizer) {
			if err := s.restoreConfirmedChannel(pending); err != nil {
				return false, err
			}
			return false, fmt.Errorf("batch-settlement PAYMENT-RESPONSE has an invalid server voucher")
		}
		if cumulative < localPrior {
			if err := s.restoreConfirmedChannel(pending); err != nil {
				return false, err
			}
			return false, nil
		}
		delta, _ := batchsettlement.SubU64(cumulative, localPrior)
		if delta > requestAmount {
			if err := s.restoreConfirmedChannel(pending); err != nil {
				return false, err
			}
			return false, nil
		}
		charged = delta
		confirmedCumulative, err = batchsettlement.AddU64Checked(localPrior, charged)
		if err != nil {
			return false, err
		}
	} else {
		chargedAmount, _ := extra["chargedAmount"].(string)
		if !batchsettlement.IsDigits(chargedAmount) {
			return false, fmt.Errorf("batch-settlement PAYMENT-RESPONSE charged an unexpected amount")
		}
		charged, err = paymentchannels.ParseU64(chargedAmount, "chargedAmount")
		if err != nil || charged != requestAmount {
			return false, fmt.Errorf("batch-settlement PAYMENT-RESPONSE charged an unexpected amount")
		}
		confirmedCumulative, err = batchsettlement.AddU64Checked(localPrior, charged)
		if err != nil {
			return false, err
		}
	}
	commitmentID, _ := extra["commitmentId"].(string)
	reported := reportedCumulative(extra["channelState"])
	if commitmentID == "" || (reported != "" && reported != batchsettlement.FormatU64(confirmedCumulative)) {
		if err := s.restoreConfirmedChannel(pending); err != nil {
			return false, err
		}
		return false, nil
	}
	deposited := uint64(0)
	if parsed.Type == batchsettlement.PayloadTypeDeposit && parsed.Deposit != nil {
		deposited, err = paymentchannels.ParseU64(parsed.Deposit.Amount, "deposit.amount")
		if err != nil {
			return false, err
		}
	}
	if confirmedCumulative > pending.tracker.Cumulative() {
		if err := pending.tracker.Commit(confirmedCumulative); err != nil {
			return false, err
		}
	}
	base := uint64(0)
	if pending.confirmed != nil {
		base = pending.confirmed.deposit
	}
	pending.deposit, err = batchsettlement.AddU64Checked(base, deposited)
	if err != nil {
		return false, err
	}
	confirmed := openChannel{deposit: pending.deposit, tracker: pending.tracker}
	s.rememberChannel(pending.key, confirmed)
	if remaining := s.pendingFor(pending.key); len(remaining) > 0 {
		return false, s.persistPending(remaining[0])
	}
	if s.config.ChannelStorage == nil {
		return false, nil
	}
	return false, s.config.ChannelStorage.Set(pending.key, s.toStorageRecord(confirmed, false, nil))
}

func (s *BatchSvmScheme) adoptCorrectiveState(pending pendingChannel, required types.PaymentRequired) (bool, error) {
	if required.Error != batchsettlement.ErrCumulativeAmountMismatch {
		return false, nil
	}
	var accept *types.PaymentRequirements
	for i := range required.Accepts {
		candidate := required.Accepts[i]
		if candidate.Scheme != batchsettlement.Scheme {
			continue
		}
		state, ok := parseChannelState(candidate.Extra[batchsettlement.ExtraChannelState])
		if ok && state.ChannelID == pending.tracker.ChannelID {
			accept = &candidate
			break
		}
	}
	if accept == nil {
		return false, nil
	}
	channelState, ok := parseChannelState(accept.Extra[batchsettlement.ExtraChannelState])
	if !ok || channelState.ChargedCumulativeAmount == "" {
		return false, nil
	}
	charged, err := paymentchannels.ParseU64(channelState.ChargedCumulativeAmount, "chargedCumulativeAmount")
	if err != nil {
		return false, err
	}
	claimed, err := paymentchannels.ParseU64(channelState.TotalClaimed, "totalClaimed")
	if err != nil {
		return false, err
	}
	if charged < claimed {
		return false, nil
	}
	if pending.tracker.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer {
		unresolved := uint64(0)
		for _, candidate := range s.pendingFor(pending.key) {
			amount, err := paymentchannels.ParseU64(candidate.amount, "pending amount")
			if err != nil {
				return false, err
			}
			unresolved, err = batchsettlement.AddU64Checked(unresolved, amount)
			if err != nil {
				return false, err
			}
		}
		prior := uint64(0)
		if pending.confirmed != nil {
			prior = pending.confirmed.tracker.Cumulative()
		}
		thisAmount, err := paymentchannels.ParseU64(pending.amount, "pending amount")
		if err != nil {
			return false, err
		}
		authorized, err := batchsettlement.AddU64Checked(prior, thisAmount)
		if err != nil {
			return false, err
		}
		authorized, err = batchsettlement.AddU64Checked(authorized, unresolved)
		if err != nil {
			return false, err
		}
		if charged > authorized {
			return false, nil
		}
	}
	if voucherState, ok := parseVoucherState(accept.Extra[batchsettlement.ExtraVoucherState]); ok {
		signed, parseErr := paymentchannels.ParseU64(voucherState.SignedMaxClaimable, "signedMaxClaimable")
		if parseErr != nil || charged > signed || !voucherStateSigned(pending.tracker.ChannelID, voucherState, pending.tracker.ChannelConfig.PayerAuthorizer) {
			return false, nil //nolint:nilerr // invalid voucher state: do not adopt channel
		}
	} else if charged != claimed {
		return false, nil
	}
	balance, err := paymentchannels.ParseU64(channelState.Balance, "channelState.balance")
	if err != nil {
		return false, err
	}
	adopted := openChannel{
		deposit: balance,
		tracker: NewBatchChannelTracker(pending.tracker.ChannelID, pending.tracker.ChannelConfig, s.signer, charged),
	}
	s.rememberChannel(pending.key, adopted)
	if s.config.ChannelStorage == nil {
		return true, nil
	}
	if err := s.config.ChannelStorage.Set(pending.key, s.toStorageRecord(adopted, false, nil)); err != nil {
		return false, err
	}
	return true, nil
}

func (s *BatchSvmScheme) restoreConfirmedChannel(pending pendingChannel) error {
	if remaining := s.pendingFor(pending.key); len(remaining) > 0 {
		return s.persistPending(remaining[0])
	}
	if pending.confirmed == nil {
		if s.config.ChannelStorage == nil {
			return nil
		}
		return s.config.ChannelStorage.Delete(pending.key)
	}
	s.rememberChannel(pending.key, *pending.confirmed)
	if s.config.ChannelStorage == nil {
		return nil
	}
	return s.config.ChannelStorage.Set(pending.key, s.toStorageRecord(*pending.confirmed, false, nil))
}

func (s *BatchSvmScheme) findCachedChannelForRoute(requirements types.PaymentRequirements) *openChannel {
	for _, key := range s.channelOrder {
		channel, ok := s.channels[key]
		if !ok {
			continue
		}
		if channel.tracker.ChannelConfig.Receiver == requirements.PayTo && channel.tracker.ChannelConfig.Token == requirements.Asset {
			return &channel
		}
	}
	return nil
}

func (s *BatchSvmScheme) resolveRefundTerms(
	ctx context.Context,
	probed types.PaymentRequirements,
	cached *openChannel,
) (resolvedTerms, error) {
	if cached != nil && cached.tracker.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer {
		clientProbed := probed
		extra := map[string]any{}
		for key, value := range probed.Extra {
			extra[key] = value
		}
		delete(extra, batchsettlement.ExtraOperator)
		extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerClient
		clientProbed.Extra = extra
		terms, err := s.resolveTerms(ctx, clientProbed)
		if err != nil {
			return resolvedTerms{}, err
		}
		terms.operator = cached.tracker.ChannelConfig.PayerAuthorizer
		terms.voucherSigner = batchsettlement.VoucherSignerServer
		terms.trust = nil
		return terms, nil
	}
	return s.resolveTerms(ctx, probed)
}

func (s *BatchSvmScheme) channelKey(requirements types.PaymentRequirements, feePayer string, withdrawDelay int) string {
	return fmt.Sprintf("%s:%s:%s:%s:%d:%s:%s:%s",
		requirements.Network,
		requirements.Asset,
		requirements.PayTo,
		feePayer,
		withdrawDelay,
		extraString(requirements.Extra, batchsettlement.ExtraReceiverAuthorizer),
		voucherSignerOf(requirements.Extra),
		extraString(requirements.Extra, batchsettlement.ExtraOperator),
	)
}

func (s *BatchSvmScheme) resolveTerms(ctx context.Context, requirements types.PaymentRequirements) (resolvedTerms, error) {
	extra := requirements.Extra
	if extra == nil {
		return resolvedTerms{}, fmt.Errorf("requirements.extra is required")
	}
	if value, ok := extra[batchsettlement.ExtraPaymentFlow]; ok && value != nil && value != "authorization" {
		return resolvedTerms{}, fmt.Errorf("extra.paymentFlow must be \"authorization\" when present")
	}
	feePayer, ok := extra[batchsettlement.ExtraFeePayer].(string)
	if !ok || feePayer == "" {
		return resolvedTerms{}, fmt.Errorf("extra.feePayer must be a non-empty string")
	}
	withdrawDelay, ok := extraInt(extra[batchsettlement.ExtraWithdrawDelay])
	if !ok || withdrawDelay < batchsettlement.MinWithdrawDelay || withdrawDelay > batchsettlement.MaxWithdrawDelay || withdrawDelay < requirements.MaxTimeoutSeconds {
		return resolvedTerms{}, fmt.Errorf("extra.withdrawDelay is outside the allowed range")
	}
	tokenProgram, err := paymentchannels.RequireTokenProgramHint(extra, "extra.tokenProgram is not a supported SPL token program")
	if err != nil {
		return resolvedTerms{}, err
	}
	rpcClient, err := s.rpcClient(requirements.Network)
	if err != nil {
		return resolvedTerms{}, err
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return resolvedTerms{}, err
	}
	metadata, err := s.mintCache.GetOrFetch(ctx, rpcClient, requirements.Network, mint)
	if err != nil {
		return resolvedTerms{}, err
	}
	if !metadata.TokenProgramID.Equals(tokenProgram) {
		return resolvedTerms{}, fmt.Errorf("extra.tokenProgram does not own requirements.asset")
	}
	receiverAuthorizer, ok := extra[batchsettlement.ExtraReceiverAuthorizer].(string)
	if !ok || receiverAuthorizer == "" {
		return resolvedTerms{}, fmt.Errorf("extra.receiverAuthorizer must be a non-empty string")
	}
	var memo *string
	if value, present := extra[batchsettlement.ExtraMemo]; present {
		text, ok := value.(string)
		if !ok {
			return resolvedTerms{}, fmt.Errorf("extra.memo must be a string when present")
		}
		memo = &text
	}
	voucherSigner := voucherSignerOf(extra)
	if raw, present := extra[batchsettlement.ExtraVoucherSigner]; present && raw != nil {
		text, ok := raw.(string)
		if !ok || (text != batchsettlement.VoucherSignerClient && text != batchsettlement.VoucherSignerServer) {
			return resolvedTerms{}, fmt.Errorf("extra.voucherSigner must be \"client\" or \"server\"")
		}
	}
	operator := ""
	if raw, present := extra[batchsettlement.ExtraOperator]; present {
		text, ok := raw.(string)
		if voucherSigner == batchsettlement.VoucherSignerServer && (!ok || text == "") {
			return resolvedTerms{}, fmt.Errorf("extra.operator is required for operator voucher signing")
		}
		if voucherSigner == batchsettlement.VoucherSignerClient {
			return resolvedTerms{}, fmt.Errorf("extra.operator is only valid for operator voucher signing")
		}
		operator = text
	} else if voucherSigner == batchsettlement.VoucherSignerServer {
		return resolvedTerms{}, fmt.Errorf("extra.operator is required for operator voucher signing")
	}
	var trust *ResolvedServerSignedTrust
	if voucherSigner == batchsettlement.VoucherSignerServer {
		grant, err := s.trust.GrantFor(requirements)
		if err != nil {
			return resolvedTerms{}, err
		}
		trust = &grant
	}
	return resolvedTerms{
		feePayer:           feePayer,
		receiverAuthorizer: receiverAuthorizer,
		tokenProgram:       tokenProgram.String(),
		withdrawDelay:      withdrawDelay,
		memo:               memo,
		voucherSigner:      voucherSigner,
		operator:           operator,
		trust:              trust,
	}, nil
}

func (s *BatchSvmScheme) rpcClient(network string) (*rpc.Client, error) {
	return svm.CreateRPCClient(network, s.config.RPCURL)
}

func (s *BatchSvmScheme) salt() (uint64, error) {
	if s.config.Salt == nil {
		return 0, nil
	}
	return paymentchannels.ParseU64(s.config.Salt, "salt")
}

func authorizationExpiry(maxTimeoutSeconds int) int64 {
	timeout := maxTimeoutSeconds
	if timeout < 1 {
		timeout = 1
	}
	return time.Now().Unix() + int64(timeout)
}

func requirementsFingerprint(requirements types.PaymentRequirements) string {
	encoded, err := json.Marshal(requirements)
	if err != nil {
		return requirements.Network + "\x00" + requirements.Asset + "\x00" + requirements.Amount
	}
	return string(encoded)
}

func voucherSignerOf(extra map[string]any) string {
	if text := extraString(extra, batchsettlement.ExtraVoucherSigner); text != "" {
		return text
	}
	return batchsettlement.VoucherSignerClient
}

func extraString(extra map[string]any, key string) string {
	if extra == nil {
		return ""
	}
	text, _ := extra[key].(string)
	return text
}

func extraInt(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int32:
		return int(typed), true
	case int64:
		if typed != int64(int(typed)) {
			return 0, false
		}
		return int(typed), true
	case float64:
		if typed != float64(int64(typed)) {
			return 0, false
		}
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

func announcedMinDeposit(extra map[string]any, requestAmount uint64) *uint64 {
	if extra == nil {
		return nil
	}
	text, ok := extra[batchsettlement.ExtraMinDeposit].(string)
	if !ok || !batchsettlement.IsDigits(text) {
		return nil
	}
	parsed, err := paymentchannels.ParseU64(text, "minDeposit")
	if err != nil || parsed < requestAmount || parsed == 0 {
		return nil
	}
	return &parsed
}

func maxDepositFromSpendCap(maxAmountPerPayment string, multiplier int) (uint64, bool) {
	if maxAmountPerPayment == "" || !batchsettlement.IsDigits(maxAmountPerPayment) {
		return 0, false
	}
	parsed, err := paymentchannels.ParseU64(maxAmountPerPayment, "maxAmountPerPayment")
	if err != nil || parsed == 0 {
		return 0, false
	}
	product, ok := batchsettlement.MulU64(parsed, uint64(multiplier))
	return product, ok
}

func parseWireVoucher(value any) (batchsettlement.BatchVoucher, bool) {
	record, ok := anyMap(value)
	if !ok || !batchsettlement.IsBatchVoucher(record) {
		return batchsettlement.BatchVoucher{}, false
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return batchsettlement.BatchVoucher{}, false
	}
	var voucher batchsettlement.BatchVoucher
	if err := json.Unmarshal(encoded, &voucher); err != nil {
		return batchsettlement.BatchVoucher{}, false
	}
	return voucher, true
}

func parseChannelState(value any) (batchsettlement.BatchChannelState, bool) {
	if value == nil {
		return batchsettlement.BatchChannelState{}, false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return batchsettlement.BatchChannelState{}, false
	}
	var state batchsettlement.BatchChannelState
	if err := json.Unmarshal(encoded, &state); err != nil || state.ChannelID == "" {
		return batchsettlement.BatchChannelState{}, false
	}
	return state, true
}

func parseVoucherState(value any) (batchsettlement.BatchVoucherState, bool) {
	if value == nil {
		return batchsettlement.BatchVoucherState{}, false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return batchsettlement.BatchVoucherState{}, false
	}
	var state batchsettlement.BatchVoucherState
	if err := json.Unmarshal(encoded, &state); err != nil || state.Signature == "" {
		return batchsettlement.BatchVoucherState{}, false
	}
	return state, true
}

func reportedCumulative(value any) string {
	state, ok := parseChannelState(value)
	if !ok {
		return ""
	}
	return state.ChargedCumulativeAmount
}

func voucherSignedBy(voucher batchsettlement.BatchVoucher, cumulative uint64, signer string) bool {
	channel, err := solana.PublicKeyFromBase58(voucher.ChannelID)
	if err != nil {
		return false
	}
	message := paymentchannels.EncodeVoucherMessage(channel, cumulative, voucher.ExpiresAt)
	return paymentchannels.VerifyVoucherSignature(voucher.Signature, signer, message) == nil
}

func voucherStateSigned(channelID string, state batchsettlement.BatchVoucherState, signer string) bool {
	signed, err := paymentchannels.ParseU64(state.SignedMaxClaimable, "signedMaxClaimable")
	if err != nil {
		return false
	}
	return voucherSignedBy(batchsettlement.BatchVoucher{
		ChannelID:          channelID,
		MaxClaimableAmount: state.SignedMaxClaimable,
		ExpiresAt:          state.ExpiresAt,
		Signature:          state.Signature,
	}, signed, signer)
}

func anyMap(value any) (map[string]any, bool) {
	if record, ok := value.(map[string]any); ok {
		return record, true
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, false
	}
	var record map[string]any
	if err := json.Unmarshal(encoded, &record); err != nil {
		return nil, false
	}
	return record, true
}
