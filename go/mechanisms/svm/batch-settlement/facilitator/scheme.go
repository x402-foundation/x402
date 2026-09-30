package facilitator

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mrand "math/rand/v2"
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

// Config is the optional configuration of the batch-settlement SVM facilitator.
type Config struct {
	PendingSettlementStore  PendingSettlementStore
	OnDistributionConfirmed OnDistributionConfirmed
	// ChannelStorage is the one channel store for every use case: the lifecycle
	// index, the receiver-authorizer binding, the delegated caller identity,
	// and rent cleanup. Unset uses one in-memory instance of this same store.
	// Opens and activity are written here before broadcast. A failed write
	// does not broadcast the transaction.
	ChannelStorage              paymentchannels.PaymentChannelStorage
	OnStorageError              paymentchannels.OnStorageError
	MaxIdleSecs                 *int64
	MaxPriorityFeeMicroLamports *uint64
	MaxComputeUnits             *uint32
	MaxRequiredSignatures       *int
	// ReceiverBindingHistoryReader is the optional archive-RPC fallback for a
	// channel row with no receiver-authorizer binding. A binding read from
	// history is written back when the row is absent. Nil leaves history off;
	// the facilitator does not adopt a reader from the signer.
	ReceiverBindingHistoryReader ReceiverBindingHistoryReader
	// DelegatedReceiverAuth opts in to facilitator-delegated closes. Advertised
	// only when ResolveCallerIdentity is set. The identity is written on
	// ChannelStorage, the same store as every other channel write.
	DelegatedReceiverAuth *DelegatedReceiverAuth
}

type schemeHooks struct {
	resolveTerms          func(context.Context, batchsettlement.BatchChannelConfig, types.PaymentRequirements, VoucherModeBinding) (BatchTerms, error)
	deriveChannelID       func(context.Context, batchsettlement.BatchChannelConfig, string) (string, error)
	fetchChannel          func(context.Context, string, string) (*generated.Channel, error)
	readChannel           func(context.Context, string, string) (*generated.Channel, error)
	distributeInstruction func(context.Context, string, *generated.Channel, BatchTerms, types.PaymentRequirements) (solana.Instruction, error)
	submitRedemption      func(context.Context, string, string, []solana.Instruction, string, string) (durableResult, error)
	reconcileBroadcast    func(context.Context, string, string, string, string) (durableResult, error)
	waitForChannelRead    func(int) error
	sealDependencies      func() SealDependencies
	validateDeposit       func(context.Context, batchsettlement.ParsedBatchPayload, types.PaymentRequirements, ProofAmountBound) (ValidatedDeposit, error)
	broadcastDurably      func(context.Context, string, string, string, func(func(string, string) error) (string, error)) (durableResult, error)
}

// BatchSvmScheme is the facilitator role of SVM batch settlement.
type BatchSvmScheme struct {
	config          Config
	raw             paymentchannels.PaymentChannelFacilitatorSigner
	signer          *recordingSigner
	channelStorage  paymentchannels.PaymentChannelStorage
	pendingStore    PendingSettlementStore
	settlementCache *svm.SettlementCache
	maxIdleSecs     int64
	history         ReceiverBindingHistoryReader
	delegated       *DelegatedReceiverAuth

	mu                sync.Mutex
	confirmationSlots map[string]uint64
	hooks             schemeHooks
	now               func() int64
}

// NewBatchSvmScheme creates a batch-settlement facilitator. It panics when the
// signer cannot settle, delegated auth is incomplete, or the idle window is invalid.
func NewBatchSvmScheme(ctx context.Context, signer svm.FacilitatorSvmSigner, config *Config) *BatchSvmScheme {
	if config == nil {
		config = &Config{}
	}
	raw := paymentchannels.AssertPaymentChannelFacilitatorSigner(signer, "BatchSvmScheme")
	if len(raw.GetAddresses(ctx, "")) == 0 {
		panic("BatchSvmScheme requires at least one fee payer signer")
	}
	delegated, err := AssertDelegatedReceiverAuth(config.DelegatedReceiverAuth)
	if err != nil {
		panic(err)
	}
	idle, err := paymentchannels.AssertMaxIdleSecs(config.MaxIdleSecs)
	if err != nil {
		panic(err)
	}
	if config.ChannelStorage == nil {
		config.ChannelStorage = paymentchannels.NewInMemoryPaymentChannelStorage()
	}
	pending := config.PendingSettlementStore
	if pending == nil {
		pending = NewInMemoryPendingSettlementStore()
	}
	scheme := &BatchSvmScheme{
		config:            *config,
		raw:               raw,
		channelStorage:    config.ChannelStorage,
		pendingStore:      pending,
		settlementCache:   svm.NewSettlementCache(),
		maxIdleSecs:       idle,
		history:           config.ReceiverBindingHistoryReader,
		delegated:         delegated,
		confirmationSlots: map[string]uint64{},
		now:               func() int64 { return time.Now().Unix() },
	}
	scheme.signer = &recordingSigner{PaymentChannelFacilitatorSigner: raw, scheme: scheme}
	return scheme
}

func (f *BatchSvmScheme) Scheme() string { return batchsettlement.Scheme }

func (f *BatchSvmScheme) CaipFamily() string { return "solana:*" }

// GetExtra returns the fee payer and, when set, the idle window and delegated authorizer.
func (f *BatchSvmScheme) GetExtra(network x402.Network) map[string]any {
	return f.getExtra(context.Background(), network)
}

func (f *BatchSvmScheme) getExtra(ctx context.Context, network x402.Network) map[string]any {
	addresses := f.raw.GetAddresses(ctx, string(network))
	extra := map[string]any{
		batchsettlement.ExtraFeePayer: addresses[mrand.IntN(len(addresses))].String(),
	}
	if f.maxIdleSecs > 0 {
		extra[batchsettlement.ExtraMaxIdleSecs] = f.maxIdleSecs
	}
	if f.delegated != nil {
		extra[batchsettlement.ExtraReceiverAuthorizer] = f.delegated.ReceiverAuthorizer
	}
	return extra
}

// GetSigners returns the fee payer addresses.
func (f *BatchSvmScheme) GetSigners(network x402.Network) []string {
	addresses := f.raw.GetAddresses(context.Background(), string(network))
	out := make([]string, len(addresses))
	for i, address := range addresses {
		out[i] = address.String()
	}
	return out
}

// GetChannelStorage returns the lifecycle index used for rent cleanup.
func (f *BatchSvmScheme) GetChannelStorage() paymentchannels.PaymentChannelStorage {
	return f.channelStorage
}

// CreateRentCleanupManager returns a manager bound to this scheme's storage.
func (f *BatchSvmScheme) CreateRentCleanupManager(network x402.Network) *BatchSvmRentCleanupManager {
	idle := f.maxIdleSecs
	return NewBatchSvmRentCleanupManager(RentCleanupConfig{
		Signer:      f.raw,
		Network:     string(network),
		MaxIdleSecs: &idle,
		Storage:     f.channelStorage,
	})
}

// DiscoverChannels rebuilds the onchain lifecycle view after local index loss.
func (f *BatchSvmScheme) DiscoverChannels(ctx context.Context, network x402.Network) ([]paymentchannels.DiscoveredChannel, error) {
	getter, ok := f.raw.(interface {
		GetProgramAccounts(context.Context, string, solana.PublicKey, *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error)
	})
	if !ok {
		return nil, errors.New("discoverChannels requires GetProgramAccounts on the signer")
	}
	querier := signerProgramQuerier{signer: getter, network: string(network)}
	seen := map[string]paymentchannels.DiscoveredChannel{}
	var ordered []paymentchannels.DiscoveredChannel
	for _, rentPayer := range f.raw.GetAddresses(ctx, string(network)) {
		found, err := paymentchannels.DiscoverChannelsByRentPayer(ctx, querier, rentPayer)
		if err != nil {
			return nil, err
		}
		for _, channel := range found {
			id := channel.ChannelID.String()
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = channel
			ordered = append(ordered, channel)
		}
	}
	return ordered, nil
}

// Verify checks a client payload without broadcasting.
func (f *BatchSvmScheme) Verify(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, _ *x402.FacilitatorContext) (*x402.VerifyResponse, error) {
	record, ok := payloadRecord(payload.Payload)
	if !ok || !batchsettlement.IsBatchPayload(record) {
		return VerifyFailure(batchsettlement.ErrPayloadType, "", ""), nil
	}
	parsed, err := batchsettlement.ParseBatchPayload(record)
	if err != nil {
		return VerifyFailure(batchsettlement.ErrPayloadType, "", ""), nil //nolint:nilerr // a malformed payload is an invalid payment, not a transport failure
	}
	payer := parsed.ChannelConfig.Payer
	if payload.Accepted.Scheme != batchsettlement.Scheme || requirements.Scheme != batchsettlement.Scheme {
		return VerifyFailure("unsupported_scheme", payer, ""), nil
	}
	if payload.Accepted.Network != requirements.Network {
		return VerifyFailure("network_mismatch", payer, ""), nil
	}
	response, err := f.verifyParsed(ctx, record, parsed, requirements)
	if err != nil {
		return VerifyFailure(ClassifyError(err), payer, err.Error()), nil
	}
	return response, nil
}

// Settle broadcasts or reconciles a facilitator payload.
func (f *BatchSvmScheme) Settle(ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements, fctx *x402.FacilitatorContext) (*x402.SettleResponse, error) {
	record, ok := payloadRecord(payload.Payload)
	if !ok || !batchsettlement.IsBatchFacilitatorPayload(record) {
		return SettleFailure(x402.Network(payload.Accepted.Network), batchsettlement.ErrPayloadType, "", ""), nil
	}
	var facilitatorContext any
	if fctx != nil {
		facilitatorContext = fctx
	}
	response, err := f.settleParsed(ctx, record, requirements, facilitatorContext)
	if err != nil {
		payer := ""
		if config, ok := record["channelConfig"].(map[string]any); ok {
			payer, _ = config["payer"].(string)
		}
		return SettleFailure(x402.Network(payload.Accepted.Network), ClassifyError(err), payer, err.Error()), nil
	}
	return response, nil
}

func (f *BatchSvmScheme) verifyParsed(ctx context.Context, record map[string]any, parsed batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements) (*x402.VerifyResponse, error) {
	switch parsed.Type {
	case batchsettlement.PayloadTypeDeposit:
		validated, err := f.validateDeposit(ctx, parsed, requirements, ProofAmountExact)
		if err != nil {
			return nil, err
		}
		return &x402.VerifyResponse{
			IsValid: true,
			Payer:   parsed.ChannelConfig.Payer,
			Extra:   map[string]any{"channelId": validated.ChannelID},
		}, nil
	case batchsettlement.PayloadTypeVoucher:
		terms, err := f.resolveTerms(ctx, parsed.ChannelConfig, requirements, VoucherModeRequirements)
		if err != nil {
			return nil, err
		}
		channelID, err := f.deriveChannelID(ctx, parsed.ChannelConfig, terms.FeePayer)
		if err != nil {
			return nil, err
		}
		if parsed.Voucher.ChannelID != channelID {
			return VerifyFailure(batchsettlement.ErrChannelIDMismatch, parsed.ChannelConfig.Payer, ""), nil
		}
		channel, err := f.validateVoucherOnly(ctx, parsed, requirements, terms, channelID)
		if err != nil {
			return nil, err
		}
		return &x402.VerifyResponse{
			IsValid: true,
			Payer:   parsed.ChannelConfig.Payer,
			Extra:   VerifiedChannelExtra(channelID, channel),
		}, nil
	case batchsettlement.PayloadTypeAuthorization:
		terms, err := f.resolveTerms(ctx, parsed.ChannelConfig, requirements, VoucherModeRequirements)
		if err != nil {
			return nil, err
		}
		channelID, err := f.deriveChannelID(ctx, parsed.ChannelConfig, terms.FeePayer)
		if err != nil {
			return nil, err
		}
		if err := f.assertServerModeProof(parsed, channelID, requirements, ProofAmountExact); err != nil {
			return nil, err
		}
		channel, err := f.fetchChannel(ctx, requirements.Network, channelID)
		if err != nil {
			return nil, err
		}
		if err := AssertNotClosing(channel, channelID); err != nil {
			return nil, err
		}
		if err := f.assertClaimChannel(channel, parsed.ChannelConfig, terms, requirements, []generated.ChannelStatus{generated.ChannelStatus_Open}); err != nil {
			return nil, err
		}
		ceiling, err := paymentchannels.ParseU64(requirements.Amount, "amount")
		if err != nil {
			return nil, err
		}
		if ceiling > channel.Deposit {
			return nil, fmt.Errorf("%s", batchsettlement.ErrCumulativeExceedsDeposit)
		}
		return &x402.VerifyResponse{
			IsValid: true,
			Payer:   parsed.ChannelConfig.Payer,
			Extra:   VerifiedChannelExtra(channelID, channel),
		}, nil
	case batchsettlement.PayloadTypeRefund:
		if _, ok := record["amount"]; ok {
			return nil, fmt.Errorf("%s: refund returns the full unused escrow", batchsettlement.ErrCloseAmountUnsupported)
		}
		response, err := f.verifyRefund(ctx, parsed, requirements)
		if err != nil {
			return nil, err
		}
		return response, nil
	default:
		return nil, fmt.Errorf("%s", batchsettlement.ErrPayloadType)
	}
}

func (f *BatchSvmScheme) settleParsed(ctx context.Context, record map[string]any, requirements types.PaymentRequirements, facilitatorContext any) (*x402.SettleResponse, error) {
	payloadType, _ := record["type"].(string)
	if payloadType == batchsettlement.PayloadTypeRefund {
		if _, ok := record["amount"]; ok {
			return nil, fmt.Errorf("%s: refund returns the full unused escrow", batchsettlement.ErrCloseAmountUnsupported)
		}
	}
	needsParsed := payloadType == batchsettlement.PayloadTypeDeposit ||
		payloadType == batchsettlement.PayloadTypeVoucher ||
		payloadType == batchsettlement.PayloadTypeAuthorization ||
		payloadType == batchsettlement.PayloadTypeRefund
	var parsed batchsettlement.ParsedBatchPayload
	if needsParsed {
		var err error
		parsed, err = batchsettlement.ParseBatchPayload(record)
		if err != nil {
			return nil, err
		}
	}

	switch payloadType {
	case batchsettlement.PayloadTypeDeposit:
		return f.settleDeposit(ctx, parsed, requirements, facilitatorContext)
	case batchsettlement.PayloadTypeVoucher, batchsettlement.PayloadTypeAuthorization:
		return SettleFailure(x402.Network(requirements.Network), batchsettlement.ErrPayloadType, parsed.ChannelConfig.Payer, ""), nil
	case batchsettlement.PayloadTypeRefund:
		refund, err := decodeAs[batchsettlement.BatchRefundPayload](record)
		if err != nil {
			return nil, err
		}
		refund.ChannelConfig = parsed.ChannelConfig
		return f.settleRefund(ctx, refund, requirements, facilitatorContext)
	case batchsettlement.PayloadTypeClaim:
		claim, err := decodeAs[batchsettlement.BatchClaimPayload](record)
		if err != nil {
			return nil, err
		}
		return f.settleClaims(ctx, claim, requirements)
	case batchsettlement.PayloadTypeSettle:
		settle, err := decodeAs[batchsettlement.BatchSettlePayload](record)
		if err != nil {
			return nil, err
		}
		return f.settleDistributions(ctx, settle, requirements)
	case batchsettlement.PayloadTypeSeal:
		seal, err := decodeAs[batchsettlement.BatchSealPayload](record)
		if err != nil {
			return nil, err
		}
		return SettleSeal(ctx, f.sealDependencies(), seal, requirements, CloseIntentSeal, facilitatorContext)
	default:
		return nil, fmt.Errorf("%s", batchsettlement.ErrPayloadType)
	}
}

func (f *BatchSvmScheme) resolveTerms(ctx context.Context, config batchsettlement.BatchChannelConfig, requirements types.PaymentRequirements, binding VoucherModeBinding) (BatchTerms, error) {
	if f.hooks.resolveTerms != nil {
		return f.hooks.resolveTerms(ctx, config, requirements, binding)
	}
	extra := requirements.Extra
	if extra == nil {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrPaymentFlow)
	}
	if extraPresent(extra, batchsettlement.ExtraPaymentFlow) {
		flow, ok := extraString(extra, batchsettlement.ExtraPaymentFlow)
		if !ok || flow != "authorization" {
			return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrPaymentFlow)
		}
	}
	feePayer, ok := extraString(extra, batchsettlement.ExtraFeePayer)
	if !ok {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrFeePayerMismatch)
	}
	if err := f.resolveFeePayer(ctx, feePayer); err != nil {
		return BatchTerms{}, err
	}
	voucherSigner, err := VoucherSignerFor(config, extra, binding)
	if err != nil {
		return BatchTerms{}, err
	}
	if config.Payer == feePayer || config.PayerAuthorizer == feePayer {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrFeePayerMismatch)
	}
	withdrawDelay, ok := extraInt(extra, batchsettlement.ExtraWithdrawDelay)
	if !ok || withdrawDelay < batchsettlement.MinWithdrawDelay || withdrawDelay > batchsettlement.MaxWithdrawDelay || withdrawDelay < int64(requirements.MaxTimeoutSeconds) {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrWithdrawDelayOutOfRange)
	}
	if int64(config.WithdrawDelay) != withdrawDelay {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrWithdrawDelayMismatch)
	}
	if config.Receiver != requirements.PayTo || config.Token != requirements.Asset {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrChannelState)
	}
	receiverAuthorizer, ok := extraString(extra, batchsettlement.ExtraReceiverAuthorizer)
	if !ok || receiverAuthorizer == "" || receiverAuthorizer != config.ReceiverAuthorizer {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	tokenProgram, err := paymentchannels.RequireTokenProgramHint(extra, batchsettlement.ErrTokenProgram)
	if err != nil {
		return BatchTerms{}, err
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrTokenProgram)
	}
	account, err := f.signer.GetAccountInfo(ctx, mint, requirements.Network, &rpc.GetAccountInfoOpts{
		Encoding:   solana.EncodingBase64,
		Commitment: paymentchannels.StateCommitment,
	})
	if err != nil || account == nil || account.Value == nil || account.Value.Owner.String() != tokenProgram.String() {
		return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrTokenProgram)
	}
	terms := BatchTerms{
		FeePayer:           feePayer,
		ReceiverAuthorizer: receiverAuthorizer,
		TokenProgram:       tokenProgram.String(),
		WithdrawDelay:      int(withdrawDelay),
		VoucherSigner:      voucherSigner,
	}
	if extraPresent(extra, batchsettlement.ExtraMemo) {
		memo, ok := extraString(extra, batchsettlement.ExtraMemo)
		if !ok {
			return BatchTerms{}, fmt.Errorf("%s", batchsettlement.ErrSetupTransaction)
		}
		terms.Memo = &memo
	}
	return terms, nil
}

func (f *BatchSvmScheme) deriveChannelID(ctx context.Context, config batchsettlement.BatchChannelConfig, feePayer string) (string, error) {
	if f.hooks.deriveChannelID != nil {
		return f.hooks.deriveChannelID(ctx, config, feePayer)
	}
	payer, err := solana.PublicKeyFromBase58(config.Payer)
	if err != nil {
		return "", err
	}
	payee, err := solana.PublicKeyFromBase58(feePayer)
	if err != nil {
		return "", err
	}
	mint, err := solana.PublicKeyFromBase58(config.Token)
	if err != nil {
		return "", err
	}
	authorizer, err := solana.PublicKeyFromBase58(config.PayerAuthorizer)
	if err != nil {
		return "", err
	}
	salt, err := paymentchannels.ParseU64(config.Salt, "channelConfig.salt")
	if err != nil {
		return "", err
	}
	openSlot, err := paymentchannels.ParseU64(config.OpenSlot, "channelConfig.openSlot")
	if err != nil {
		return "", err
	}
	pda, err := paymentchannels.FindChannelPDA(payer, payee, mint, authorizer, salt, openSlot)
	if err != nil {
		return "", err
	}
	return pda.String(), nil
}

func (f *BatchSvmScheme) resolveFeePayer(ctx context.Context, feePayer string) error {
	for _, address := range f.raw.GetAddresses(ctx, "") {
		if address.String() == feePayer {
			return nil
		}
	}
	return fmt.Errorf("%s", batchsettlement.ErrFeePayerMismatch)
}

func (f *BatchSvmScheme) readChannel(ctx context.Context, network, channelID string) (*generated.Channel, error) {
	if f.hooks.readChannel != nil {
		return f.hooks.readChannel(ctx, network, channelID)
	}
	accountKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return nil, err
	}
	var minSlot *uint64
	f.mu.Lock()
	if slot, ok := f.confirmationSlots[network]; ok {
		copied := slot
		minSlot = &copied
	}
	f.mu.Unlock()
	var account *rpc.GetAccountInfoResult
	for attempt := 0; ; attempt++ {
		account, err = f.signer.GetAccountInfo(ctx, accountKey, network, &rpc.GetAccountInfoOpts{
			Encoding:       solana.EncodingBase64,
			Commitment:     paymentchannels.StateCommitment,
			MinContextSlot: minSlot,
		})
		// solana-go turns a null account into ErrNotFound. A channel that has
		// not been opened yet is absent
		if errors.Is(err, rpc.ErrNotFound) {
			return nil, nil
		}
		if err == nil {
			break
		}
		if attempt+1 >= ChannelReadAttempts || (minSlot == nil && !isTransientRPCError(err)) {
			return nil, err
		}
		if err := f.waitForChannelRead(ctx, attempt); err != nil {
			return nil, err
		}
	}
	if account == nil || account.Value == nil {
		return nil, nil
	}
	return paymentchannels.DecodeChannel(account.Value.Data.GetBinary())
}

func (f *BatchSvmScheme) fetchChannel(ctx context.Context, network, channelID string) (*generated.Channel, error) {
	if f.hooks.fetchChannel != nil {
		return f.hooks.fetchChannel(ctx, network, channelID)
	}
	channel, ok, err := f.fetchChannelUntil(ctx, network, channelID, func(ch *generated.Channel) bool {
		return ch != nil
	})
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%s: channel is not visible after confirmation", batchsettlement.ErrChannelState)
	}
	return channel, nil
}

func (f *BatchSvmScheme) fetchChannelUntil(ctx context.Context, network, channelID string, predicate func(*generated.Channel) bool) (*generated.Channel, bool, error) {
	for attempt := 0; attempt < ChannelReadAttempts; attempt++ {
		channel, err := f.readChannel(ctx, network, channelID)
		if err == nil && predicate(channel) {
			return channel, true, nil
		}
		if attempt+1 < ChannelReadAttempts {
			if err := f.waitForChannelRead(ctx, attempt); err != nil {
				return nil, false, err
			}
		}
	}
	return nil, false, nil
}

func (f *BatchSvmScheme) rememberSlot(network string, slot uint64) {
	if slot == 0 {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if slot > f.confirmationSlots[network] {
		f.confirmationSlots[network] = slot
	}
}

func (f *BatchSvmScheme) waitForChannelRead(ctx context.Context, attempt int) error {
	if f.hooks.waitForChannelRead != nil {
		return f.hooks.waitForChannelRead(attempt)
	}
	timer := time.NewTimer(ChannelReadInitialBackoff << attempt)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (f *BatchSvmScheme) observeConfirmation(ctx context.Context, signature solana.Signature, network string, opts *svm.FacilitatorConfirmOptions) error {
	if caps, ok := f.raw.(svm.FacilitatorConfirmWithOptions); ok {
		status, err := caps.ConfirmTransactionWithOptions(ctx, signature, network, opts)
		if status != nil {
			f.rememberSlot(network, status.Slot)
		}
		return err
	}
	return f.raw.ConfirmTransaction(ctx, signature, network)
}

func (f *BatchSvmScheme) broadcastDurably(
	ctx context.Context,
	key, network, payer string,
	broadcast func(func(signature, wire string) error) (string, error),
) (durableResult, error) {
	if f.hooks.broadcastDurably != nil {
		return f.hooks.broadcastDurably(ctx, key, network, payer, broadcast)
	}
	if completed, ok, err := f.pendingStore.Get(ctx, f.completedBroadcastKey(key)); err != nil {
		return durableResult{}, err
	} else if ok {
		return durableResult{OK: true, Replayed: true, Signature: completed}, nil
	}
	if recorded, ok, err := f.pendingStore.Get(ctx, key); err != nil {
		return durableResult{}, err
	} else if ok {
		return f.reconcileBroadcast(ctx, key, recorded, network, payer)
	}
	signature, err := broadcast(func(broadcastSignature, wire string) error {
		if err := f.pendingStore.Set(ctx, wireKey(network, broadcastSignature), wire); err != nil {
			return err
		}
		reserved, err := ReserveBroadcast(ctx, f.pendingStore, key, broadcastSignature)
		if err != nil {
			return err
		}
		if reserved {
			return nil
		}
		DiscardWire(ctx, f.pendingStore, network, broadcastSignature)
		existing, ok, err := f.pendingStore.Get(ctx, key)
		if err != nil {
			return err
		}
		if ok {
			return &paymentchannels.SettlementConfirmationTimeoutError{Signature: existing}
		}
		return errors.New("concurrent broadcast reservation changed")
	})
	if err != nil {
		if recorded, ok, getErr := f.pendingStore.Get(ctx, key); getErr != nil {
			return durableResult{}, getErr
		} else if ok {
			return f.reconcileBroadcast(ctx, key, recorded, network, payer)
		}
		pending, found := PendingSignatureOf(err)
		if !found {
			return durableResult{}, err
		}
		return durableResult{Response: RecordPendingOrTerminal(ctx, f.pendingStore, key, pending, payer, x402.Network(network), err)}, nil
	}
	return durableResult{OK: true, Signature: signature}, nil
}

func (f *BatchSvmScheme) reconcileBroadcast(ctx context.Context, key, signature, network, payer string) (durableResult, error) {
	if f.hooks.reconcileBroadcast != nil {
		return f.hooks.reconcileBroadcast(ctx, key, signature, network, payer)
	}
	return f.reconcileBroadcastImpl(ctx, key, signature, network, payer, true)
}

func (f *BatchSvmScheme) reconcileBroadcastImpl(ctx context.Context, key, signature, network, payer string, resend bool) (durableResult, error) {
	wire, _, _ := f.pendingStore.Get(ctx, wireKey(network, signature))
	parsed, err := solana.SignatureFromBase58(signature)
	if err != nil {
		return durableResult{}, err
	}
	if wire != "" && resend {
		if tx, decodeErr := svm.DecodeTransaction(wire); decodeErr == nil {
			_, _ = f.raw.SendTransaction(ctx, tx, network)
		}
	}
	if err := f.observeConfirmation(ctx, parsed, network, &svm.FacilitatorConfirmOptions{SearchTransactionHistory: true}); err != nil {
		var onchain *svm.TransactionOnchainFailureError
		if errors.As(err, &onchain) {
			f.forgetPending(ctx, key, signature)
			return durableResult{Response: SettleFailureWithTransaction(x402.Network(network), "transaction_failed", payer, onchain.Error(), signature)}, nil
		}
		if BroadcastExpiredWithoutLanding(ctx, f.raw, parsed, network, wire) {
			f.forgetPending(ctx, key, signature)
			DiscardWire(ctx, f.pendingStore, network, signature)
			return durableResult{Response: SettleFailureWithTransaction(
				x402.Network(network),
				"transaction_failed",
				payer,
				fmt.Sprintf("transaction %s expired before confirmation: its blockhash is no longer valid and the network has no record of it", signature),
				signature,
			)}, nil
		}
		return durableResult{Response: RecordPendingOrTerminal(ctx, f.pendingStore, key, signature, payer, x402.Network(network), err)}, nil
	}
	return durableResult{OK: true, Signature: signature}, nil
}

func (f *BatchSvmScheme) completeBroadcast(ctx context.Context, key, signature, network string) error {
	if err := f.pendingStore.Set(ctx, f.completedBroadcastKey(key), signature); err != nil {
		return err
	}
	f.forgetPending(ctx, key, signature)
	DiscardWire(ctx, f.pendingStore, network, signature)
	return nil
}

func (f *BatchSvmScheme) completeOrPending(ctx context.Context, key, signature, network, payer string) (*x402.SettleResponse, error) {
	if err := f.completeBroadcast(ctx, key, signature, network); err != nil {
		return SettlementPending(x402.Network(network), payer, signature, "operation confirmed but completion could not be persisted: "+err.Error()), nil //nolint:nilerr // the broadcast landed; persistence failure stays pending
	}
	return nil, nil
}

func (f *BatchSvmScheme) completedBroadcastKey(key string) string {
	return key + CompletedBroadcastSuffix
}

func (f *BatchSvmScheme) forgetPending(ctx context.Context, key, signature string) {
	if conditional, ok := f.pendingStore.(ConditionalPendingStore); ok {
		_, _ = conditional.DeleteIfEquals(ctx, key, signature)
		return
	}
	current, found, err := f.pendingStore.Get(ctx, key)
	if err != nil || !found || current != signature {
		return
	}
	_ = f.pendingStore.Delete(ctx, key)
}

func (f *BatchSvmScheme) submitRedemption(ctx context.Context, feePayer, network string, instructions []solana.Instruction, key, payer string) (durableResult, error) {
	if f.hooks.submitRedemption != nil {
		return f.hooks.submitRedemption(ctx, feePayer, network, instructions, key, payer)
	}
	broadcast, err := f.broadcastDurably(ctx, key, network, payer, func(onPrepared func(string, string) error) (string, error) {
		feeKey, err := solana.PublicKeyFromBase58(feePayer)
		if err != nil {
			return "", err
		}
		signature, err := paymentchannels.SubmitChannelTransactionWithSigner(ctx, f.raw, f.signer, feeKey, network, instructions, paymentchannels.SubmitSettleOptions{
			OnPrepared: onPrepared,
		})
		if err != nil {
			var simulation *paymentchannels.ChannelSimulationError
			if errors.As(err, &simulation) {
				return "", fmt.Errorf("%s: %s", batchsettlement.ErrSettlementSimulation, simulation.Unwrap().Error())
			}
			return "", err
		}
		return signature, nil
	})
	if err != nil {
		return durableResult{}, err
	}
	if !broadcast.OK {
		return broadcast, nil
	}
	return durableResult{OK: true, Replayed: broadcast.Replayed, Signature: broadcast.Signature}, nil
}

func (f *BatchSvmScheme) assertClaimChannel(channel *generated.Channel, config batchsettlement.BatchChannelConfig, terms BatchTerms, requirements types.PaymentRequirements, allowed []generated.ChannelStatus) error {
	hash, err := paymentchannels.GetChannelDistributionHash([]paymentchannels.Split{{
		Recipient: requirements.PayTo,
		BPS:       batchsettlement.FullSplitBPS,
	}})
	if err != nil {
		return fmt.Errorf("%s", batchsettlement.ErrChannelState)
	}
	salt, err := paymentchannels.ParseU64(config.Salt, "channelConfig.salt")
	if err != nil {
		return fmt.Errorf("%s", batchsettlement.ErrChannelState)
	}
	openSlot, err := paymentchannels.ParseU64(config.OpenSlot, "channelConfig.openSlot")
	if err != nil {
		return fmt.Errorf("%s", batchsettlement.ErrChannelState)
	}
	statusOK := false
	for _, status := range allowed {
		if generated.ChannelStatus(channel.Status) == status {
			statusOK = true
			break
		}
	}
	if channel.Discriminator != uint8(generated.AccountDiscriminator_Channel) ||
		!statusOK ||
		channel.Payer.String() != config.Payer ||
		channel.Payee.String() != terms.FeePayer ||
		channel.RentPayer.String() != terms.FeePayer ||
		channel.AuthorizedSigner.String() != config.PayerAuthorizer ||
		channel.Mint.String() != requirements.Asset ||
		channel.GracePeriod != uint32(terms.WithdrawDelay) ||
		channel.Salt != salt ||
		channel.OpenSlot != openSlot ||
		channel.DistributionHash != hash {
		return fmt.Errorf("%s", batchsettlement.ErrChannelState)
	}
	return nil
}

func (f *BatchSvmScheme) distributeInstruction(ctx context.Context, channelID string, channel *generated.Channel, terms BatchTerms, requirements types.PaymentRequirements) (solana.Instruction, error) {
	if f.hooks.distributeInstruction != nil {
		return f.hooks.distributeInstruction(ctx, channelID, channel, terms, requirements)
	}
	id, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return nil, err
	}
	tokenProgram, err := solana.PublicKeyFromBase58(terms.TokenProgram)
	if err != nil {
		return nil, err
	}
	return paymentchannels.BuildDistributeInstruction(paymentchannels.DistributeInstructionArgs{
		Channel:      id,
		Payer:        channel.Payer,
		Payee:        channel.Payee,
		RentPayer:    channel.RentPayer,
		Mint:         channel.Mint,
		TokenProgram: tokenProgram,
		Splits:       []paymentchannels.Split{{Recipient: requirements.PayTo, BPS: batchsettlement.FullSplitBPS}},
		Network:      requirements.Network,
	})
}

func (f *BatchSvmScheme) sealDependencies() SealDependencies {
	if f.hooks.sealDependencies != nil {
		return f.hooks.sealDependencies()
	}
	return f.defaultSealDependencies()
}

func (f *BatchSvmScheme) defaultSealDependencies() SealDependencies {
	return SealDependencies{
		PendingStore: f.pendingStore,
		ResolveTerms: f.resolveTerms,
		ReadBinding: func(ctx context.Context, network, channelID string) (ChannelBinding, error) {
			return ReadReceiverAuthorizer(ctx, f.channelStorage, f.history, network, channelID, nil)
		},
		IsDelegatedAuthorizer: func(bound string) bool { return IsDelegatedAuthorizer(f.delegated, bound) },
		ResolveDelegatedIdentity: func(ctx context.Context, settle DelegatedSettleContext) (string, error) {
			return ResolveDelegatedIdentity(ctx, f.delegated, settle)
		},
		DeriveChannelID:       f.deriveChannelID,
		FetchChannel:          f.fetchChannel,
		ReadChannel:           f.readChannel,
		AssertClaimChannel:    f.assertClaimChannel,
		DistributeInstruction: f.distributeInstruction,
		SubmitRedemption:      f.submitRedemption,
		CompleteOrPending:     f.completeOrPending,
		NowSeconds:            f.now,
		SettlementCache:       f.settlementCache,
	}
}

func (f *BatchSvmScheme) assertServerModeProof(payload batchsettlement.ParsedBatchPayload, channelID string, requirements types.PaymentRequirements, bound ProofAmountBound) error {
	return AssertServerModeProof(payload, channelID, requirements, bound, f.now())
}

type recordingSigner struct {
	paymentchannels.PaymentChannelFacilitatorSigner
	scheme *BatchSvmScheme
}

func (s *recordingSigner) ConfirmTransaction(ctx context.Context, signature solana.Signature, network string) error {
	return s.scheme.observeConfirmation(ctx, signature, network, nil)
}

type signerProgramQuerier struct {
	signer interface {
		GetProgramAccounts(context.Context, string, solana.PublicKey, *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error)
	}
	network string
}

func (q signerProgramQuerier) GetProgramAccounts(ctx context.Context, opts *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error) {
	return q.signer.GetProgramAccounts(ctx, q.network, paymentchannels.ProgramID, opts)
}

func payloadRecord(payload any) (map[string]any, bool) {
	record, ok := payload.(map[string]any)
	return record, ok
}

func decodeAs[T any](value any) (T, error) {
	var out T
	raw, err := json.Marshal(value)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, err
	}
	return out, nil
}

func wireKey(network, signature string) string {
	return "batch:transaction:" + network + ":" + signature + ":wire"
}

func extraInt(extra map[string]any, key string) (int64, bool) {
	if !extraPresent(extra, key) {
		return 0, false
	}
	parsed, err := paymentchannels.ParseU64(extra[key], key)
	if err != nil {
		return 0, false
	}
	return int64(parsed), true
}

func randomBatchMemo() (string, error) {
	var buf [16]byte
	if _, err := crand.Read(buf[:]); err != nil {
		return "", err
	}
	return "x402:batch:" + hex.EncodeToString(buf[:]), nil
}
