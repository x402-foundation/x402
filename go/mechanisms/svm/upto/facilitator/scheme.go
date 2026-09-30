// Package facilitator implements the SVM facilitator role of the `upto`
// payment scheme: it co-signs and broadcasts the client's channel `open`, then
// settles the metered amount with the server's voucher.
package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"strconv"
	"sync"
	"time"

	solana "github.com/gagliardetto/solana-go"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

// DefaultMaxChannelLifetimeSecs is the default ceiling on how long a channel
// may stay open (1 hour). Longer-lived channels lock the client's deposit and
// the facilitator's rent for longer than the scheme is designed for.
const DefaultMaxChannelLifetimeSecs = 3600

// expiresAtClockSkewSecs is the allowance for client/facilitator clock drift
// when checking the voucher deadline against the requirement's timeout.
const expiresAtClockSkewSecs = 60

// Config is the optional configuration of the SVM `upto` facilitator.
type Config struct {
	// ChannelStorage is the one channel store for every use case: the lifecycle
	// index, rent cleanup, and the delegated caller identity. Unset uses one
	// in-memory instance of this same store. Pass a durable implementation
	// when more than one process must read the row.
	ChannelStorage paymentchannels.PaymentChannelStorage

	// OnStorageError is called when reverting a failed open fails. The settle
	// error is unchanged. Defaults to a warning log.
	OnStorageError paymentchannels.OnStorageError

	// MaxChannelLifetimeSecs caps the accepted channel lifetime in seconds.
	// Unset defaults to DefaultMaxChannelLifetimeSecs.
	MaxChannelLifetimeSecs *int

	// MaxPriorityFeeMicroLamports caps the compute-unit price the facilitator
	// will pay on a client open. Clamped to the spec ceiling of 5,000,000.
	MaxPriorityFeeMicroLamports *uint64

	// MaxComputeUnits caps the compute-unit limit accepted on a client open.
	// Clamped to the spec ceiling of 400,000.
	MaxComputeUnits *uint32

	// MaxRequiredSignatures caps the signature count on a client open. Every
	// signature costs the facilitator 5,000 lamports of base fee; a canonical
	// open needs two. Unset means only the exact `{from, feePayer}` signer-set
	// rule applies.
	MaxRequiredSignatures *int

	// ComputeUnitPriceMicroLamports is the SetComputeUnitPrice (microlamports
	// per compute unit) attached to facilitator-submitted settlement
	// transactions (claim, zero-charge cancel, and rent cleanup via
	// NewRentCleanupManager). A value of 0 omits the instruction. Unset
	// defaults to svm.DefaultComputeUnitPriceMicrolamports.
	ComputeUnitPriceMicroLamports *uint64

	// SettleComputeUnitLimit is the SetComputeUnitLimit for
	// facilitator-submitted settlement transactions (claim, zero-charge
	// cancel, and rent-cleanup close/distribute). The default
	// (paymentchannels.DefaultSettleComputeUnitLimit, 100k) assumes standard SPL Token
	// settlement with a single-recipient distribution; raise it for
	// compute-heavy Token-2022 extension mints or unusually large
	// distributions. Reclaim batches size themselves per channel and are
	// mint-independent, so they are unaffected by this cap.
	SettleComputeUnitLimit *uint32

	// AuthorizerSigner enables facilitator-delegated receiver authorization.
	// Advertised as /supported extra.receiverAuthorizer and used to sign claim
	// vouchers when the server omits voucherSignature. Requires
	// ResolveCallerIdentity.
	AuthorizerSigner svm.ReceiverAuthorizerSigner

	// ResolveCallerIdentity resolves a stable caller identity for a delegated
	// settle. Returning an empty string or an error rejects the settle.
	// Required when AuthorizerSigner is set. The identity is written on the
	// channel row.
	ResolveCallerIdentity ResolveCallerIdentity

	// ChannelReadMaxAttempts caps how many times settle re-reads a channel
	// account that a confirmed open has not made visible yet. Unset defaults to
	// paymentchannels.DefaultChannelReadMaxAttempts.
	ChannelReadMaxAttempts *int

	// ChannelReadBackoffStep is the linear backoff step between those re-reads:
	// attempt N waits N * step, totalling step * (attempts-1) * attempts / 2.
	// Unset defaults to paymentchannels.DefaultChannelReadBackoffStep. Raise either field to
	// widen the budget on a provider with slower replica convergence.
	ChannelReadBackoffStep *time.Duration
}

// DelegatedSettleStep is the settle phase passed to ResolveCallerIdentity.
type DelegatedSettleStep string

const (
	DelegatedSettleStepDeposit DelegatedSettleStep = "deposit"
	DelegatedSettleStepClaim   DelegatedSettleStep = "claim"
)

// DelegatedSettleContext is passed to Config.ResolveCallerIdentity.
type DelegatedSettleContext struct {
	Ctx                context.Context
	Step               DelegatedSettleStep
	ChannelID          string
	Network            x402.Network
	Payer              string
	Amount             string
	ExpiresAt          int64
	Payload            types.PaymentPayload
	Requirements       types.PaymentRequirements
	FacilitatorContext *x402.FacilitatorContext
}

// ResolveCallerIdentity resolves a stable caller identity for a delegated settle.
type ResolveCallerIdentity func(ctx DelegatedSettleContext) (string, error)

// UptoSvmScheme implements the SchemeNetworkFacilitator interface for SVM
// `upto` payments.
//
// Escrow flow: a settle with payload.type == "deposit" (or, when type is
// absent, no voucherSignature and amount equal to payload.maxAmount) deposits
// (co-signs and broadcasts open); a settle with type == "claim" or a server
// voucher claims (settle_and_seal + distribute). Verify is an optional
// read-only preflight of the same static checks and never broadcasts.
//
// The fee payer holds the channel payee seat with a zero distribution share:
// it signs settle_and_seal as the lifecycle authority and can always seal an
// abandoned channel to recover its rent. Nonzero settlement requires a
// receiver-authorizer voucher — signed by the server, or by this facilitator
// when the server delegates and the caller identity matches the deposit-time
// binding.
type UptoSvmScheme struct {
	signer                paymentchannels.PaymentChannelFacilitatorSigner
	config                Config
	channelStorage        paymentchannels.PaymentChannelStorage
	settlementCache       *svm.SettlementCache
	pendingStore          x402.PendingSettlementStore
	authorizerSigner      svm.ReceiverAuthorizerSigner
	resolveCallerIdentity ResolveCallerIdentity
}

// NewUptoSvmScheme creates a new UptoSvmScheme. The signer supplies the fee
// payers that also act as channel rent payers and zero-share channel payees.
//
// Panics on a misconfiguration the facilitator could otherwise only discover
// mid-payment. Operators learn about an unusable limit at startup, as they do in
// the TypeScript SDK. A zero limit means unset and takes the documented default.
func NewUptoSvmScheme(signer svm.FacilitatorSvmSigner, config *Config) *UptoSvmScheme {
	if signer == nil {
		panic("upto svm facilitator: signer is required")
	}
	cfg := Config{}
	if config != nil {
		cfg = *config
	}
	if cfg.MaxChannelLifetimeSecs != nil {
		assertPositive("maxChannelLifetimeSecs", int64(*cfg.MaxChannelLifetimeSecs))
	}
	if cfg.MaxComputeUnits != nil {
		assertPositive("maxComputeUnits", int64(*cfg.MaxComputeUnits))
	}
	if cfg.MaxRequiredSignatures != nil {
		assertPositive("maxRequiredSignatures", int64(*cfg.MaxRequiredSignatures))
	}
	if cfg.SettleComputeUnitLimit != nil {
		assertPositive("settleComputeUnitLimit", int64(*cfg.SettleComputeUnitLimit))
	}
	if cfg.AuthorizerSigner != nil && cfg.ResolveCallerIdentity == nil {
		panic("upto svm facilitator: authorizerSigner requires resolveCallerIdentity")
	}
	if cfg.ChannelStorage == nil {
		cfg.ChannelStorage = paymentchannels.NewInMemoryPaymentChannelStorage()
	}
	return &UptoSvmScheme{
		signer:                paymentchannels.AssertPaymentChannelFacilitatorSigner(signer, "UptoSvmScheme"),
		config:                cfg,
		channelStorage:        cfg.ChannelStorage,
		settlementCache:       svm.NewSettlementCache(),
		pendingStore:          x402.NewInMemoryPendingSettlementStore(),
		authorizerSigner:      cfg.AuthorizerSigner,
		resolveCallerIdentity: cfg.ResolveCallerIdentity,
	}
}

// SetPendingSettlementStore overrides the default in-memory PendingSettlementStore
// used to reconcile a deposit (open) or claim (settle_and_seal + distribute)
// transaction that broadcast successfully but whose confirmation wait timed
// out (settlement_pending). A nil store is a no-op.
func (f *UptoSvmScheme) SetPendingSettlementStore(store x402.PendingSettlementStore) {
	if store != nil {
		f.pendingStore = store
	}
}

// assertPositive rejects a configured limit below 1. Unsigned config types
// already make negative priority fees unrepresentable, so only the limits that
// can hold an unusable value (zero) are checked.
func assertPositive(name string, value int64) {
	if value < 1 {
		panic(fmt.Sprintf("upto svm facilitator: %s must be >= 1, received %d", name, value))
	}
}

// Scheme returns the scheme identifier.
func (f *UptoSvmScheme) Scheme() string {
	return svm.SchemeUpto
}

// CaipFamily returns the CAIP family pattern this facilitator supports.
func (f *UptoSvmScheme) CaipFamily() string {
	return "solana:*"
}

// ChannelStorage returns the store of channels this facilitator sponsors rent
// for, so operators can share it with an external cleanup process.
func (f *UptoSvmScheme) ChannelStorage() paymentchannels.PaymentChannelStorage {
	return f.channelStorage
}

// NewRentCleanupManager creates a rent cleanup manager for one network, wired
// to this scheme's signer pool, channel storage, and RPC client. It does not
// start: call Start or schedule Cleanup yourself.
func (f *UptoSvmScheme) NewRentCleanupManager(network string) *RentCleanupManager {
	return NewRentCleanupManager(RentCleanupConfig{
		Signer:                        f.signer,
		Storage:                       f.channelStorage,
		Network:                       network,
		ComputeUnitPriceMicroLamports: f.config.ComputeUnitPriceMicroLamports,
		SettleComputeUnitLimit:        f.config.SettleComputeUnitLimit,
	})
}

// GetExtra advertises a randomly selected fee payer for payment-channel opens.
// Random selection distributes load across the configured signers.
func (f *UptoSvmScheme) GetExtra(network x402.Network) map[string]interface{} {
	addresses := f.signer.GetAddresses(context.Background(), string(network))
	if len(addresses) == 0 {
		return nil
	}
	extra := map[string]interface{}{
		upto.ExtraFeePayer: addresses[rand.IntN(len(addresses))].String(),
	}
	if f.authorizerSigner != nil {
		extra[upto.ExtraReceiverAuthorizer] = f.authorizerSigner.Address().String()
	}
	return extra
}

// GetSigners returns the fee-payer addresses managed by this facilitator.
func (f *UptoSvmScheme) GetSigners(network x402.Network) []string {
	addresses := f.signer.GetAddresses(context.Background(), string(network))
	result := make([]string, len(addresses))
	for i, address := range addresses {
		result[i] = address.String()
	}
	return result
}

// Verify runs the open-authorization checks read-only: it never broadcasts and
// never mutates chain state.
func (f *UptoSvmScheme) Verify(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	_ *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	auth, err := f.validateOpenAuthorization(ctx, payload, requirements, true)
	if err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: auth.payload.From}, nil
}

// Settle deposits (opens the channel) or claims (settle_and_seal + distribute).
//
// Prefers payload.type when present. When absent (older servers):
// a present voucherSignature key claims; otherwise an amount equal to the
// signed ceiling deposits. type is required when the settle is delegated to
// this facilitator.
func (f *UptoSvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	uptoPayload, err := svm.UptoPayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewSettleError(ErrUnsupportedPayloadType, "", network, "", err.Error())
	}
	if payload.Accepted.Scheme != svm.SchemeUpto || requirements.Scheme != svm.SchemeUpto {
		return nil, x402.NewSettleError(ErrUnsupportedScheme, uptoPayload.From, network, "",
			fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}
	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewSettleError(ErrNetworkMismatch, uptoPayload.From, network, "",
			fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}

	actual, err := strconv.ParseUint(requirements.Amount, 10, 64)
	if err != nil {
		return nil, x402.NewSettleError(ErrPayloadAmount, uptoPayload.From, network, "",
			fmt.Sprintf("requirements.amount %q is not an unsigned integer", requirements.Amount))
	}
	maxAmount, err := strconv.ParseUint(uptoPayload.MaxAmount, 10, 64)
	if err != nil {
		return nil, x402.NewSettleError(ErrPayloadAmount, uptoPayload.From, network, "",
			fmt.Sprintf("payload.maxAmount %q is not an unsigned integer", uptoPayload.MaxAmount))
	}
	if actual > maxAmount {
		return nil, x402.NewSettleError(ErrSettlementExceedsAmount, uptoPayload.From, network, "",
			fmt.Sprintf("settlement amount %d exceeds the authorized ceiling %d", actual, maxAmount))
	}

	delegated := f.isDelegatedSettle(requirements)
	if uptoPayload.Type == svm.UptoPayloadTypeDeposit {
		return f.settleDeposit(ctx, payload, requirements, fctx)
	}
	if uptoPayload.Type == svm.UptoPayloadTypeClaim {
		return f.settleClaim(ctx, payload, requirements, uptoPayload, actual, maxAmount, fctx)
	}
	if delegated {
		return nil, x402.NewSettleError(ErrPayloadType, uptoPayload.From, network, "",
			"a delegated settle requires payload.type")
	}

	if svm.HasUptoVoucherSignature(payload.Payload) {
		return f.settleClaim(ctx, payload, requirements, uptoPayload, actual, maxAmount, fctx)
	}
	if actual == maxAmount {
		return f.settleDeposit(ctx, payload, requirements, fctx)
	}
	return nil, x402.NewSettleError(ErrMissingVoucher, uptoPayload.From, network, "",
		"a partial settlement requires a receiver-authorizer voucher")
}

// uptoDepositCacheKey and uptoClaimCacheKey return the PendingSettlementStore
// key for one phase of an upto channel. Deposit and claim are scoped
// separately so a pending deposit never blocks the later claim on the same
// channel.
func uptoDepositCacheKey(network, channelId string) string {
	return fmt.Sprintf("upto:deposit:%s:%s", network, channelId)
}

func uptoClaimCacheKey(network, channelId string) string {
	return fmt.Sprintf("upto:%s:%s", network, channelId)
}

// reconcilePendingUpto checks the PendingSettlementStore for a signature
// previously recorded under cacheKey by a broadcast that couldn't confirm in
// time, shared by the deposit and claim fast paths in settleDeposit and
// settleClaim. hit is false when there is nothing to reconcile (no store
// configured or no entry), telling the caller to fall through to full
// validation; hit is true whenever a reconciliation attempt was made,
// regardless of whether it succeeded.
func (f *UptoSvmScheme) reconcilePendingUpto(
	ctx context.Context,
	cacheKey string,
	payer string,
	amountStr string,
	network x402.Network,
	networkStr string,
) (resp *x402.SettleResponse, hit bool, err error) {
	if f.pendingStore == nil {
		return nil, false, nil
	}
	sigStr, ok, _ := f.pendingStore.Get(ctx, cacheKey)
	if !ok {
		return nil, false, nil
	}
	// Remove before reconciling (rather than after) so a concurrent retry of
	// the same payload misses here instead of also reconciling: it falls
	// through to the settlementCache dedup check, which independently rejects
	// it as a duplicate.
	_ = f.pendingStore.Delete(ctx, cacheKey)
	if err := f.awaitPendingUptoSignature(ctx, cacheKey, sigStr, payer, network, networkStr); err != nil {
		return nil, true, err
	}
	return &x402.SettleResponse{
		Success:     true,
		Transaction: sigStr,
		Network:     network,
		Amount:      amountStr,
		Payer:       payer,
	}, true, nil
}

// awaitPendingUptoSignature re-awaits confirmation of a signature previously
// recorded in the PendingSettlementStore under cacheKey, without
// re-verifying, re-signing, or re-broadcasting. Re-broadcasting is not a safe
// fallback here: the deposit's channel PDA is one-shot (a second open would
// hit ErrChannelAlreadyOpen) and a claim seals the channel (a second claim
// attempt would hit a channel-no-longer-open verification failure) — either
// of which would misreport an already-successful payment as failed. Returns
// nil on confirmation (with the store entry cleared); on failure it
// re-records the pending entry and returns the settlement_pending
// x402.SettleError to surface.
func (f *UptoSvmScheme) awaitPendingUptoSignature(
	ctx context.Context,
	cacheKey string,
	sigStr string,
	payer string,
	network x402.Network,
	networkStr string,
) error {
	signature, err := solana.SignatureFromBase58(sigStr)
	if err != nil {
		// Malformed cache entry — drop it so future attempts fall through to
		// the normal broadcast path instead of getting stuck.
		_ = f.pendingStore.Delete(ctx, cacheKey)
		return x402.NewSettleError(ErrChannelBroadcast, payer, network, "", err.Error())
	}
	if err := f.signer.ConfirmTransaction(ctx, signature, networkStr); err != nil {
		return svm.RecordPendingOrTerminal(ctx, f.pendingStore, cacheKey, sigStr, payer, network, ErrTransactionFailed, err)
	}
	_ = f.pendingStore.Delete(ctx, cacheKey)
	return nil
}

// settleDeposit validates the open authorization, simulates the whole channel
// lifecycle, then co-signs and broadcasts the open.
func (f *UptoSvmScheme) settleDeposit(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	uptoPayload, parseErr := svm.UptoPayloadFromMap(payload.Payload)
	delegated := f.isDelegatedSettle(requirements)
	var depositIdentity string
	if parseErr == nil && delegated {
		depositIdentity = f.resolveDelegatedCallerIdentity(DelegatedSettleContext{
			Ctx:                ctx,
			Step:               DelegatedSettleStepDeposit,
			ChannelID:          uptoPayload.ChannelId,
			Network:            x402.Network(requirements.Network),
			Payer:              uptoPayload.From,
			Amount:             requirements.Amount,
			ExpiresAt:          uptoPayload.ExpiresAt,
			Payload:            payload,
			Requirements:       requirements,
			FacilitatorContext: fctx,
		})
		if depositIdentity == "" {
			return nil, x402.NewSettleError(ErrDelegatedSettleUnauthenticated, uptoPayload.From, network, "",
				"delegated deposit settle is unauthenticated")
		}
	}

	// Pending-settlement fast path: a prior deposit settle for this exact
	// channel broadcast the open successfully but couldn't confirm it in
	// time. Reconcile against that signature instead of re-validating and
	// re-broadcasting — a second open attempt would hit ErrChannelAlreadyOpen
	// even though the original payment is (or will be) fine.
	if parseErr == nil {
		depositKey := uptoDepositCacheKey(string(requirements.Network), uptoPayload.ChannelId)
		if resp, hit, err := f.reconcilePendingUpto(ctx, depositKey, uptoPayload.From, uptoPayload.MaxAmount, network, string(requirements.Network)); hit {
			return resp, err
		}
	}

	auth, err := f.validateOpenAuthorization(ctx, payload, requirements, false)
	if err != nil {
		verifyErr := &x402.VerifyError{}
		if !errors.As(err, &verifyErr) {
			return nil, x402.NewSettleError(ErrPaymentRequirements, "", network, "", err.Error())
		}
		return nil, x402.NewSettleError(verifyErr.InvalidReason, verifyErr.Payer, network, "", verifyErr.InvalidMessage)
	}

	uptoPayload = auth.payload
	networkStr := string(requirements.Network)

	// One authorization opens one channel. An existing PDA is a replay or a
	// stranded prior open, not a rebind: a handler failure after a successful
	// deposit refunds through the zero-amount cancel settle instead.
	channelRPC := paymentchannels.AccountFetchRPC(f.signer, networkStr)
	exists, err := paymentchannels.ChannelExists(ctx, channelRPC, auth.channelID)
	if err != nil {
		return nil, x402.NewSettleError(ErrChannelState, uptoPayload.From, network, "", err.Error())
	}
	if exists {
		return nil, x402.NewSettleError(ErrChannelAlreadyOpen, uptoPayload.From, network, "",
			fmt.Sprintf("channel %s already exists", uptoPayload.ChannelId))
	}

	// Two concurrent deposit settles can both observe a missing channel and
	// both broadcast the same open. The key is deposit-scoped so it does not
	// block the later claim on the same channel.
	depositKey := uptoDepositCacheKey(string(requirements.Network), uptoPayload.ChannelId)
	if f.settlementCache.IsDuplicate(depositKey) {
		return nil, x402.NewSettleError(ErrDuplicateSettlement, uptoPayload.From, network, "",
			"a deposit settlement for this channel is already in flight")
	}

	if err := paymentchannels.SimulateOpenSettleDistribute(
		ctx, f.signer, auth.feePayer, uptoPayload.OpenTransaction, paymentchannels.SettlementSimChannel{
			ChannelID:    auth.channelID,
			Mint:         auth.mint,
			Payee:        auth.feePayer,
			Payer:        auth.from,
			RentPayer:    auth.feePayer,
			TokenProgram: auth.tokenProgram,
			Network:      string(requirements.Network),
			Splits:       auth.channelConfig.Splits,
		},
	); err != nil {
		f.settlementCache.Delete(depositKey)
		return nil, x402.NewSettleError(ErrSettlementSimulation, uptoPayload.From, network, "", err.Error())
	}

	// Indexed before broadcast, and the index must succeed before broadcast:
	// an open that reaches the chain without a durable record can never be
	// found by rent cleanup, permanently stranding the facilitator's rent.
	// A definitive failure reverts a row this call created.
	callerIdentity := ""
	if delegated && depositIdentity != "" {
		callerIdentity = depositIdentity
	}
	openRecord := paymentchannels.PaymentChannelRecord{
		Network:        string(requirements.Network),
		ChannelID:      uptoPayload.ChannelId,
		PayTo:          requirements.PayTo,
		TokenProgram:   auth.tokenProgram.String(),
		ExpiresAt:      uptoPayload.ExpiresAt,
		LastActivityAt: time.Now(),
		CallerIdentity: callerIdentity,
	}
	pendingKept := false
	response, err := paymentchannels.WriteThenBroadcast(ctx, paymentchannels.WriteThenBroadcastArgs[*x402.SettleResponse]{
		Storage:        f.channelStorage,
		Kind:           paymentchannels.ChannelWriteOpen,
		Records:        []paymentchannels.PaymentChannelRecord{openRecord},
		OnStorageError: f.config.OnStorageError,
		Broadcast: func(reserved func()) (paymentchannels.BroadcastOutcome[*x402.SettleResponse], error) {
			openSignature, err := paymentchannels.BroadcastOpen(
				ctx, f.signer, auth.feePayer, string(requirements.Network), uptoPayload.OpenTransaction,
				paymentchannels.ChannelBroadcastHooks{},
			)
			if err != nil {
				// Confirmation was not observed after the open was broadcast.
				// The transaction may still land, so the row is kept and a
				// retry reconciles this signature.
				var confirmErr *paymentchannels.ChannelBroadcastConfirmationError
				if errors.As(err, &confirmErr) {
					reserved()
					pendingKept = true
					pending := svm.RecordPendingOrTerminal(ctx, f.pendingStore, depositKey, confirmErr.Signature, uptoPayload.From, network, ErrChannelBroadcast, err)
					return paymentchannels.BroadcastOutcome[*x402.SettleResponse]{
						Value:       nil,
						Disposition: paymentchannels.OpenBroadcastKeep,
					}, pending
				}
				f.settlementCache.Delete(depositKey)
				return paymentchannels.BroadcastOutcome[*x402.SettleResponse]{
					Value:       nil,
					Disposition: paymentchannels.OpenBroadcastRevert,
				}, x402.NewSettleError(ErrChannelBroadcast, uptoPayload.From, network, "", err.Error())
			}
			reserved()
			if _, err := paymentchannels.FetchAndVerifyOpenChannel(ctx, channelRPC, auth.channelID, paymentchannels.ExpectedOpenChannel{
				AuthorizedSigner: auth.channelConfig.ReceiverAuthorizer,
				Mint:             requirements.Asset,
				Payee:            auth.channelConfig.FeePayer,
				Payer:            uptoPayload.From,
				RentPayer:        auth.channelConfig.FeePayer,
				Deposit:          auth.maxAmount,
				GracePeriod:      auth.channelConfig.WithdrawDelay,
				Splits:           auth.channelConfig.Splits,
			}, f.resolveChannelReadPolicy()); err != nil {
				// The open landed; a postcondition mismatch must not drop the row.
				f.settlementCache.Delete(depositKey)
				return paymentchannels.BroadcastOutcome[*x402.SettleResponse]{
					Value:       nil,
					Disposition: paymentchannels.OpenBroadcastKeep,
				}, x402.NewSettleError(ErrChannelState, uptoPayload.From, network, openSignature, err.Error())
			}
			return paymentchannels.BroadcastOutcome[*x402.SettleResponse]{
				Value: &x402.SettleResponse{
					Success:     true,
					Transaction: openSignature,
					Network:     x402.Network(requirements.Network),
					Amount:      strconv.FormatUint(auth.maxAmount, 10),
					Payer:       uptoPayload.From,
				},
				Disposition: paymentchannels.OpenBroadcastKeep,
			}, nil
		},
	})
	if err != nil {
		if !pendingKept {
			f.settlementCache.Delete(depositKey)
		}
		if errors.Is(err, paymentchannels.ErrCallerIdentityConflict) {
			return nil, x402.NewSettleError(ErrDelegatedSettleUnauthenticated, uptoPayload.From, network, "", err.Error())
		}
		var settleErr *x402.SettleError
		if errors.As(err, &settleErr) {
			return nil, err
		}
		return nil, x402.NewSettleError(ErrChannelBroadcast, uptoPayload.From, network, "",
			fmt.Sprintf("failed to durably record the channel before broadcast: %s", err.Error()))
	}
	return response, nil
}

// settleClaim rebinds the open channel, verifies the voucher, and submits
// settle_and_seal + distribute for the metered amount.
func (f *UptoSvmScheme) settleClaim(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	uptoPayload *svm.UptoSvmPayload,
	actual uint64,
	maxAmount uint64,
	fctx *x402.FacilitatorContext,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	hasVoucher := uptoPayload.VoucherSignature != ""
	if !hasVoucher {
		if err := f.authenticateDelegatedClaim(ctx, payload, requirements, uptoPayload, fctx); err != nil {
			return nil, err
		}
	}

	// Pending-settlement fast path: a prior claim settle for this exact
	// channel broadcast settle_and_seal + distribute successfully but
	// couldn't confirm it in time. Reconcile against that signature instead
	// of re-verifying and re-submitting — the channel is sealed by a
	// successful settle_and_seal, so a second claim attempt would fail
	// fetchAndVerifyOpenChannel's "channel is not open" check even though the
	// original payment succeeded.
	settlementKey := uptoClaimCacheKey(string(requirements.Network), uptoPayload.ChannelId)
	if resp, hit, err := f.reconcilePendingUpto(ctx, settlementKey, uptoPayload.From, strconv.FormatUint(actual, 10), network, string(requirements.Network)); hit {
		return resp, err
	}

	channelConfig, err := upto.ResolvePaymentChannelConfig(requirements)
	if err != nil {
		return nil, x402.NewSettleError(ErrPaymentRequirements, uptoPayload.From, network, "", err.Error())
	}
	if uptoPayload.AuthorizedSigner != channelConfig.ReceiverAuthorizer {
		return nil, x402.NewSettleError(ErrReceiverAuthorizer, uptoPayload.From, network, "",
			fmt.Sprintf("payload.authorizedSigner %s != requirements receiverAuthorizer %s",
				uptoPayload.AuthorizedSigner, channelConfig.ReceiverAuthorizer))
	}

	feePayer, err := f.resolveFeePayer(ctx, channelConfig.FeePayer, string(requirements.Network))
	if err != nil {
		return nil, x402.NewSettleError(ErrFacilitatorMismatch, uptoPayload.From, network, "", err.Error())
	}

	now := time.Now().Unix()
	if now < uptoPayload.ValidAfter {
		return nil, x402.NewSettleError(ErrNotYetActive, uptoPayload.From, network, "",
			fmt.Sprintf("authorization is not active until %d", uptoPayload.ValidAfter))
	}
	if uptoPayload.ExpiresAt == 0 || now >= uptoPayload.ExpiresAt {
		return nil, x402.NewSettleError(ErrExpired, uptoPayload.From, network, "",
			fmt.Sprintf("authorization expired at %d", uptoPayload.ExpiresAt))
	}

	channelID, err := solana.PublicKeyFromBase58(uptoPayload.ChannelId)
	if err != nil {
		return nil, x402.NewSettleError(ErrChannelID, uptoPayload.From, network, "", err.Error())
	}
	voucherSignature := uptoPayload.VoucherSignature
	if hasVoucher {
		voucherMessage := paymentchannels.EncodeVoucherMessage(channelID, actual, uptoPayload.ExpiresAt)
		if err := paymentchannels.VerifyVoucherSignature(
			uptoPayload.VoucherSignature, uptoPayload.AuthorizedSigner, voucherMessage,
		); err != nil {
			return nil, x402.NewSettleError(ErrVoucherSignature, uptoPayload.From, network, "", err.Error())
		}
	}

	tokenProgram, err := paymentchannels.ResolveTokenProgram(requirements)
	if err != nil {
		return nil, x402.NewSettleError(ErrPaymentRequirements, uptoPayload.From, network, "", err.Error())
	}

	networkStr := string(requirements.Network)
	expected := paymentchannels.ExpectedOpenChannel{
		AuthorizedSigner: channelConfig.ReceiverAuthorizer,
		Mint:             requirements.Asset,
		Payee:            channelConfig.FeePayer,
		Payer:            uptoPayload.From,
		RentPayer:        channelConfig.FeePayer,
		Deposit:          maxAmount,
		GracePeriod:      channelConfig.WithdrawDelay,
		Splits:           channelConfig.Splits,
	}

	var (
		channel        *paymentchannels.VerifiedOpenChannel
		prefetchedHash solana.Hash
		channelErr     error
		blockhashErr   error
		wg             sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		channel, channelErr = paymentchannels.FetchAndVerifyOpenChannel(
			ctx, paymentchannels.AccountFetchRPC(f.signer, networkStr), channelID, expected, f.resolveChannelReadPolicy(),
		)
	}()
	go func() {
		defer wg.Done()
		prefetchedHash, _, blockhashErr = f.signer.GetLatestBlockhash(ctx, networkStr)
	}()
	wg.Wait()
	if channelErr != nil {
		return nil, x402.NewSettleError(ErrChannelState, uptoPayload.From, network, "", channelErr.Error())
	}
	if blockhashErr != nil {
		return nil, x402.NewSettleError(ErrPaymentRequirements, uptoPayload.From, network, "", blockhashErr.Error())
	}

	if !hasVoucher {
		if f.authorizerSigner == nil || channel.AuthorizedSigner.String() != f.authorizerSigner.Address().String() {
			return nil, x402.NewSettleError(ErrAuthorizerAddressMismatch, uptoPayload.From, network, "",
				"delegated claim authorizer is not this facilitator")
		}
		message := paymentchannels.EncodeVoucherMessage(channelID, actual, uptoPayload.ExpiresAt)
		signatureBytes, err := f.authorizerSigner.SignMessage(ctx, message)
		if err != nil {
			return nil, x402.NewSettleError(ErrVoucherSignature, uptoPayload.From, network, "", err.Error())
		}
		if len(signatureBytes) != 64 {
			return nil, x402.NewSettleError(ErrVoucherSignature, uptoPayload.From, network, "",
				fmt.Sprintf("voucher signature must be 64 bytes, got %d", len(signatureBytes)))
		}
		voucherSignature = solana.SignatureFromBytes(signatureBytes).String()
	}

	// Deduplicate only once the channel is rebound, so replays and concurrent
	// claims — including ones carrying a different valid voucher — collapse to
	// a single settle_and_seal + distribute. Failures above never insert.
	if f.settlementCache.IsDuplicate(settlementKey) {
		return nil, x402.NewSettleError(ErrDuplicateSettlement, uptoPayload.From, network, "",
			"a settlement for this channel is already in flight")
	}

	signature, err := f.submitClaim(ctx, feePayer, channel, claimArgs{
		Network:          networkStr,
		TokenProgram:     tokenProgram,
		Actual:           actual,
		ExpiresAt:        uptoPayload.ExpiresAt,
		VoucherSignature: voucherSignature,
	}, &prefetchedHash)
	if err != nil {
		var simErr *paymentchannels.ChannelSimulationError
		if errors.As(err, &simErr) {
			f.settlementCache.Delete(settlementKey)
			return nil, x402.NewSettleError(ErrSettlementSimulation, uptoPayload.From, network, "", simErr.Error())
		}
		// Confirmation was not observed after settle_and_seal + distribute
		// was broadcast. Leave the settlement dedup lock in place (a fresh
		// submit would double-seal) and record the signature so a retry
		// reconciles via the fast path above instead of re-verifying.
		var timeoutErr *paymentchannels.SettlementConfirmationTimeoutError
		if errors.As(err, &timeoutErr) {
			return nil, svm.RecordPendingOrTerminal(ctx, f.pendingStore, settlementKey, timeoutErr.Signature, uptoPayload.From, network, ErrTransactionFailed, err)
		}
		f.settlementCache.Delete(settlementKey)
		return nil, x402.NewSettleError(ErrTransactionFailed, uptoPayload.From, network, "", err.Error())
	}
	if f.pendingStore != nil {
		_ = f.pendingStore.Delete(ctx, settlementKey)
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: signature,
		Network:     x402.Network(requirements.Network),
		Amount:      strconv.FormatUint(actual, 10),
		Payer:       channel.Payer.String(),
	}, nil
}

// claimArgs are the settle-time facts not carried by the channel account.
type claimArgs struct {
	Network          string
	TokenProgram     solana.PublicKey
	Actual           uint64
	ExpiresAt        int64
	VoucherSignature string
}

// resolveChannelReadPolicy builds the policy from the scheme's configured overrides.
// FetchAndVerifyOpenChannel fills any unset field with the package defaults.
func (f *UptoSvmScheme) resolveChannelReadPolicy() paymentchannels.ChannelReadPolicy {
	policy := paymentchannels.ChannelReadPolicy{}
	if f.config.ChannelReadMaxAttempts != nil {
		policy.MaxAttempts = *f.config.ChannelReadMaxAttempts
	}
	if f.config.ChannelReadBackoffStep != nil {
		policy.BackoffStep = *f.config.ChannelReadBackoffStep
	}
	return policy
}

// settlementChannel are the channel facts needed to build settle+distribute.
// The authorized signer is absent because it travels with the voucher.
type settlementChannel struct {
	ChannelID    solana.PublicKey
	Mint         solana.PublicKey
	Payee        solana.PublicKey
	Payer        solana.PublicKey
	RentPayer    solana.PublicKey
	TokenProgram solana.PublicKey
	Network      string
	Splits       []paymentchannels.Split
}

// voucherArgs carry a signed voucher into settle_and_seal via the Ed25519
// precompile. A nil voucher seals the channel at zero (full refund).
type voucherArgs struct {
	AuthorizedSigner solana.PublicKey
	SignatureBase58  string
	CumulativeAmount uint64
	ExpiresAt        int64
}

// buildSettleAndDistribute builds the upto claim sequence: an optional Ed25519
// precompile carrying the voucher, settle_and_seal, and distribute. The
// precompile must immediately precede settle_and_seal because the program
// reads the voucher from the instruction at index -1.
func buildSettleAndDistribute(
	channel settlementChannel,
	voucher *voucherArgs,
) ([]solana.Instruction, error) {
	var settleVoucher *paymentchannels.SettleVoucher
	if voucher != nil {
		settleVoucher = &paymentchannels.SettleVoucher{
			AuthorizedSigner: voucher.AuthorizedSigner,
			SignatureBase58:  voucher.SignatureBase58,
			CumulativeAmount: voucher.CumulativeAmount,
			ExpiresAt:        voucher.ExpiresAt,
		}
	}
	instructions, err := paymentchannels.BuildSettleAndSealInstructions(paymentchannels.SettleAndSealBuildArgs{
		ChannelID: channel.ChannelID,
		Payee:     channel.Payee,
		Voucher:   settleVoucher,
	})
	if err != nil {
		return nil, err
	}
	distribute, err := paymentchannels.BuildDistributeInstruction(paymentchannels.DistributeInstructionArgs{
		Channel:      channel.ChannelID,
		Payer:        channel.Payer,
		Payee:        channel.Payee,
		RentPayer:    channel.RentPayer,
		Mint:         channel.Mint,
		TokenProgram: channel.TokenProgram,
		Splits:       channel.Splits,
		Network:      channel.Network,
	})
	if err != nil {
		return nil, err
	}
	return append(instructions, distribute), nil
}

func (f *UptoSvmScheme) submitClaim(
	ctx context.Context,
	feePayer solana.PublicKey,
	channel *paymentchannels.VerifiedOpenChannel,
	args claimArgs,
	prefetchedBlockhash *solana.Hash,
) (string, error) {
	// The program requires settled < cumulative_amount, so a zero charge seals
	// without a voucher. The zero-amount voucher still authenticated this
	// request above; it just cannot be carried onchain.
	var voucher *voucherArgs
	if args.Actual > 0 {
		voucher = &voucherArgs{
			AuthorizedSigner: channel.AuthorizedSigner,
			SignatureBase58:  args.VoucherSignature,
			CumulativeAmount: args.Actual,
			ExpiresAt:        args.ExpiresAt,
		}
	}

	instructions, err := buildSettleAndDistribute(settlementChannel{
		ChannelID:    channel.ChannelID,
		Mint:         channel.Mint,
		Payee:        channel.Payee,
		Payer:        channel.Payer,
		RentPayer:    channel.RentPayer,
		TokenProgram: args.TokenProgram,
		Network:      args.Network,
		Splits:       channel.Splits,
	}, voucher)
	if err != nil {
		return "", err
	}

	opts := paymentchannels.SubmitSettleOptions{
		ComputeUnitLimit:              f.config.SettleComputeUnitLimit,
		ComputeUnitPriceMicroLamports: f.config.ComputeUnitPriceMicroLamports,
	}
	if prefetchedBlockhash != nil {
		opts.LatestBlockhash = prefetchedBlockhash
	}
	return paymentchannels.SubmitChannelTransactionWithSigner(
		ctx, f.signer, f.signer, feePayer, args.Network, instructions, opts,
	)
}

// openAuthorization is the validated open-authorization context shared by
// verify and deposit settle.
type openAuthorization struct {
	payload       *svm.UptoSvmPayload
	channelConfig *upto.PaymentChannelConfig
	channelID     solana.PublicKey
	feePayer      solana.PublicKey
	from          solana.PublicKey
	mint          solana.PublicKey
	tokenProgram  solana.PublicKey
	maxAmount     uint64
}

// validateOpenAuthorization runs the static open-authorization checks shared by
// verify and deposit settle. It never broadcasts or mutates chain state, and
// returns a *x402.VerifyError carrying the scheme error code on failure.
//
// The voucher is server-owned and claim-only, so it is rejected here on key
// presence rather than on value: core's enrichment is additive, so a
// client-set key — even an empty one — would block the real voucher at claim.
func (f *UptoSvmScheme) validateOpenAuthorization(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	rejectType bool,
) (*openAuthorization, error) {
	uptoPayload, err := svm.UptoPayloadFromMap(payload.Payload)
	if err != nil {
		return nil, x402.NewVerifyError(ErrUnsupportedPayloadType, "", err.Error())
	}
	payer := uptoPayload.From

	if payload.Accepted.Scheme != svm.SchemeUpto || requirements.Scheme != svm.SchemeUpto {
		return nil, x402.NewVerifyError(ErrUnsupportedScheme, payer,
			fmt.Sprintf("invalid scheme: %s", payload.Accepted.Scheme))
	}
	if payload.Accepted.Network != requirements.Network {
		return nil, x402.NewVerifyError(ErrNetworkMismatch, payer,
			fmt.Sprintf("network mismatch: %s != %s", payload.Accepted.Network, requirements.Network))
	}
	if svm.HasUptoVoucherSignature(payload.Payload) {
		return nil, x402.NewVerifyError(ErrUnexpectedVoucher, payer,
			"voucherSignature is server-owned and only valid on a claim settlement")
	}
	if rejectType && svm.HasUptoPayloadType(payload.Payload) {
		return nil, x402.NewVerifyError(ErrPayloadType, payer,
			"type is server-owned and only valid on a settlement")
	}

	channelConfig, err := upto.ResolvePaymentChannelConfig(requirements)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPaymentRequirements, payer, err.Error())
	}
	feePayer, err := f.resolveFeePayer(ctx, channelConfig.FeePayer, string(requirements.Network))
	if err != nil {
		return nil, x402.NewVerifyError(ErrFacilitatorMismatch, payer, err.Error())
	}
	if uptoPayload.AuthorizedSigner != channelConfig.ReceiverAuthorizer {
		return nil, x402.NewVerifyError(ErrReceiverAuthorizer, payer,
			fmt.Sprintf("payload.authorizedSigner %s != requirements receiverAuthorizer %s",
				uptoPayload.AuthorizedSigner, channelConfig.ReceiverAuthorizer))
	}

	maxAmount, err := strconv.ParseUint(uptoPayload.MaxAmount, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadAmount, payer,
			fmt.Sprintf("payload.maxAmount %q is not an unsigned integer", uptoPayload.MaxAmount))
	}
	deposit, err := strconv.ParseUint(uptoPayload.Deposit, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadAmount, payer,
			fmt.Sprintf("payload.deposit %q is not an unsigned integer", uptoPayload.Deposit))
	}
	requiredAmount, err := strconv.ParseUint(requirements.Amount, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayloadAmount, payer,
			fmt.Sprintf("requirements.amount %q is not an unsigned integer", requirements.Amount))
	}
	if maxAmount != requiredAmount {
		return nil, x402.NewVerifyError(ErrAmountMismatch, payer,
			fmt.Sprintf("payload.maxAmount %d != requirements.amount %d", maxAmount, requiredAmount))
	}
	if deposit != maxAmount {
		return nil, x402.NewVerifyError(ErrDepositNotCeiling, payer,
			fmt.Sprintf("payload.deposit %d != payload.maxAmount %d", deposit, maxAmount))
	}

	openSlot, err := strconv.ParseUint(uptoPayload.OpenSlot, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelSeed, payer,
			fmt.Sprintf("payload.openSlot %q is not an unsigned integer", uptoPayload.OpenSlot))
	}
	nonce, err := strconv.ParseUint(uptoPayload.Nonce, 10, 64)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelSeed, payer,
			fmt.Sprintf("payload.nonce %q is not an unsigned integer", uptoPayload.Nonce))
	}
	recentSlot, err := f.resolveRecentSlot(ctx, requirements)
	if err != nil {
		return nil, x402.NewVerifyError(ErrChannelSeed, payer, err.Error())
	}

	if err := f.validateTimeWindow(uptoPayload, requirements, payer); err != nil {
		return nil, err
	}

	from, err := solana.PublicKeyFromBase58(uptoPayload.From)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPayerMismatch, payer, err.Error())
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPaymentRequirements, payer,
			fmt.Sprintf("requirements.asset is not a valid mint address: %s", err.Error()))
	}
	payee, err := solana.PublicKeyFromBase58(channelConfig.FeePayer)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPaymentRequirements, payer, err.Error())
	}
	receiverAuthorizer, err := solana.PublicKeyFromBase58(channelConfig.ReceiverAuthorizer)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPaymentRequirements, payer, err.Error())
	}
	tokenProgram, err := paymentchannels.ResolveTokenProgram(requirements)
	if err != nil {
		return nil, x402.NewVerifyError(ErrPaymentRequirements, payer, err.Error())
	}

	open, err := paymentchannels.VerifyOpenTransaction(uptoPayload.OpenTransaction, paymentchannels.VerifyOpenExpected{
		AuthorizedSigner:            receiverAuthorizer,
		FeePayer:                    feePayer,
		From:                        from,
		Mint:                        mint,
		TokenProgram:                tokenProgram,
		Payee:                       payee,
		MaxCap:                      maxAmount,
		WithdrawDelay:               channelConfig.WithdrawDelay,
		OpenSlot:                    openSlot,
		Recipients:                  channelConfig.Splits,
		RecentSlot:                  &recentSlot,
		Memo:                        paymentchannels.ResolveUptoSvmMemo(requirements.Extra),
		MaxComputeUnits:             f.config.MaxComputeUnits,
		MaxPriorityFeeMicroLamports: f.config.MaxPriorityFeeMicroLamports,
		MaxRequiredSignatures:       f.config.MaxRequiredSignatures,
	})
	if err != nil {
		return nil, x402.NewVerifyError(ErrOpenTransaction, payer, err.Error())
	}
	if open.ChannelID.String() != uptoPayload.ChannelId {
		return nil, x402.NewVerifyError(ErrChannelID, payer,
			fmt.Sprintf("open channel %s != payload.channelId %s", open.ChannelID, uptoPayload.ChannelId))
	}
	if open.Salt != nonce {
		return nil, x402.NewVerifyError(ErrNonce, payer,
			fmt.Sprintf("open salt %d != payload.nonce %s", open.Salt, uptoPayload.Nonce))
	}
	// Settlement builds the refund leg of distribute from payload.from, so a
	// payer mismatch with the open transaction would fail onchain later.
	if !open.Payer.Equals(from) {
		return nil, x402.NewVerifyError(ErrPayerMismatch, payer,
			fmt.Sprintf("open payer %s != payload.from %s", open.Payer, uptoPayload.From))
	}

	return &openAuthorization{
		payload:       uptoPayload,
		channelConfig: channelConfig,
		channelID:     open.ChannelID,
		feePayer:      feePayer,
		from:          from,
		mint:          mint,
		tokenProgram:  tokenProgram,
		maxAmount:     maxAmount,
	}, nil
}

// validateTimeWindow enforces the authorization window and the facilitator's
// channel-lifetime ceiling.
func (f *UptoSvmScheme) validateTimeWindow(
	uptoPayload *svm.UptoSvmPayload,
	requirements types.PaymentRequirements,
	payer string,
) error {
	now := time.Now().Unix()
	if now < uptoPayload.ValidAfter {
		return x402.NewVerifyError(ErrNotYetActive, payer,
			fmt.Sprintf("authorization is not active until %d", uptoPayload.ValidAfter))
	}
	if uptoPayload.ExpiresAt == 0 || now >= uptoPayload.ExpiresAt {
		return x402.NewVerifyError(ErrExpired, payer,
			fmt.Sprintf("authorization expired at %d", uptoPayload.ExpiresAt))
	}

	maxTimeoutSeconds := requirements.MaxTimeoutSeconds
	if maxTimeoutSeconds < 1 {
		return x402.NewVerifyError(ErrPaymentRequirements, payer,
			fmt.Sprintf("maxTimeoutSeconds must be at least 1, received %d", maxTimeoutSeconds))
	}

	maxChannelLifetimeSecs := DefaultMaxChannelLifetimeSecs
	if f.config.MaxChannelLifetimeSecs != nil {
		maxChannelLifetimeSecs = *f.config.MaxChannelLifetimeSecs
	}
	if maxTimeoutSeconds > maxChannelLifetimeSecs {
		return x402.NewVerifyError(ErrChannelLifetimeExceeded, payer,
			fmt.Sprintf("maxTimeoutSeconds %d exceeds maxChannelLifetimeSecs %d",
				maxTimeoutSeconds, maxChannelLifetimeSecs))
	}
	if uptoPayload.ExpiresAt > now+int64(maxChannelLifetimeSecs)+expiresAtClockSkewSecs {
		return x402.NewVerifyError(ErrChannelLifetimeExceeded, payer,
			fmt.Sprintf("expiresAt remaining %ds exceeds maxChannelLifetimeSecs %d",
				uptoPayload.ExpiresAt-now, maxChannelLifetimeSecs))
	}
	if uptoPayload.ExpiresAt > now+int64(maxTimeoutSeconds)+expiresAtClockSkewSecs {
		return x402.NewVerifyError(ErrExpiresAtMismatch, payer,
			fmt.Sprintf("expiresAt %d exceeds now + maxTimeoutSeconds (%d)",
				uptoPayload.ExpiresAt, now+int64(maxTimeoutSeconds)))
	}
	return nil
}

// resolveRecentSlot prefers the slot pinned in the challenge so verify and
// settle judge open-slot freshness against the same anchor the client used.
func (f *UptoSvmScheme) resolveRecentSlot(
	ctx context.Context,
	requirements types.PaymentRequirements,
) (uint64, error) {
	// A malformed hint is a broken challenge, not a missing one: silently
	// re-anchoring to the live slot would judge freshness against a window the
	// client never saw.
	if raw, present := requirements.Extra[upto.ExtraRecentSlot]; present && raw != nil {
		slot, ok := upto.ParseExtraUint64(raw)
		if !ok {
			return 0, fmt.Errorf("requirements.extra.recentSlot %v is not an unsigned integer", raw)
		}
		return slot, nil
	}

	slot, err := f.signer.GetSlot(ctx, string(requirements.Network), paymentchannels.SlotCommitment)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch the current slot: %w", err)
	}
	return slot, nil
}

// isDelegatedSettle reports whether this settle's extra.receiverAuthorizer is
// this facilitator's advertised authorizer.
func (f *UptoSvmScheme) isDelegatedSettle(requirements types.PaymentRequirements) bool {
	if f.authorizerSigner == nil || requirements.Extra == nil {
		return false
	}
	advertised, _ := requirements.Extra[upto.ExtraReceiverAuthorizer].(string)
	return advertised != "" && advertised == f.authorizerSigner.Address().String()
}

// resolveDelegatedCallerIdentity resolves a delegated settle's caller identity.
// Errors and empty/missing results are treated as unauthenticated.
func (f *UptoSvmScheme) resolveDelegatedCallerIdentity(ctx DelegatedSettleContext) string {
	if f.resolveCallerIdentity == nil {
		return ""
	}
	identity, err := f.resolveCallerIdentity(ctx)
	if err != nil || identity == "" {
		return ""
	}
	return identity
}

// authenticateDelegatedClaim authenticates a delegated claim that omitted
// voucherSignature. Runs before the pending-settlement fast path and any RPC.
func (f *UptoSvmScheme) authenticateDelegatedClaim(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	uptoPayload *svm.UptoSvmPayload,
	fctx *x402.FacilitatorContext,
) error {
	network := x402.Network(payload.Accepted.Network)
	if f.authorizerSigner == nil {
		return x402.NewSettleError(ErrAuthorizerNotConfigured, uptoPayload.From, network, "",
			"claim omitted voucherSignature and no authorizer is configured")
	}
	extraAuthorizer, _ := requirements.Extra[upto.ExtraReceiverAuthorizer].(string)
	if extraAuthorizer == "" ||
		uptoPayload.AuthorizedSigner != extraAuthorizer ||
		extraAuthorizer != f.authorizerSigner.Address().String() {
		return x402.NewSettleError(ErrAuthorizerAddressMismatch, uptoPayload.From, network, "",
			"delegated claim authorizer is not this facilitator")
	}

	identity := f.resolveDelegatedCallerIdentity(DelegatedSettleContext{
		Ctx:                ctx,
		Step:               DelegatedSettleStepClaim,
		ChannelID:          uptoPayload.ChannelId,
		Network:            x402.Network(requirements.Network),
		Payer:              uptoPayload.From,
		Amount:             requirements.Amount,
		ExpiresAt:          uptoPayload.ExpiresAt,
		Payload:            payload,
		Requirements:       requirements,
		FacilitatorContext: fctx,
	})
	if identity == "" {
		return x402.NewSettleError(ErrDelegatedSettleUnauthenticated, uptoPayload.From, network, "",
			"delegated claim settle is unauthenticated")
	}
	record, err := f.channelStorage.Get(ctx, string(requirements.Network), uptoPayload.ChannelId)
	if err != nil {
		return x402.NewSettleError(ErrDelegatedAuthStore, uptoPayload.From, network, "",
			fmt.Sprintf("failed to read delegated auth binding: %s", err.Error()))
	}
	expiresAt := int64(0)
	if record != nil {
		expiresAt = record.ExpiresAt
	}
	expired := expiresAt <= time.Now().Unix()
	if record == nil || expired || record.CallerIdentity != identity {
		return x402.NewSettleError(ErrDelegatedSettleUnauthenticated, uptoPayload.From, network, "",
			"delegated claim settle is unauthenticated")
	}
	return nil
}

func (f *UptoSvmScheme) resolveFeePayer(
	ctx context.Context,
	feePayerAddress string,
	network string,
) (solana.PublicKey, error) {
	feePayer, err := solana.PublicKeyFromBase58(feePayerAddress)
	if err != nil {
		return solana.PublicKey{}, fmt.Errorf("feePayer %q is not a valid address: %w", feePayerAddress, err)
	}
	for _, address := range f.signer.GetAddresses(ctx, network) {
		if address.Equals(feePayer) {
			return feePayer, nil
		}
	}
	return solana.PublicKey{}, fmt.Errorf("feePayer %s is not managed by this facilitator", feePayerAddress)
}
