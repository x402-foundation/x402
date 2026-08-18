// Package facilitator implements the SVM facilitator role of the `upto`
// payment scheme: it co-signs and broadcasts the client's channel `open`, then
// settles the metered amount with the server's voucher.
package facilitator

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"strconv"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

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

// StoragePhase identifies which settlement step a storage upsert failed after.
type StoragePhase string

// StoragePhaseSettle is reported to Config.OnStorageError; channels are only
// indexed at settle, once the facilitator has committed rent to them.
const StoragePhaseSettle StoragePhase = "settle"

// Config is the optional configuration of the SVM `upto` facilitator.
type Config struct {
	// RPCURL overrides the per-network default RPC endpoint.
	RPCURL string

	// RPC is a prebuilt client used instead of building one from RPCURL, for
	// callers that need custom headers, transport, or rate limiting. It is
	// also threaded into the manager NewRentCleanupManager returns.
	RPC *rpc.Client

	// ChannelStorage indexes sponsored channels for rent cleanup. Defaults to
	// in-memory storage; inject a durable one for multi-process facilitators.
	ChannelStorage ChannelStorage

	// OnStorageError is called when a channel storage upsert fails. Payment
	// results are unaffected; only rent-cleanup indexing is. Defaults to a
	// warning log.
	OnStorageError func(err error, channelID string, phase StoragePhase)

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
	// (DefaultSettleComputeUnitLimit, 100k) assumes standard SPL Token
	// settlement with a single-recipient distribution; raise it for
	// compute-heavy Token-2022 extension mints or unusually large
	// distributions. Reclaim batches size themselves per channel and are
	// mint-independent, so they are unaffected by this cap.
	SettleComputeUnitLimit *uint32
}

// UptoSvmScheme implements the SchemeNetworkFacilitator interface for SVM
// `upto` payments.
//
// Escrow flow: a settle without `voucherSignature` whose amount equals
// `payload.maxAmount` deposits (co-signs and broadcasts `open`); a settle
// carrying a server voucher claims (`settle_and_seal` + `distribute`).
// Verify is an optional read-only preflight of the same static checks and
// never broadcasts.
//
// The fee payer holds the channel payee seat with a zero distribution share:
// it signs `settle_and_seal` as the lifecycle authority and can always seal an
// abandoned channel to recover its rent, while any nonzero settlement still
// requires the server's receiver-authorizer voucher.
type UptoSvmScheme struct {
	signer          svm.FacilitatorSvmSigner
	config          Config
	channelStorage  ChannelStorage
	settlementCache *svm.SettlementCache
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
	storage := cfg.ChannelStorage
	if storage == nil {
		storage = NewInMemoryChannelStorage()
	}
	return &UptoSvmScheme{
		signer:          signer,
		config:          cfg,
		channelStorage:  storage,
		settlementCache: svm.NewSettlementCache(),
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
func (f *UptoSvmScheme) ChannelStorage() ChannelStorage {
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
		RPCURL:                        f.config.RPCURL,
		RPC:                           f.config.RPC,
		ComputeUnitPriceMicroLamports: f.config.ComputeUnitPriceMicroLamports,
		SettleComputeUnitLimit:        f.config.SettleComputeUnitLimit,
	})
}

// rpcClient returns the injected client when there is one, otherwise builds
// one for the network. Every RPC entry point in the scheme goes through here
// so an injected client is never bypassed.
func (f *UptoSvmScheme) rpcClient(network string) (*rpc.Client, error) {
	if f.config.RPC != nil {
		return f.config.RPC, nil
	}
	return upto.NewRPCClient(network, f.config.RPCURL)
}

// GetExtra advertises a randomly selected fee payer for payment-channel opens.
// Random selection distributes load across the configured signers.
func (f *UptoSvmScheme) GetExtra(network x402.Network) map[string]interface{} {
	addresses := f.signer.GetAddresses(context.Background(), string(network))
	if len(addresses) == 0 {
		return nil
	}
	return map[string]interface{}{
		upto.ExtraFeePayer: addresses[rand.IntN(len(addresses))].String(),
	}
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
	auth, err := f.validateOpenAuthorization(ctx, payload, requirements)
	if err != nil {
		return nil, err
	}
	return &x402.VerifyResponse{IsValid: true, Payer: auth.payload.From}, nil
}

// Settle deposits (opens the channel) or claims (settle_and_seal + distribute).
//
// The settle phase is not on the wire, so the path is discriminated by the
// payload: a present `voucherSignature` key claims; otherwise an amount equal
// to the signed ceiling deposits. Anything else is a partial charge with no
// authorization and is rejected.
func (f *UptoSvmScheme) Settle(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	_ *x402.FacilitatorContext,
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

	if svm.HasUptoVoucherSignature(payload.Payload) {
		return f.settleClaim(ctx, payload, requirements, uptoPayload, actual, maxAmount)
	}
	if actual == maxAmount {
		return f.settleDeposit(ctx, payload, requirements)
	}
	return nil, x402.NewSettleError(ErrMissingVoucher, uptoPayload.From, network, "",
		"a partial settlement requires a receiver-authorizer voucher")
}

// settleDeposit validates the open authorization, simulates the whole channel
// lifecycle, then co-signs and broadcasts the open.
func (f *UptoSvmScheme) settleDeposit(
	ctx context.Context,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	auth, err := f.validateOpenAuthorization(ctx, payload, requirements)
	if err != nil {
		verifyErr := &x402.VerifyError{}
		if !errors.As(err, &verifyErr) {
			return nil, x402.NewSettleError(ErrPaymentRequirements, "", network, "", err.Error())
		}
		return nil, x402.NewSettleError(verifyErr.InvalidReason, verifyErr.Payer, network, "", verifyErr.InvalidMessage)
	}

	uptoPayload := auth.payload
	rpcClient, err := f.rpcClient(string(requirements.Network))
	if err != nil {
		return nil, x402.NewSettleError(ErrPaymentRequirements, uptoPayload.From, network, "", err.Error())
	}

	// One authorization opens one channel. An existing PDA is a replay or a
	// stranded prior open, not a rebind: a handler failure after a successful
	// deposit refunds through the zero-amount cancel settle instead.
	exists, err := channelExists(ctx, rpcClient, auth.channelID)
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
	depositKey := fmt.Sprintf("upto:deposit:%s:%s", requirements.Network, uptoPayload.ChannelId)
	if f.settlementCache.IsDuplicate(depositKey) {
		return nil, x402.NewSettleError(ErrDuplicateSettlement, uptoPayload.From, network, "",
			"a deposit settlement for this channel is already in flight")
	}

	simChannel := settlementChannel{
		ChannelID:    auth.channelID,
		Mint:         auth.mint,
		Payee:        auth.feePayer,
		Payer:        auth.from,
		RentPayer:    auth.feePayer,
		TokenProgram: auth.tokenProgram,
		Network:      string(requirements.Network),
		Splits:       auth.channelConfig.Splits,
	}
	if err := simulateOpenSettleDistribute(
		ctx, rpcClient, f.signer, auth.feePayer, uptoPayload.OpenTransaction, simChannel,
	); err != nil {
		f.settlementCache.Delete(depositKey)
		return nil, x402.NewSettleError(ErrSettlementSimulation, uptoPayload.From, network, "", err.Error())
	}

	// Indexed before broadcast, and the index must succeed before broadcast:
	// an open that reaches the chain without a durable record can never be
	// found by rent cleanup, permanently stranding the facilitator's rent.
	// Nothing has been broadcast yet, so failing here is safe for the client
	// to retry.
	if err := f.upsertChannelStorageOrFail(ctx, ChannelRecord{
		ChannelID:    uptoPayload.ChannelId,
		PayTo:        requirements.PayTo,
		TokenProgram: auth.tokenProgram.String(),
		ExpiresAt:    uptoPayload.ExpiresAt,
		Network:      string(requirements.Network),
	}); err != nil {
		f.settlementCache.Delete(depositKey)
		return nil, x402.NewSettleError(ErrChannelBroadcast, uptoPayload.From, network, "",
			fmt.Sprintf("failed to durably index the channel before broadcast: %s", err.Error()))
	}

	openSignature, err := broadcastOpen(
		ctx, f.signer, auth.feePayer, string(requirements.Network), uptoPayload.OpenTransaction,
	)
	if err != nil {
		f.settlementCache.Delete(depositKey)
		return nil, x402.NewSettleError(ErrChannelBroadcast, uptoPayload.From, network, "", err.Error())
	}

	if _, err := fetchAndVerifyOpenChannel(ctx, rpcClient, auth.channelID, expectedOpenChannel{
		AuthorizedSigner: auth.channelConfig.ReceiverAuthorizer,
		Mint:             requirements.Asset,
		Payee:            auth.channelConfig.FeePayer,
		Payer:            uptoPayload.From,
		RentPayer:        auth.channelConfig.FeePayer,
		Deposit:          auth.maxAmount,
		GracePeriod:      auth.channelConfig.WithdrawDelay,
		Splits:           auth.channelConfig.Splits,
	}); err != nil {
		f.settlementCache.Delete(depositKey)
		return nil, x402.NewSettleError(ErrChannelState, uptoPayload.From, network, openSignature, err.Error())
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: openSignature,
		Network:     x402.Network(requirements.Network),
		Amount:      strconv.FormatUint(auth.maxAmount, 10),
		Payer:       uptoPayload.From,
	}, nil
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
) (*x402.SettleResponse, error) {
	network := x402.Network(payload.Accepted.Network)

	if uptoPayload.VoucherSignature == "" {
		return nil, x402.NewSettleError(ErrMissingVoucher, uptoPayload.From, network, "",
			"voucherSignature is present but empty")
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
	voucherMessage := paymentchannels.EncodeVoucherMessage(channelID, actual, uptoPayload.ExpiresAt)
	if err := paymentchannels.VerifyVoucherSignature(
		uptoPayload.VoucherSignature, uptoPayload.AuthorizedSigner, voucherMessage,
	); err != nil {
		return nil, x402.NewSettleError(ErrVoucherSignature, uptoPayload.From, network, "", err.Error())
	}

	tokenProgram, err := upto.ResolveTokenProgram(requirements)
	if err != nil {
		return nil, x402.NewSettleError(ErrPaymentRequirements, uptoPayload.From, network, "", err.Error())
	}
	rpcClient, err := f.rpcClient(string(requirements.Network))
	if err != nil {
		return nil, x402.NewSettleError(ErrPaymentRequirements, uptoPayload.From, network, "", err.Error())
	}

	channel, err := fetchAndVerifyOpenChannel(ctx, rpcClient, channelID, expectedOpenChannel{
		AuthorizedSigner: channelConfig.ReceiverAuthorizer,
		Mint:             requirements.Asset,
		Payee:            channelConfig.FeePayer,
		Payer:            uptoPayload.From,
		RentPayer:        channelConfig.FeePayer,
		Deposit:          maxAmount,
		GracePeriod:      channelConfig.WithdrawDelay,
		Splits:           channelConfig.Splits,
	})
	if err != nil {
		return nil, x402.NewSettleError(ErrChannelState, uptoPayload.From, network, "", err.Error())
	}

	// Deduplicate only once the channel is rebound, so replays and concurrent
	// claims — including ones carrying a different valid voucher — collapse to
	// a single settle_and_seal + distribute. Failures above never insert.
	settlementKey := fmt.Sprintf("upto:%s:%s", requirements.Network, uptoPayload.ChannelId)
	if f.settlementCache.IsDuplicate(settlementKey) {
		return nil, x402.NewSettleError(ErrDuplicateSettlement, uptoPayload.From, network, "",
			"a settlement for this channel is already in flight")
	}

	signature, err := f.submitClaim(ctx, rpcClient, feePayer, channel, claimArgs{
		Network:          string(requirements.Network),
		TokenProgram:     tokenProgram,
		Actual:           actual,
		ExpiresAt:        uptoPayload.ExpiresAt,
		VoucherSignature: uptoPayload.VoucherSignature,
	})
	if err != nil {
		f.settlementCache.Delete(settlementKey)
		return nil, x402.NewSettleError(ErrTransactionFailed, uptoPayload.From, network, signature, err.Error())
	}

	// Settlement is confirmed onchain past this point, so storage bookkeeping
	// must never turn a charged payment into a failure.
	f.upsertChannelStorage(ctx, StoragePhaseSettle, ChannelRecord{
		ChannelID:    channel.ChannelID.String(),
		PayTo:        requirements.PayTo,
		TokenProgram: tokenProgram.String(),
		ExpiresAt:    uptoPayload.ExpiresAt,
		Network:      string(requirements.Network),
	})

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

func (f *UptoSvmScheme) submitClaim(
	ctx context.Context,
	rpcClient *rpc.Client,
	feePayer solana.PublicKey,
	channel *verifiedOpenChannel,
	args claimArgs,
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

	instructions, err := buildSettleAndDistribute(
		channel.settlement(args.TokenProgram, args.Network), voucher,
	)
	if err != nil {
		return "", err
	}

	return submitSettle(ctx, rpcClient, f.signer, feePayer, args.Network, instructions, submitSettleOptions{
		ComputeUnitLimit:              f.config.SettleComputeUnitLimit,
		ComputeUnitPriceMicroLamports: f.config.ComputeUnitPriceMicroLamports,
	})
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
	tokenProgram, err := upto.ResolveTokenProgram(requirements)
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
		Memo:                        upto.ParseExtraMemo(requirements.Extra[upto.ExtraMemo]),
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

	rpcClient, err := f.rpcClient(string(requirements.Network))
	if err != nil {
		return 0, err
	}
	slot, err := rpcClient.GetSlot(ctx, upto.SlotCommitment)
	if err != nil {
		return 0, fmt.Errorf("failed to fetch the current slot: %w", err)
	}
	return slot, nil
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

// upsertChannelStorage indexes a channel for rent cleanup. Storage failures are
// reported and swallowed: this is only used once a settlement is already
// confirmed onchain, so bookkeeping must never turn a charged payment into a
// failure.
func (f *UptoSvmScheme) upsertChannelStorage(ctx context.Context, phase StoragePhase, record ChannelRecord) {
	record.FirstSeenAt = time.Now()
	if err := f.channelStorage.Upsert(ctx, record); err != nil {
		if f.config.OnStorageError != nil {
			f.config.OnStorageError(err, record.ChannelID, phase)
			return
		}
		log.Printf(
			"[x402] upto svm: channel storage upsert failed after %s: channel_id=%s error=%v",
			phase, record.ChannelID, err,
		)
	}
}

// upsertChannelStorageOrFail indexes a channel and returns the storage error
// instead of swallowing it. Used only for the pre-broadcast deposit index,
// where nothing has reached the chain yet and a durable record is the only
// way rent cleanup can ever find the channel.
func (f *UptoSvmScheme) upsertChannelStorageOrFail(ctx context.Context, record ChannelRecord) error {
	record.FirstSeenAt = time.Now()
	if err := f.channelStorage.Upsert(ctx, record); err != nil {
		if f.config.OnStorageError != nil {
			f.config.OnStorageError(err, record.ChannelID, StoragePhaseSettle)
		}
		return err
	}
	return nil
}
