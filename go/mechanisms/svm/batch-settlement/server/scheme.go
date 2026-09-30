package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	solana "github.com/gagliardetto/solana-go"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Config configures the server-side SVM batch-settlement scheme.
type Config struct {
	// WithdrawDelay overrides the grace period. Nil uses max(MinWithdrawDelay, maxTimeoutSeconds).
	WithdrawDelay *int
	// ReceiverAuthorizer signs close authorizations. Nil delegates closes to the facilitator.
	ReceiverAuthorizer svm.ReceiverAuthorizerSigner
	// OnChannelClosing runs when the facilitator reports a paid channel as closing.
	OnChannelClosing func(channelID string)
	Store            ChannelStore
	// OnchainStateTtlMs is how long a local onchain snapshot may back a verify fast path.
	OnchainStateTtlMs *int64
	// EnforceMinDeposit rejects deposits below the announced extra.minDeposit hint.
	EnforceMinDeposit bool
	OperationStore    BatchOperationStore
	// Operator signs cumulative vouchers after successful server-mode requests.
	Operator svm.ReceiverAuthorizerSigner
}

// BatchSvmScheme is the resource-server role for SVM batch-settlement.
// The server owns the offchain voucher watermark: hooks reserve capacity at
// verify and commit the measured charge only at after-handler settle.
type BatchSvmScheme struct {
	moneyParsers []x402.MoneyParser
	config       Config
	store        ChannelStore
	operations   BatchOperationStore

	mu       sync.Mutex
	contexts map[string]*RequestContext
	extras   map[string]map[string]any
	sequence uint64
}

// NewBatchSvmScheme creates a server scheme. A nil config uses in-memory stores.
func NewBatchSvmScheme(config *Config) *BatchSvmScheme {
	cfg := Config{}
	if config != nil {
		cfg = *config
	}
	store := cfg.Store
	if store == nil {
		store = NewMemoryChannelStore()
	}
	operations := cfg.OperationStore
	if operations == nil {
		operations = NewMemoryBatchOperationStore()
	}
	return &BatchSvmScheme{
		config:     cfg,
		store:      store,
		operations: operations,
		contexts:   map[string]*RequestContext{},
		extras:     map[string]map[string]any{},
	}
}

// Scheme returns the scheme identifier.
func (s *BatchSvmScheme) Scheme() string { return batchsettlement.Scheme }

// DefaultAssetTransferMethod returns the ATM used when extra.assetTransferMethod is absent.
func (s *BatchSvmScheme) DefaultAssetTransferMethod() string { return assetTransferMethodChannel }

// PaymentFlows returns ATM-keyed payment flow support.
func (s *BatchSvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	return map[string]x402.PaymentFlowConfig{
		assetTransferMethodChannel: {
			Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization},
			Default:   x402.PaymentFlowAuthorization,
		},
	}
}

// DynamicExtraFields returns extra keys regenerated on each PaymentRequired response.
func (s *BatchSvmScheme) DynamicExtraFields() []string {
	return []string{batchsettlement.ExtraRecentBlockhash, batchsettlement.ExtraRecentSlot}
}

// GetAssetDecimals implements AssetDecimalsProvider for dollar settlement overrides.
func (s *BatchSvmScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	found := svm.FindDefaultAsset(asset, string(network))
	if found == nil {
		return 0, false
	}
	return found.Decimals, true
}

// GetChannelStore returns the configured or default channel store.
func (s *BatchSvmScheme) GetChannelStore() ChannelStore { return s.store }

// RegisterMoneyParser registers a custom money parser tried before the default stablecoin conversion.
func (s *BatchSvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *BatchSvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice parses a price into an asset amount.
func (s *BatchSvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	if amount, ok := price.(x402.AssetAmount); ok {
		if amount.Asset == "" {
			return x402.AssetAmount{}, fmt.Errorf("asset address must be specified for AssetAmount on network %s", network)
		}
		if amount.Extra == nil {
			amount.Extra = map[string]any{}
		}
		return amount, nil
	}
	if priceMap, ok := price.(map[string]any); ok {
		if amountVal, hasAmount := priceMap["amount"]; hasAmount {
			amountStr, ok := amountVal.(string)
			if !ok {
				return x402.AssetAmount{}, errors.New("amount must be a string")
			}
			if _, hasAsset := priceMap["asset"]; !hasAsset || priceMap["asset"] == "" {
				return x402.AssetAmount{}, fmt.Errorf("asset address must be specified for AssetAmount on network %s", network)
			}
			asset, _ := priceMap["asset"].(string)
			if asset == "" {
				return x402.AssetAmount{}, fmt.Errorf("asset address must be specified for AssetAmount on network %s", network)
			}
			extra := map[string]any{}
			if extraMap, ok := priceMap["extra"].(map[string]any); ok {
				extra = extraMap
			}
			return x402.AssetAmount{Amount: amountStr, Asset: asset, Extra: extra}, nil
		}
	}
	decimalAmount, symbol, err := x402.ParseMoney(price)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	for _, parser := range s.moneyParsers {
		result, err := parser(decimalAmount, network)
		if err != nil || result == nil {
			continue
		}
		return *result, nil
	}
	return s.defaultMoneyConversion(decimalAmount, string(network), symbol)
}

// ValidateFacilitatorSupport fails startup when the facilitator cannot sponsor opens,
// or when this server delegates and the facilitator advertises no receiver authorizer.
func (s *BatchSvmScheme) ValidateFacilitatorSupport(
	network x402.Network,
	supportedKind types.SupportedKind,
	_ []string,
) error {
	feePayer, _ := supportedKind.Extra[batchsettlement.ExtraFeePayer].(string)
	if !svm.ValidateSolanaAddress(feePayer) {
		return fmt.Errorf(
			"facilitator does not advertise a valid feePayer for batch-settlement on %s; a base58 Solana address is required",
			network,
		)
	}
	if s.config.ReceiverAuthorizer != nil {
		return nil
	}
	advertised, _ := supportedKind.Extra[batchsettlement.ExtraReceiverAuthorizer].(string)
	if svm.ValidateSolanaAddress(advertised) {
		return nil
	}
	return fmt.Errorf(
		"no receiverAuthorizer is configured and the facilitator does not advertise a receiverAuthorizer on %s; configure a receiverAuthorizer or use a facilitator that advertises one",
		network,
	)
}

// EnhancePaymentRequirements folds facilitator extras into the accept.
func (s *BatchSvmScheme) EnhancePaymentRequirements(
	_ context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	_ []string,
) (types.PaymentRequirements, error) {
	withdrawDelay := batchsettlement.MinWithdrawDelay
	if requirements.MaxTimeoutSeconds > withdrawDelay {
		withdrawDelay = requirements.MaxTimeoutSeconds
	}
	if s.config.WithdrawDelay != nil {
		withdrawDelay = *s.config.WithdrawDelay
	}
	if withdrawDelay > batchsettlement.MaxWithdrawDelay {
		return requirements, errors.New(batchsettlement.ErrWithdrawDelayOutOfRange)
	}
	serverSigned, err := s.IsServerSigned(requirements)
	if err != nil {
		return requirements, err
	}
	extra := map[string]any{}
	for key, value := range requirements.Extra {
		if key == batchsettlement.ExtraOperator {
			continue
		}
		extra[key] = value
	}
	for key, value := range supportedKind.Extra {
		extra[key] = value
	}
	advertised, _ := supportedKind.Extra[batchsettlement.ExtraReceiverAuthorizer].(string)
	receiverAuthorizer := advertised
	if s.config.ReceiverAuthorizer != nil {
		receiverAuthorizer = s.config.ReceiverAuthorizer.Address().String()
	}
	if !svm.ValidateSolanaAddress(receiverAuthorizer) {
		return requirements, errors.New("payment requirements must include a valid extra.receiverAuthorizer")
	}
	minDeposit, err := s.ResolveMinDepositHint(requirements)
	if err != nil {
		return requirements, err
	}
	extra[batchsettlement.ExtraTokenProgram] = svm.GetStablecoinTokenProgram(requirements.Asset, requirements.Network)
	extra[batchsettlement.ExtraWithdrawDelay] = withdrawDelay
	extra[batchsettlement.ExtraMinDeposit] = minDeposit
	extra[batchsettlement.ExtraReceiverAuthorizer] = receiverAuthorizer
	if serverSigned {
		extra[batchsettlement.ExtraOperator] = s.config.Operator.Address().String()
		extra[batchsettlement.ExtraVoucherSigner] = batchsettlement.VoucherSignerServer
	}
	requirements.Extra = extra
	return requirements, nil
}

// IsServerSigned reports whether the operator signs vouchers for this accept.
func (s *BatchSvmScheme) IsServerSigned(requirements types.PaymentRequirements) (bool, error) {
	routeMode := ""
	if requirements.Extra != nil {
		if mode, ok := requirements.Extra[batchsettlement.ExtraVoucherSigner]; ok && mode != nil {
			text, ok := mode.(string)
			if !ok || (text != batchsettlement.VoucherSignerClient && text != batchsettlement.VoucherSignerServer) {
				return false, errors.New(`extra.voucherSigner must be "client" or "server"`)
			}
			routeMode = text
		}
	}
	if routeMode == batchsettlement.VoucherSignerServer && s.config.Operator == nil {
		return false, errors.New(`extra.voucherSigner: "server" requires an operator signer in BatchSvmServerConfig`)
	}
	return s.config.Operator != nil && routeMode != batchsettlement.VoucherSignerClient, nil
}

// ResolveMinDepositHint returns the deposit target advertised for one request.
func (s *BatchSvmScheme) ResolveMinDepositHint(requirements types.PaymentRequirements) (string, error) {
	amount, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return "", err
	}
	serverSigned, err := s.IsServerSigned(requirements)
	if err != nil {
		return "", err
	}
	var configured uint64
	var hasConfigured bool
	if requirements.Extra != nil {
		if override, ok := requirements.Extra[batchsettlement.ExtraMinDeposit].(string); ok {
			if batchsettlement.IsDigits(override) {
				configured, err = batchsettlement.PositiveAmount(override, "minDeposit")
				if err != nil {
					return "", err
				}
				hasConfigured = true
			} else {
				asset := svm.FindDefaultAsset(requirements.Asset, requirements.Network)
				if asset == nil {
					return "", fmt.Errorf(
						"extra.minDeposit money values are only supported for default assets; use an integer atomic string for %s on %s",
						requirements.Asset, requirements.Network,
					)
				}
				parsedAmount, symbol, err := x402.ParseMoney(override)
				if err != nil {
					return "", err
				}
				if symbol != "" && symbol != asset.Symbol {
					return "", fmt.Errorf("extra.minDeposit currency must match %s", asset.Symbol)
				}
				atomic, err := x402.ConvertToTokenAmount(parsedAmount, asset.Decimals)
				if err != nil {
					return "", err
				}
				configured, err = batchsettlement.PositiveAmount(atomic, "minDeposit")
				if err != nil {
					return "", err
				}
				hasConfigured = true
			}
		}
	}
	minimum := configured
	if !hasConfigured {
		multiplier := defaultServerMinDepositMultiplier
		if serverSigned {
			multiplier = defaultServerSignedMinDepositMultiplier
		}
		product, ok := batchsettlement.MulU64(amount, multiplier)
		if !ok {
			return "", errors.New("minDeposit overflow")
		}
		minimum = product
	}
	if minimum < amount {
		minimum = amount
	}
	return strconv.FormatUint(minimum, 10), nil
}

// CreateChannelManager builds the redemption worker over this scheme's channel store.
func (s *BatchSvmScheme) CreateChannelManager(
	facilitator x402.FacilitatorClient,
	requirements types.PaymentRequirements,
	options BatchChannelManagerConfig,
) (*BatchChannelManager, error) {
	if _, ok := requirements.Extra[batchsettlement.ExtraFeePayer].(string); !ok {
		return nil, errors.New(
			"createChannelManager requires requirements.extra.feePayer; pass the requirements returned by enhancePaymentRequirements for the facilitator's /supported kind",
		)
	}
	options.Store = s.store
	options.Requirements = requirements
	if s.config.ReceiverAuthorizer != nil {
		options.ReceiverAuthorizer = s.config.ReceiverAuthorizer
	}
	options.Settle = func(ctx context.Context, request RedemptionRequest, accepted types.PaymentRequirements) (*x402.SettleResponse, error) {
		payloadMap, err := batchsettlement.WireMap(request.Payload)
		if err != nil {
			return nil, err
		}
		payloadBytes, err := json.Marshal(types.PaymentPayload{
			X402Version: request.X402Version,
			Payload:     payloadMap,
			Accepted:    request.Accepted,
		})
		if err != nil {
			return nil, err
		}
		requirementsBytes, err := json.Marshal(accepted)
		if err != nil {
			return nil, err
		}
		return facilitator.Settle(ctx, payloadBytes, requirementsBytes)
	}
	return NewBatchChannelManager(options), nil
}

// BeforeVerifyHook reserves channel capacity and validates payloads before facilitator verify.
func (s *BatchSvmScheme) BeforeVerifyHook() x402.BeforeVerifyHook { return s.beforeVerify }

// AfterVerifyHook merges facilitator snapshots and creates reservations.
func (s *BatchSvmScheme) AfterVerifyHook() x402.AfterVerifyHook { return s.afterVerify }

// BeforeSettleHook commits voucher charges for steady-state requests.
func (s *BatchSvmScheme) BeforeSettleHook() x402.BeforeSettleHook { return s.beforeSettle }

// AfterSettleHook finalizes deposits and refunds after a successful facilitator settlement.
func (s *BatchSvmScheme) AfterSettleHook() x402.AfterSettleHook { return s.afterSettle }

// OnVerifyFailureHook reacts when verification reports the payer is closing the channel.
func (s *BatchSvmScheme) OnVerifyFailureHook() x402.OnVerifyFailureHook {
	return s.onVerifyFailure
}

// OnSettleFailureHook drops reservations when settlement fails after verify.
func (s *BatchSvmScheme) OnSettleFailureHook() x402.OnSettleFailureHook {
	return s.onSettleFailure
}

// OnVerifiedPaymentCanceledHook drops reservations when a verified payment is canceled.
func (s *BatchSvmScheme) OnVerifiedPaymentCanceledHook() x402.OnVerifiedPaymentCanceledHook {
	return s.onCanceled
}

// EnrichSettlementPayload attaches a close authorization, and the operator voucher in server mode.
func (s *BatchSvmScheme) EnrichSettlementPayload(ctx x402.SettleContext) (map[string]any, error) {
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchPayload(raw) {
		return nil, nil
	}
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil || parsed.Type != batchsettlement.PayloadTypeRefund {
		return nil, err
	}
	request := s.contextFor(ctx.Payload)
	if request == nil || request.PendingID == "" {
		return nil, errors.New(ChannelBusy)
	}
	feePayer, _ := ctx.Requirements.GetExtra()[batchsettlement.ExtraFeePayer].(string)
	if feePayer == "" {
		return nil, errors.New(batchsettlement.ErrFeePayerMismatch)
	}
	serverMode := voucherSigner(parsed.ChannelConfig) == batchsettlement.VoucherSignerServer
	var closeAuthorization *batchsettlement.CloseAuthorization
	var injected *batchsettlement.BatchVoucher
	_, err = s.store.Update(request.ChannelID, func(current *ChannelState) (ChannelState, error) {
		if !hasReservation(current, request.PendingID) {
			return ChannelState{}, errors.New(ChannelBusy)
		}
		cumulative := current.ChargedCumulativeAmount
		var voucher batchsettlement.BatchVoucher
		switch {
		case parsed.Voucher != nil:
			amount, err := paymentchannels.ParseU64(parsed.Voucher.MaxClaimableAmount, "maxClaimableAmount")
			if err != nil {
				return ChannelState{}, err
			}
			if amount != cumulative {
				return ChannelState{}, errors.New(batchsettlement.ErrCumulativeAmountMismatch)
			}
			voucher = *parsed.Voucher
		case !serverMode:
			return ChannelState{}, errors.New(batchsettlement.ErrVoucherSignature)
		case current.HighestVoucherSignature != "" && cumulative > 0:
			voucher = batchsettlement.BatchVoucher{
				ChannelID:          request.ChannelID,
				ExpiresAt:          current.HighestVoucherExpiresAt,
				MaxClaimableAmount: strconv.FormatUint(cumulative, 10),
				Signature:          current.HighestVoucherSignature,
			}
		case cumulative == 0:
			signed, err := s.signOperatorVoucher(ctx.Ctx, request.ChannelID, 0)
			if err != nil {
				return ChannelState{}, err
			}
			voucher = signed
		default:
			return ChannelState{}, errors.New(batchsettlement.ErrVoucherSignature)
		}
		if serverMode {
			injected = &voucher
		}
		if s.config.ReceiverAuthorizer != nil {
			signed, err := batchsettlement.SignCloseAuthorization(ctx.Ctx, s.config.ReceiverAuthorizer, batchsettlement.CloseAuthorizationBinding{
				Network:            ctx.Requirements.GetNetwork(),
				FeePayer:           feePayer,
				ChannelID:          request.ChannelID,
				MaxClaimableAmount: batchsettlement.BigU64(cumulative),
				VoucherExpiresAt:   voucher.ExpiresAt,
				ValidBefore:        time.Now().Unix() + int64(ctx.Requirements.GetMaxTimeoutSeconds()),
			})
			if err != nil {
				return ChannelState{}, err
			}
			closeAuthorization = &signed
		}
		return *current, nil
	})
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if injected != nil {
		encoded, err := batchsettlement.WireMap(injected)
		if err != nil {
			return nil, err
		}
		out["voucher"] = encoded
	}
	if closeAuthorization != nil {
		encoded, err := batchsettlement.WireMap(closeAuthorization)
		if err != nil {
			return nil, err
		}
		out["closeAuthorization"] = encoded
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// EnrichSettlementResponse attaches channel extras the facilitator response does not already carry.
func (s *BatchSvmScheme) EnrichSettlementResponse(ctx x402.SettleResultContext) (map[string]any, error) {
	extra := s.takeExtra(ctx.Payload)
	if extra == nil {
		return nil, nil
	}
	filtered := withoutExistingFields(extra, nil)
	if ctx.Result != nil {
		filtered = withoutExistingFields(extra, ctx.Result.Extra)
	}
	if len(filtered) == 0 {
		return nil, nil
	}
	return filtered, nil
}

// EnrichPaymentRequiredResponse attaches the corrective channel state after a cumulative mismatch.
func (s *BatchSvmScheme) EnrichPaymentRequiredResponse(ctx x402.PaymentRequiredContext) {
	if ctx.Error != batchsettlement.ErrCumulativeAmountMismatch || ctx.PaymentPayload == nil {
		return
	}
	raw := ctx.PaymentPayload.GetPayload()
	if !batchsettlement.IsBatchPayload(raw) {
		return
	}
	channelID, err := s.validatePayload(raw, requirementsFromView(ctx.PaymentPayload.Accepted))
	if err != nil {
		return
	}
	state, err := s.store.Get(channelID)
	if err != nil || state == nil {
		return
	}
	for i := range ctx.Requirements {
		requirement := &ctx.Requirements[i]
		if requirement.Scheme != batchsettlement.Scheme || requirement.Network != ctx.PaymentPayload.Accepted.Network {
			continue
		}
		extra := map[string]any{}
		for key, value := range requirement.Extra {
			extra[key] = value
		}
		extra[batchsettlement.ExtraChannelState] = snapshotMap(*state)
		if state.HighestVoucherSignature != "" {
			extra[batchsettlement.ExtraVoucherState] = map[string]any{
				"signedMaxClaimable": strconv.FormatUint(state.SignedMaxClaimable, 10),
				"expiresAt":          state.HighestVoucherExpiresAt,
				"signature":          state.HighestVoucherSignature,
			}
		}
		requirement.Extra = extra
		return
	}
}

func (s *BatchSvmScheme) beforeVerify(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchPayload(raw) {
		return nil, nil
	}
	requirements := requirementsFromView(ctx.Requirements)
	if err := s.prepareVerify(ctx, raw, requirements); err != nil {
		return abort(err), nil
	}
	return s.verifyFastPath(ctx, raw), nil
}

func (s *BatchSvmScheme) prepareVerify(ctx x402.VerifyContext, raw map[string]any, requirements types.PaymentRequirements) error {
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil {
		return err
	}
	channelID, err := s.validatePayload(raw, requirements)
	if err != nil {
		return err
	}
	state, err := s.store.Get(channelID)
	if err != nil {
		return err
	}
	if state != nil {
		if err := s.assertStoredConfig(state, parsed.ChannelConfig, requirements); err != nil {
			return err
		}
	}
	if parsed.Type == batchsettlement.PayloadTypeDeposit && state == nil {
		if err := s.verifyDepositOpen(parsed, requirements); err != nil {
			return err
		}
	}
	switch parsed.Type {
	case batchsettlement.PayloadTypeDeposit, batchsettlement.PayloadTypeVoucher, batchsettlement.PayloadTypeAuthorization:
		return s.trackProof(ctx, parsed, state, channelID, requirements)
	case batchsettlement.PayloadTypeRefund:
		return s.trackRefund(ctx, parsed, state, channelID)
	default:
		return nil
	}
}

func (s *BatchSvmScheme) trackProof(
	ctx x402.VerifyContext,
	parsed batchsettlement.ParsedBatchPayload,
	state *ChannelState,
	channelID string,
	requirements types.PaymentRequirements,
) error {
	proof, err := batchsettlement.ProofOf(parsed)
	if err != nil {
		return err
	}
	amount, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return err
	}
	if (parsed.Type == batchsettlement.PayloadTypeVoucher || parsed.Type == batchsettlement.PayloadTypeAuthorization) &&
		(state == nil || !isOnchainStateFresh(*state, s.config.OnchainStateTtlMs)) {
		request := &RequestContext{ChannelID: channelID, Proof: &proof, RequiresCumulativeCheck: true}
		if proof.Signer == batchsettlement.VoucherSignerServer {
			request.Ceiling = &amount
			request.RequestID = proof.Authorization.RequestID
		}
		s.putContext(ctx.Payload, request)
		return nil
	}
	charged := uint64(0)
	if state != nil {
		charged = state.ChargedCumulativeAmount
	}
	expected, ok := batchsettlement.AddU64(charged, amount)
	if !ok {
		return errors.New(batchsettlement.ErrCumulativeExceedsDeposit)
	}
	topUp := parsed.Type == batchsettlement.PayloadTypeDeposit && state != nil
	switch proof.Signer {
	case batchsettlement.VoucherSignerClient:
		submitted, err := paymentchannels.ParseU64(proof.Voucher.MaxClaimableAmount, "maxClaimableAmount")
		if err != nil {
			return err
		}
		replay := state != nil && submitted == state.ChargedCumulativeAmount && proof.Voucher.Signature == state.HighestVoucherSignature
		if replay {
			return errors.New(ChannelBusy)
		}
		if submitted != expected {
			return errors.New(batchsettlement.ErrCumulativeAmountMismatch)
		}
		s.putContext(ctx.Payload, &RequestContext{
			ChannelID:  channelID,
			Proof:      &proof,
			Cumulative: &submitted,
			Ceiling:    &amount,
			TopUp:      topUp,
		})
	case batchsettlement.VoucherSignerServer:
		s.putContext(ctx.Payload, &RequestContext{
			ChannelID: channelID,
			Proof:     &proof,
			Ceiling:   &amount,
			RequestID: proof.Authorization.RequestID,
			TopUp:     topUp,
		})
	default:
		return fmt.Errorf("unhandled batch proof signer %q", proof.Signer)
	}
	return nil
}

func (s *BatchSvmScheme) trackRefund(
	ctx x402.VerifyContext,
	parsed batchsettlement.ParsedBatchPayload,
	state *ChannelState,
	channelID string,
) error {
	if state == nil {
		return errors.New(batchsettlement.ErrChannelState)
	}
	if voucherSigner(parsed.ChannelConfig) == batchsettlement.VoucherSignerServer {
		if parsed.Voucher != nil || parsed.Authorization == nil {
			return errors.New(batchsettlement.ErrVoucherSignature)
		}
		zero := uint64(0)
		s.putContext(ctx.Payload, &RequestContext{
			ChannelID: channelID,
			Ceiling:   &zero,
			RequestID: parsed.Authorization.RequestID,
		})
		return nil
	}
	if parsed.Voucher == nil {
		return errors.New(batchsettlement.ErrVoucherSignature)
	}
	submitted, err := paymentchannels.ParseU64(parsed.Voucher.MaxClaimableAmount, "maxClaimableAmount")
	if err != nil {
		return err
	}
	if submitted != state.ChargedCumulativeAmount {
		return errors.New(batchsettlement.ErrCumulativeAmountMismatch)
	}
	s.putContext(ctx.Payload, &RequestContext{ChannelID: channelID})
	return nil
}

func (s *BatchSvmScheme) verifyFastPath(ctx x402.VerifyContext, raw map[string]any) *x402.BeforeHookResult {
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil {
		return abort(err)
	}
	if parsed.Type != batchsettlement.PayloadTypeVoucher && parsed.Type != batchsettlement.PayloadTypeAuthorization {
		return nil
	}
	request := s.contextFor(ctx.Payload)
	if request != nil && request.RequiresCumulativeCheck {
		return nil
	}
	return &x402.BeforeHookResult{
		Skip: true,
		SkipVerifyResult: &x402.VerifyResponse{
			IsValid: true,
			Payer:   parsed.ChannelConfig.Payer,
			Extra:   map[string]any{"channelId": requestChannel(request, parsed)},
		},
	}
}

func (s *BatchSvmScheme) afterVerify(ctx x402.VerifyResultContext) (*x402.AfterVerifyResult, error) {
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchPayload(raw) {
		return nil, nil
	}
	if ctx.Result != nil && !ctx.Result.IsValid {
		if ctx.Result.InvalidReason == batchsettlement.ErrChannelClosing {
			_ = s.markChannelClosing(ctx.Payload)
		}
		return nil, nil
	}
	request := s.contextFor(ctx.Payload)
	if request == nil {
		return abortAfter(fmt.Errorf("%s: missing request state", batchsettlement.ErrChannelState)), nil
	}
	requirements := requirementsFromView(ctx.Requirements)
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil {
		return abortAfter(err), nil
	}
	if err := s.absorbSnapshot(ctx, request, parsed, requirements); err != nil {
		return abortAfter(err), nil
	}
	pendingID := fmt.Sprintf("%d:%d", time.Now().UnixMilli(), s.nextSequence())
	expiresAt := time.Now().UnixMilli() + max(int64(5_000), int64(requirements.MaxTimeoutSeconds)*1_000)
	reservedOperation := false
	if request.RequestID != "" && request.Ceiling != nil {
		reserved, err := s.operations.Reserve(request.ChannelID, request.RequestID, *request.Ceiling)
		if err != nil {
			return abortAfter(err), nil
		}
		if !reserved.Created {
			return abortAfter(errors.New(ChannelBusy)), nil
		}
		reservedOperation = true
	}
	if err := s.reserveChannel(request, parsed, requirements, pendingID, expiresAt); err != nil {
		if reservedOperation {
			_ = s.operations.Release(request.ChannelID, request.RequestID)
		}
		s.deleteContext(ctx.Payload)
		return abortAfter(err), nil
	}
	request.PendingID = pendingID
	s.putContext(ctx.Payload, request)
	if parsed.Type == batchsettlement.PayloadTypeRefund {
		return &x402.AfterVerifyResult{
			SkipHandler: true,
			Response: &x402.SkipHandlerDirective{Body: map[string]any{
				"channelId": request.ChannelID,
				"message":   "Refund initiated",
			}},
		}, nil
	}
	return nil, nil
}

func (s *BatchSvmScheme) beforeSettle(ctx x402.SettleContext) (*x402.BeforeHookResult, error) {
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchPayload(raw) {
		return nil, nil
	}
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil || parsed.Type == batchsettlement.PayloadTypeRefund {
		return nil, err
	}
	request := s.contextFor(ctx.Payload)
	if request == nil || request.PendingID == "" {
		return abort(fmt.Errorf("%s: missing reservation", ChannelBusy)), nil
	}
	state, err := s.store.Get(request.ChannelID)
	if err != nil {
		return abort(err), nil
	}
	if state == nil || !hasReservation(state, request.PendingID) {
		return abort(fmt.Errorf("%s: reservation changed", ChannelBusy)), nil
	}
	if parsed.Type == batchsettlement.PayloadTypeDeposit {
		return nil, nil
	}
	requirements := requirementsFromView(ctx.Requirements)
	committed, err := s.charge(ctx.Ctx, request, parsed, requirements)
	if err != nil {
		return abort(err), nil
	}
	s.deleteContext(ctx.Payload)
	return &x402.BeforeHookResult{Skip: true, SkipResult: acceptedResponse(*committed, requirements)}, nil
}

func (s *BatchSvmScheme) afterSettle(ctx x402.SettleResultContext) error {
	if ctx.Result == nil || !ctx.Result.Success {
		return nil
	}
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchPayload(raw) {
		return nil
	}
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil {
		return err
	}
	request := s.contextFor(ctx.Payload)
	if request == nil || request.PendingID == "" {
		return nil
	}
	requirements := requirementsFromView(ctx.Requirements)
	switch parsed.Type {
	case batchsettlement.PayloadTypeDeposit:
		return s.finishDeposit(ctx, request, parsed, requirements)
	case batchsettlement.PayloadTypeRefund:
		return s.finishRefund(ctx, request)
	default:
		return nil
	}
}

func (s *BatchSvmScheme) onVerifyFailure(ctx x402.VerifyFailureContext) (*x402.VerifyFailureHookResult, error) {
	if ctx.Error != nil && strings.Contains(ctx.Error.Error(), batchsettlement.ErrChannelClosing) {
		_ = s.markChannelClosing(ctx.Payload)
	}
	return nil, nil
}

func (s *BatchSvmScheme) onSettleFailure(ctx x402.SettleFailureContext) (*x402.SettleFailureHookResult, error) {
	_ = s.clearReservation(ctx.Payload)
	return nil, nil
}

func (s *BatchSvmScheme) onCanceled(ctx x402.VerifiedPaymentCanceledContext) error {
	return s.clearReservation(ctx.Payload)
}

func (s *BatchSvmScheme) finishDeposit(
	ctx x402.SettleResultContext,
	request *RequestContext,
	parsed batchsettlement.ParsedBatchPayload,
	requirements types.PaymentRequirements,
) error {
	state, err := s.store.Get(request.ChannelID)
	if err != nil {
		return err
	}
	if state == nil || !hasReservation(state, request.PendingID) {
		return errors.New(ChannelBusy)
	}
	committed, err := s.charge(ctx.Ctx, request, parsed, requirements, func(current ChannelState) ChannelState {
		confirmed := readChannelState(ctx.Result)
		current.Deposit = confirmedDeposit(current.Deposit, confirmed)
		current.OpenSignature = ctx.Result.Transaction
		current.Settled = confirmed.totalClaimed
		current.OnchainSyncedAt = time.Now().UnixMilli()
		return current
	})
	if err != nil {
		return err
	}
	s.putExtra(ctx.Payload, settlementExtra(*committed, requirements.Amount))
	s.deleteContext(ctx.Payload)
	return nil
}

func (s *BatchSvmScheme) finishRefund(ctx x402.SettleResultContext, request *RequestContext) error {
	_, err := s.store.Update(request.ChannelID, func(current *ChannelState) (ChannelState, error) {
		if current == nil || !hasReservation(current, request.PendingID) {
			return ChannelState{}, errors.New(ChannelBusy)
		}
		snapshot := readChannelState(ctx.Result)
		next := *current
		next.Reservations = withoutReservation(current.Reservations, request.PendingID)
		next.CloseSignature = ctx.Result.Transaction
		next.OnchainSyncedAt = time.Now().UnixMilli()
		if snapshot.withdrawRequestedAt == 0 {
			if snapshot.totalClaimed > next.Settled {
				next.Settled = snapshot.totalClaimed
			}
			next.PayoutWatermark = next.Settled
			next.Status = ChannelStatusDistributed
			return next, nil
		}
		next.CloseRequestedAt = snapshot.withdrawRequestedAt
		next.Status = ChannelStatusClosing
		return next, nil
	})
	if err != nil {
		return err
	}
	s.deleteContext(ctx.Payload)
	return nil
}

func (s *BatchSvmScheme) charge(
	ctx context.Context,
	request *RequestContext,
	parsed batchsettlement.ParsedBatchPayload,
	requirements types.PaymentRequirements,
	patch ...func(ChannelState) ChannelState,
) (*ChannelState, error) {
	actual, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return nil, err
	}
	ceiling := actual
	if request.Ceiling != nil {
		ceiling = *request.Ceiling
	}
	proof := request.Proof
	if proof == nil {
		derived, err := batchsettlement.ProofOf(parsed)
		if err != nil {
			return nil, err
		}
		proof = &derived
	}
	if actual > ceiling || (proof.Signer == batchsettlement.VoucherSignerClient && actual != ceiling) {
		return nil, errors.New(batchsettlement.ErrCumulativeAmountMismatch)
	}
	updated, err := s.commitCharge(ctx, request, *proof, actual, patch...)
	return updated, err
}

func (s *BatchSvmScheme) commitCharge(
	ctx context.Context,
	request *RequestContext,
	proof batchsettlement.BatchProof,
	actual uint64,
	patch ...func(ChannelState) ChannelState,
) (*ChannelState, error) {
	var committed ChannelState
	_, err := s.store.Update(request.ChannelID, func(current *ChannelState) (ChannelState, error) {
		if current == nil || !hasReservation(current, request.PendingID) {
			return ChannelState{}, errors.New(ChannelBusy)
		}
		reservation := current.Reservations[request.PendingID]
		if actual > reservation.Ceiling {
			return ChannelState{}, errors.New(batchsettlement.ErrCumulativeAmountMismatch)
		}
		cumulative, ok := batchsettlement.AddU64(current.ChargedCumulativeAmount, actual)
		if !ok {
			return ChannelState{}, errors.New(batchsettlement.ErrCumulativeExceedsDeposit)
		}
		voucher, err := s.voucherForCharge(ctx, proof, request.ChannelID, cumulative)
		if err != nil {
			return ChannelState{}, err
		}
		if request.RequestID != "" {
			if err := s.operations.Complete(BatchOperation{
				Status:     operationCompleted,
				ChannelID:  request.ChannelID,
				RequestID:  request.RequestID,
				Ceiling:    reservation.Ceiling,
				Actual:     actual,
				Cumulative: cumulative,
			}); err != nil {
				return ChannelState{}, err
			}
		}
		next := *current
		for _, apply := range patch {
			next = apply(next)
		}
		amount, err := paymentchannels.ParseU64(voucher.MaxClaimableAmount, "maxClaimableAmount")
		if err != nil {
			return ChannelState{}, err
		}
		next.ChargedCumulativeAmount = amount
		next.SignedMaxClaimable = amount
		next.HighestVoucherExpiresAt = voucher.ExpiresAt
		next.HighestVoucherSignature = voucher.Signature
		next.Reservations = withoutReservation(current.Reservations, request.PendingID)
		committed = next
		return next, nil
	})
	if err != nil {
		return nil, err
	}
	return &committed, nil
}

func (s *BatchSvmScheme) voucherForCharge(
	ctx context.Context,
	proof batchsettlement.BatchProof,
	channelID string,
	cumulative uint64,
) (batchsettlement.BatchVoucher, error) {
	switch proof.Signer {
	case batchsettlement.VoucherSignerClient:
		if proof.Voucher == nil {
			return batchsettlement.BatchVoucher{}, errors.New(batchsettlement.ErrVoucherSignature)
		}
		return *proof.Voucher, nil
	case batchsettlement.VoucherSignerServer:
		return s.signOperatorVoucher(ctx, channelID, cumulative)
	default:
		return batchsettlement.BatchVoucher{}, fmt.Errorf("unhandled batch proof signer %q", proof.Signer)
	}
}

func (s *BatchSvmScheme) signOperatorVoucher(ctx context.Context, channelID string, cumulative uint64) (batchsettlement.BatchVoucher, error) {
	if s.config.Operator == nil {
		return batchsettlement.BatchVoucher{}, errors.New(batchsettlement.ErrVoucherSignature)
	}
	channelKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return batchsettlement.BatchVoucher{}, errors.New(batchsettlement.ErrVoucherSignature)
	}
	signature, err := paymentchannels.SignVoucher(ctx, s.config.Operator, channelKey, cumulative, batchsettlement.ClientVoucherExpiresAt)
	if err != nil {
		return batchsettlement.BatchVoucher{}, err
	}
	return batchsettlement.BatchVoucher{
		ChannelID:          channelID,
		ExpiresAt:          batchsettlement.ClientVoucherExpiresAt,
		MaxClaimableAmount: strconv.FormatUint(cumulative, 10),
		Signature:          signature,
	}, nil
}

func (s *BatchSvmScheme) validatePayload(raw map[string]any, requirements types.PaymentRequirements) (string, error) {
	extra := requirements.Extra
	if extra == nil {
		return "", errors.New(batchsettlement.ErrPaymentFlow)
	}
	if flow, ok := extra[batchsettlement.ExtraPaymentFlow]; ok && flow != nil && flow != "authorization" {
		return "", errors.New(batchsettlement.ErrPaymentFlow)
	}
	feePayer, _ := extra[batchsettlement.ExtraFeePayer].(string)
	if feePayer == "" {
		return "", errors.New(batchsettlement.ErrFeePayerMismatch)
	}
	voucherMode, _ := extra[batchsettlement.ExtraVoucherSigner].(string)
	if voucherMode == "" {
		voucherMode = batchsettlement.VoucherSignerClient
	}
	if voucherMode != batchsettlement.VoucherSignerClient && voucherMode != batchsettlement.VoucherSignerServer {
		return "", errors.New(batchsettlement.ErrChannelState)
	}
	// Mode and operator terms are checked before full wire parsing so mismatched
	// signer labels surface as channel-state errors rather than payload-type noise.
	configRecord, _ := raw["channelConfig"].(map[string]any)
	configSigner, _ := configRecord["voucherSigner"].(string)
	if configSigner == "" {
		configSigner = batchsettlement.VoucherSignerClient
	}
	if configSigner != voucherMode {
		return "", errors.New(batchsettlement.ErrChannelState)
	}
	operator, _ := extra[batchsettlement.ExtraOperator].(string)
	configuredOperator := ""
	if s.config.Operator != nil {
		configuredOperator = s.config.Operator.Address().String()
	}
	payerAuthorizer, _ := configRecord["payerAuthorizer"].(string)
	if voucherMode == batchsettlement.VoucherSignerServer &&
		(operator == "" || payerAuthorizer != operator || configuredOperator != operator) {
		return "", errors.New(batchsettlement.ErrChannelState)
	}
	if voucherMode == batchsettlement.VoucherSignerClient && operator != "" {
		return "", errors.New(batchsettlement.ErrChannelState)
	}
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil {
		return "", err
	}
	if parsed.ChannelConfig.Payer == feePayer || parsed.ChannelConfig.PayerAuthorizer == feePayer {
		return "", errors.New(batchsettlement.ErrFeePayerMismatch)
	}
	if parsed.ChannelConfig.Receiver != requirements.PayTo || parsed.ChannelConfig.Token != requirements.Asset {
		return "", errors.New(batchsettlement.ErrChannelState)
	}
	delay, ok := asRequirementInt(extra[batchsettlement.ExtraWithdrawDelay])
	if !ok || int(delay) != parsed.ChannelConfig.WithdrawDelay {
		return "", errors.New(batchsettlement.ErrWithdrawDelayMismatch)
	}
	receiverAuthorizer, _ := extra[batchsettlement.ExtraReceiverAuthorizer].(string)
	if receiverAuthorizer == "" || parsed.ChannelConfig.ReceiverAuthorizer != receiverAuthorizer {
		return "", errors.New(batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	if s.config.ReceiverAuthorizer != nil && receiverAuthorizer != s.config.ReceiverAuthorizer.Address().String() {
		return "", errors.New(batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	tokenProgram, _ := extra[batchsettlement.ExtraTokenProgram].(string)
	if tokenProgram != svm.TokenProgramAddress && tokenProgram != svm.Token2022ProgramAddress {
		return "", errors.New(batchsettlement.ErrTokenProgram)
	}
	channelID, err := deriveChannelID(parsed.ChannelConfig, feePayer)
	if err != nil {
		return "", err
	}
	proofAmount := requirements.Amount
	if parsed.Type == batchsettlement.PayloadTypeRefund && voucherMode == batchsettlement.VoucherSignerServer {
		proofAmount = "0"
	}
	if err := s.validateRequestProof(parsed, channelID, voucherMode, proofAmount); err != nil {
		return "", err
	}
	if parsed.Type == batchsettlement.PayloadTypeDeposit && s.config.EnforceMinDeposit && parsed.Deposit != nil {
		deposited, err := paymentchannels.ParseU64(parsed.Deposit.Amount, "deposit.amount")
		if err != nil {
			return "", err
		}
		hint, err := s.ResolveMinDepositHint(requirements)
		if err != nil {
			return "", err
		}
		minimum, err := paymentchannels.ParseU64(hint, "minDeposit")
		if err != nil {
			return "", err
		}
		if deposited < minimum {
			return "", errors.New(batchsettlement.ErrDepositBelowMinDeposit)
		}
	}
	return channelID, nil
}

func (s *BatchSvmScheme) validateRequestProof(parsed batchsettlement.ParsedBatchPayload, channelID, voucherMode, authorizedAmount string) error {
	if parsed.Type == batchsettlement.PayloadTypeRefund {
		if voucherMode == batchsettlement.VoucherSignerServer {
			if parsed.Voucher != nil || parsed.Authorization == nil {
				return errors.New(batchsettlement.ErrVoucherSignature)
			}
			return s.assertPayerAuthorization(*parsed.Authorization, parsed, channelID, authorizedAmount)
		}
		if parsed.Authorization != nil || parsed.Voucher == nil {
			return errors.New(batchsettlement.ErrVoucherSignature)
		}
		return s.assertSignedVoucher(*parsed.Voucher, channelID, parsed.ChannelConfig.PayerAuthorizer)
	}
	proof, err := batchsettlement.ProofOf(parsed)
	if err != nil {
		return err
	}
	if proof.Signer != voucherMode {
		return errors.New(batchsettlement.ErrVoucherSignature)
	}
	switch proof.Signer {
	case batchsettlement.VoucherSignerClient:
		return s.assertSignedVoucher(*proof.Voucher, channelID, parsed.ChannelConfig.PayerAuthorizer)
	case batchsettlement.VoucherSignerServer:
		return s.assertPayerAuthorization(*proof.Authorization, parsed, channelID, authorizedAmount)
	default:
		return fmt.Errorf("unhandled batch proof signer %q", proof.Signer)
	}
}

func (s *BatchSvmScheme) assertSignedVoucher(voucher batchsettlement.BatchVoucher, channelID, signer string) error {
	if voucher.ChannelID != channelID {
		return errors.New(batchsettlement.ErrChannelIDMismatch)
	}
	if voucher.ExpiresAt != 0 {
		return errors.New(batchsettlement.ErrVoucherExpiry)
	}
	amount, err := paymentchannels.ParseU64(voucher.MaxClaimableAmount, "maxClaimableAmount")
	if err != nil {
		return errors.New(batchsettlement.ErrVoucherSignature)
	}
	channelKey, err := solana.PublicKeyFromBase58(channelID)
	if err != nil {
		return errors.New(batchsettlement.ErrVoucherSignature)
	}
	message := paymentchannels.EncodeVoucherMessage(channelKey, amount, voucher.ExpiresAt)
	if err := paymentchannels.VerifyVoucherSignature(voucher.Signature, signer, message); err != nil {
		return errors.New(batchsettlement.ErrVoucherSignature)
	}
	return nil
}

func (s *BatchSvmScheme) assertPayerAuthorization(
	authorization batchsettlement.BatchAuthorization,
	parsed batchsettlement.ParsedBatchPayload,
	channelID, authorizedAmount string,
) error {
	if authorization.ChannelID != channelID ||
		authorization.Payer != parsed.ChannelConfig.Payer ||
		authorization.AuthorizedAmount != authorizedAmount ||
		authorization.RequestID == "" ||
		!batchsettlement.VerifyBatchAuthorization(authorization, parsed.ChannelConfig.PayerAuthorizer, time.Now().Unix()) {
		return errors.New(batchsettlement.ErrVoucherSignature)
	}
	return nil
}

func (s *BatchSvmScheme) verifyDepositOpen(parsed batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements) error {
	extra := requirements.Extra
	receiverAuthorizer, _ := extra[batchsettlement.ExtraReceiverAuthorizer].(string)
	if receiverAuthorizer == "" {
		return errors.New(batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	feePayer, err := solana.PublicKeyFromBase58(extraString(extra, batchsettlement.ExtraFeePayer))
	if err != nil {
		return fmt.Errorf("%s: %s", batchsettlement.ErrSetupTransaction, err.Error())
	}
	from, err := solana.PublicKeyFromBase58(parsed.ChannelConfig.Payer)
	if err != nil {
		return fmt.Errorf("%s: %s", batchsettlement.ErrSetupTransaction, err.Error())
	}
	signer, err := solana.PublicKeyFromBase58(parsed.ChannelConfig.PayerAuthorizer)
	if err != nil {
		return fmt.Errorf("%s: %s", batchsettlement.ErrSetupTransaction, err.Error())
	}
	mint, err := solana.PublicKeyFromBase58(requirements.Asset)
	if err != nil {
		return fmt.Errorf("%s: %s", batchsettlement.ErrSetupTransaction, err.Error())
	}
	tokenProgram, err := solana.PublicKeyFromBase58(extraString(extra, batchsettlement.ExtraTokenProgram))
	if err != nil {
		return fmt.Errorf("%s: %s", batchsettlement.ErrSetupTransaction, err.Error())
	}
	amount, err := paymentchannels.ParseU64(parsed.Deposit.Amount, "deposit.amount")
	if err != nil {
		return err
	}
	binding := batchsettlement.EncodeReceiverBindingMemo(receiverAuthorizer)
	expected := paymentchannels.VerifyOpenExpected{
		AuthorizedSigner:    signer,
		FeePayer:            feePayer,
		From:                from,
		Mint:                mint,
		TokenProgram:        tokenProgram,
		Payee:               feePayer,
		MaxCap:              amount,
		WithdrawDelay:       uint32(parsed.ChannelConfig.WithdrawDelay),
		OpenSlot:            uint64(parsed.ChannelConfig.OpenSlot),
		Recipients:          []paymentchannels.Split{{Recipient: requirements.PayTo, BPS: batchsettlement.FullSplitBPS}},
		ExpectedBindingMemo: &binding,
	}
	if memo, ok := extra[batchsettlement.ExtraMemo].(string); ok {
		expected.Memo = &memo
	}
	if _, err := paymentchannels.VerifyOpenTransaction(parsed.Deposit.Transaction, expected); err != nil {
		reason := batchsettlement.ErrSetupTransaction
		if strings.Contains(err.Error(), "receiver binding") {
			reason = batchsettlement.ErrReceiverAuthorizerMismatch
		}
		return fmt.Errorf("%s: %s", reason, err.Error())
	}
	return nil
}

func (s *BatchSvmScheme) absorbSnapshot(
	ctx x402.VerifyResultContext,
	request *RequestContext,
	parsed batchsettlement.ParsedBatchPayload,
	requirements types.PaymentRequirements,
) error {
	snapshot, ok := readVerifiedChannelState(ctx.Result)
	if request.RequiresCumulativeCheck && !ok {
		return fmt.Errorf("%s: facilitator did not return channel state", batchsettlement.ErrChannelState)
	}
	if ok && !applySnapshot(request.ChannelID, snapshot) {
		return fmt.Errorf("%s: verified channel snapshot is unusable", batchsettlement.ErrChannelState)
	}
	if ok {
		if err := s.persistSnapshot(request.ChannelID, parsed, requirements, snapshot); err != nil {
			return err
		}
	}
	if request.RequiresCumulativeCheck && request.Proof != nil && request.Proof.Signer == batchsettlement.VoucherSignerClient {
		state, err := s.store.Get(request.ChannelID)
		if err != nil {
			return err
		}
		if state == nil {
			return fmt.Errorf("%s: channel state unavailable", batchsettlement.ErrChannelState)
		}
		submitted, err := paymentchannels.ParseU64(request.Proof.Voucher.MaxClaimableAmount, "maxClaimableAmount")
		if err != nil {
			return err
		}
		amount, err := paymentchannels.ParseU64(requirements.Amount, "amount")
		if err != nil {
			return err
		}
		expected, ok := batchsettlement.AddU64(state.ChargedCumulativeAmount, amount)
		if !ok || submitted != expected {
			return fmt.Errorf("%s: voucher authorizes %d, expected %d", batchsettlement.ErrCumulativeAmountMismatch, submitted, expected)
		}
	}
	return nil
}

func (s *BatchSvmScheme) reserveChannel(
	request *RequestContext,
	parsed batchsettlement.ParsedBatchPayload,
	requirements types.PaymentRequirements,
	pendingID string,
	expiresAt int64,
) error {
	amount, err := paymentchannels.ParseU64(requirements.Amount, "amount")
	if err != nil {
		return err
	}
	_, err = s.store.Update(request.ChannelID, func(current *ChannelState) (ChannelState, error) {
		var state ChannelState
		if current != nil {
			state = *current
		} else {
			provisional, err := provisionalState(parsed, requirements, request.ChannelID)
			if err != nil {
				return ChannelState{}, err
			}
			state = provisional
		}
		if state.Status != ChannelStatusOpen {
			return ChannelState{}, errors.New(batchsettlement.ErrCloseState)
		}
		if err := s.assertStoredConfig(&state, parsed.ChannelConfig, requirements); err != nil {
			return ChannelState{}, err
		}
		reservations := liveReservations(state.Reservations, time.Now().UnixMilli())
		kind := reservationKindClient
		if parsed.Type == batchsettlement.PayloadTypeRefund {
			kind = reservationKindClose
		} else if request.RequestID != "" {
			kind = reservationKindServer
		}
		if kind != reservationKindServer && len(reservations) > 0 {
			return ChannelState{}, errors.New(ChannelBusy)
		}
		if kind == reservationKindServer {
			for _, reservation := range reservations {
				if reservation.Kind != reservationKindServer {
					return ChannelState{}, errors.New(ChannelBusy)
				}
			}
		}
		maxClaimable := state.SignedMaxClaimable
		if parsed.Type != batchsettlement.PayloadTypeRefund {
			if request.Cumulative != nil {
				maxClaimable = *request.Cumulative
			} else {
				sum, ok := batchsettlement.AddU64(state.ChargedCumulativeAmount, amount)
				if !ok {
					return ChannelState{}, errors.New(batchsettlement.ErrCumulativeExceedsDeposit)
				}
				maxClaimable = sum
			}
		}
		var reservedCeilings uint64
		for _, reservation := range reservations {
			sum, ok := batchsettlement.AddU64(reservedCeilings, reservation.Ceiling)
			if !ok {
				return ChannelState{}, errors.New(batchsettlement.ErrCumulativeExceedsDeposit)
			}
			reservedCeilings = sum
		}
		ceiling := amount
		if parsed.Type == batchsettlement.PayloadTypeRefund {
			ceiling = 0
		}
		deposit := state.Deposit
		if parsed.Type == batchsettlement.PayloadTypeDeposit && request.TopUp && parsed.Deposit != nil {
			topUp, err := paymentchannels.ParseU64(parsed.Deposit.Amount, "deposit.amount")
			if err != nil {
				return ChannelState{}, err
			}
			sum, ok := batchsettlement.AddU64(state.Deposit, topUp)
			if !ok {
				return ChannelState{}, errors.New(batchsettlement.ErrCumulativeExceedsDeposit)
			}
			deposit = sum
		}
		projected, ok := batchsettlement.AddU64(state.ChargedCumulativeAmount, reservedCeilings)
		if !ok {
			return ChannelState{}, errors.New(batchsettlement.ErrCumulativeExceedsDeposit)
		}
		projected, ok = batchsettlement.AddU64(projected, ceiling)
		if !ok || maxClaimable > deposit || projected > deposit {
			return ChannelState{}, errors.New(batchsettlement.ErrCumulativeExceedsDeposit)
		}
		if reservations == nil {
			reservations = map[string]ChannelReservation{}
		}
		reservation := ChannelReservation{Ceiling: ceiling, ExpiresAt: expiresAt, Kind: kind}
		if request.RequestID != "" {
			reservation.RequestID = request.RequestID
		}
		reservations[pendingID] = reservation
		state.Deposit = deposit
		state.Reservations = reservations
		return state, nil
	})
	return err
}

func (s *BatchSvmScheme) persistSnapshot(
	channelID string,
	parsed batchsettlement.ParsedBatchPayload,
	requirements types.PaymentRequirements,
	snapshot VerifiedChannelState,
) error {
	_, err := s.store.Update(channelID, func(current *ChannelState) (ChannelState, error) {
		var base ChannelState
		if current != nil {
			base = *current
		} else {
			recovered, err := recoveredState(parsed, requirements, channelID, snapshot)
			if err != nil {
				return ChannelState{}, err
			}
			base = recovered
		}
		if snapshot.Balance != nil && *snapshot.Balance > base.Deposit {
			base.Deposit = *snapshot.Balance
		}
		if snapshot.TotalClaimed > base.Settled {
			base.Settled = snapshot.TotalClaimed
		}
		if snapshot.TotalClaimed > base.ChargedCumulativeAmount {
			base.ChargedCumulativeAmount = snapshot.TotalClaimed
		}
		if snapshot.TotalClaimed > base.SignedMaxClaimable {
			base.SignedMaxClaimable = snapshot.TotalClaimed
		}
		base.OnchainSyncedAt = time.Now().UnixMilli()
		if snapshot.WithdrawRequestedAt != 0 {
			base.CloseRequestedAt = snapshot.WithdrawRequestedAt
			base.Status = ChannelStatusClosing
		}
		return base, nil
	})
	return err
}

func (s *BatchSvmScheme) assertStoredConfig(state *ChannelState, config batchsettlement.BatchChannelConfig, requirements types.PaymentRequirements) error {
	if !reflect.DeepEqual(state.ChannelConfig, config) {
		return errors.New(batchsettlement.ErrChannelState)
	}
	challenged, _ := requirements.Extra[batchsettlement.ExtraReceiverAuthorizer].(string)
	if state.ChannelConfig.ReceiverAuthorizer != challenged {
		return errors.New(batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	if s.config.ReceiverAuthorizer != nil && challenged != s.config.ReceiverAuthorizer.Address().String() {
		return errors.New(batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	return nil
}

func (s *BatchSvmScheme) markChannelClosing(payload x402.PaymentPayloadView) error {
	raw := payload.GetPayload()
	if !batchsettlement.IsBatchPayload(raw) {
		return nil
	}
	parsed, err := batchsettlement.ParseBatchPayload(raw)
	if err != nil || parsed.Type == batchsettlement.PayloadTypeRefund {
		return err
	}
	request := s.contextFor(payload)
	if request == nil {
		return nil
	}
	state, err := s.store.Get(request.ChannelID)
	if err != nil || state == nil || state.Status != ChannelStatusOpen {
		return err
	}
	_, err = s.store.Update(request.ChannelID, func(current *ChannelState) (ChannelState, error) {
		base := *state
		if current != nil {
			base = *current
		}
		if base.Status == ChannelStatusOpen {
			base.Status = ChannelStatusClosing
		}
		return base, nil
	})
	if err != nil {
		return err
	}
	if s.config.OnChannelClosing != nil {
		s.config.OnChannelClosing(request.ChannelID)
	}
	return nil
}

func (s *BatchSvmScheme) clearReservation(payload x402.PaymentPayloadView) error {
	request := s.contextFor(payload)
	s.deleteContext(payload)
	if request == nil || request.PendingID == "" {
		return nil
	}
	_, err := s.store.Update(request.ChannelID, func(current *ChannelState) (ChannelState, error) {
		if current == nil {
			return ChannelState{}, errors.New(batchsettlement.ErrChannelState)
		}
		if !hasReservation(current, request.PendingID) {
			return *current, nil
		}
		next := *current
		next.Reservations = withoutReservation(current.Reservations, request.PendingID)
		return next, nil
	})
	if err != nil {
		return err
	}
	if request.RequestID != "" {
		return s.operations.Release(request.ChannelID, request.RequestID)
	}
	return nil
}

func (s *BatchSvmScheme) defaultMoneyConversion(amount, network, symbol string) (x402.AssetAmount, error) {
	asset, err := svm.GetDefaultAsset(network, symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	tokenAmount, err := x402.ConvertToTokenAmount(amount, asset.Decimals)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	return x402.AssetAmount{Amount: tokenAmount, Asset: asset.Asset, Extra: map[string]any{}}, nil
}

func (s *BatchSvmScheme) putContext(payload x402.PaymentPayloadView, request *RequestContext) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.contexts[contextKey(payload)] = request
}

func (s *BatchSvmScheme) contextFor(payload x402.PaymentPayloadView) *RequestContext {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contexts[contextKey(payload)]
}

func (s *BatchSvmScheme) deleteContext(payload x402.PaymentPayloadView) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.contexts, contextKey(payload))
}

func (s *BatchSvmScheme) putExtra(payload x402.PaymentPayloadView, extra map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.extras[contextKey(payload)] = extra
}

func (s *BatchSvmScheme) takeExtra(payload x402.PaymentPayloadView) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := contextKey(payload)
	extra := s.extras[key]
	delete(s.extras, key)
	return extra
}

func (s *BatchSvmScheme) nextSequence() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sequence++
	return s.sequence
}

func extraString(extra map[string]any, field string) string {
	if extra == nil {
		return ""
	}
	text, _ := extra[field].(string)
	return text
}

func asRequirementInt(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case float64:
		if typed != float64(int64(typed)) {
			return 0, false
		}
		return int64(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func abort(err error) *x402.BeforeHookResult {
	return &x402.BeforeHookResult{Abort: true, Reason: classifyError(err), Message: errString(err)}
}

func abortAfter(err error) *x402.AfterVerifyResult {
	return &x402.AfterVerifyResult{Abort: true, Reason: classifyError(err), Message: errString(err)}
}

func classifyError(err error) string {
	message := errString(err)
	if strings.Contains(message, ChannelBusy) {
		return ChannelBusy
	}
	for _, reason := range batchsettlement.ErrorReasons() {
		if strings.Contains(message, reason) {
			return reason
		}
	}
	return "transaction_failed"
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func contextKey(payload x402.PaymentPayloadView) string {
	raw := payload.GetPayload()
	return strings.Join([]string{
		strconv.Itoa(payload.GetVersion()),
		payload.GetScheme(),
		payload.GetNetwork(),
		fmt.Sprintf("%p", raw),
	}, "\x00")
}

func requirementsFromView(view x402.PaymentRequirementsView) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            view.GetScheme(),
		Network:           view.GetNetwork(),
		Amount:            view.GetAmount(),
		Asset:             view.GetAsset(),
		PayTo:             view.GetPayTo(),
		MaxTimeoutSeconds: view.GetMaxTimeoutSeconds(),
		Extra:             view.GetExtra(),
	}
}

func voucherSigner(config batchsettlement.BatchChannelConfig) string {
	if config.VoucherSigner == "" {
		return batchsettlement.VoucherSignerClient
	}
	return config.VoucherSigner
}

func deriveChannelID(config batchsettlement.BatchChannelConfig, feePayer string) (string, error) {
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
	signer, err := solana.PublicKeyFromBase58(config.PayerAuthorizer)
	if err != nil {
		return "", err
	}
	salt, err := paymentchannels.ParseU64(config.Salt, "salt")
	if err != nil {
		return "", err
	}
	if config.OpenSlot < 0 {
		return "", errors.New(batchsettlement.ErrChannelState)
	}
	pda, err := paymentchannels.FindChannelPDA(payer, payee, mint, signer, salt, uint64(config.OpenSlot))
	if err != nil {
		return "", err
	}
	return pda.String(), nil
}

func provisionalState(parsed batchsettlement.ParsedBatchPayload, requirements types.PaymentRequirements, channelID string) (ChannelState, error) {
	if parsed.Type != batchsettlement.PayloadTypeDeposit || parsed.Deposit == nil {
		return ChannelState{}, errors.New(batchsettlement.ErrChannelState)
	}
	deposit, err := paymentchannels.ParseU64(parsed.Deposit.Amount, "deposit.amount")
	if err != nil {
		return ChannelState{}, err
	}
	salt, err := paymentchannels.ParseU64(parsed.ChannelConfig.Salt, "salt")
	if err != nil {
		return ChannelState{}, err
	}
	return ChannelState{
		ChannelConfig:      parsed.ChannelConfig,
		ChannelID:          channelID,
		Deposit:            deposit,
		FeePayer:           extraString(requirements.Extra, batchsettlement.ExtraFeePayer),
		Mint:               requirements.Asset,
		OpenSlot:           uint64(parsed.ChannelConfig.OpenSlot),
		Payer:              parsed.ChannelConfig.Payer,
		PayerAuthorizer:    parsed.ChannelConfig.PayerAuthorizer,
		Receiver:           requirements.PayTo,
		ReceiverAuthorizer: parsed.ChannelConfig.ReceiverAuthorizer,
		Salt:               salt,
		Status:             ChannelStatusOpen,
		TokenProgram:       extraString(requirements.Extra, batchsettlement.ExtraTokenProgram),
		WithdrawDelay:      parsed.ChannelConfig.WithdrawDelay,
	}, nil
}

func recoveredState(
	parsed batchsettlement.ParsedBatchPayload,
	requirements types.PaymentRequirements,
	channelID string,
	snapshot VerifiedChannelState,
) (ChannelState, error) {
	salt, err := paymentchannels.ParseU64(parsed.ChannelConfig.Salt, "salt")
	if err != nil {
		return ChannelState{}, err
	}
	deposit := uint64(0)
	if snapshot.Balance != nil {
		deposit = *snapshot.Balance
	}
	return ChannelState{
		ChannelConfig:           parsed.ChannelConfig,
		ChannelID:               channelID,
		ChargedCumulativeAmount: snapshot.TotalClaimed,
		Deposit:                 deposit,
		FeePayer:                extraString(requirements.Extra, batchsettlement.ExtraFeePayer),
		Mint:                    requirements.Asset,
		OpenSlot:                uint64(parsed.ChannelConfig.OpenSlot),
		Payer:                   parsed.ChannelConfig.Payer,
		PayerAuthorizer:         parsed.ChannelConfig.PayerAuthorizer,
		Receiver:                requirements.PayTo,
		ReceiverAuthorizer:      parsed.ChannelConfig.ReceiverAuthorizer,
		Salt:                    salt,
		Settled:                 snapshot.TotalClaimed,
		SignedMaxClaimable:      snapshot.TotalClaimed,
		Status:                  ChannelStatusOpen,
		TokenProgram:            extraString(requirements.Extra, batchsettlement.ExtraTokenProgram),
		WithdrawDelay:           parsed.ChannelConfig.WithdrawDelay,
	}, nil
}

func applySnapshot(channelID string, snapshot VerifiedChannelState) bool {
	if snapshot.ChannelID != nil && *snapshot.ChannelID != channelID {
		return false
	}
	if snapshot.WithdrawRequestedAt != 0 {
		return false
	}
	if snapshot.Balance != nil && snapshot.TotalClaimed > *snapshot.Balance {
		return false
	}
	return true
}

func acceptedResponse(state ChannelState, requirements types.PaymentRequirements) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     true,
		Payer:       state.Payer,
		Transaction: "",
		Network:     x402.Network(requirements.Network),
		Amount:      "",
		Extra:       settlementExtra(state, requirements.Amount),
	}
}

func settlementExtra(state ChannelState, chargedAmount string) map[string]any {
	extra := map[string]any{
		"channelState":  snapshotMap(state),
		"commitmentId":  state.ChannelID + ":" + strconv.FormatUint(state.SignedMaxClaimable, 10),
		"chargedAmount": chargedAmount,
	}
	if state.ChannelConfig.VoucherSigner == batchsettlement.VoucherSignerServer {
		if voucher, ok := serverVoucher(state); ok {
			extra["voucher"] = voucher
		}
	}
	return extra
}

func serverVoucher(state ChannelState) (map[string]any, bool) {
	if state.HighestVoucherSignature == "" {
		return nil, false
	}
	return map[string]any{
		"channelId":          state.ChannelID,
		"expiresAt":          state.HighestVoucherExpiresAt,
		"maxClaimableAmount": strconv.FormatUint(state.SignedMaxClaimable, 10),
		"signature":          state.HighestVoucherSignature,
	}, true
}

func snapshotMap(state ChannelState) map[string]any {
	return map[string]any{
		"channelId":               state.ChannelID,
		"balance":                 strconv.FormatUint(state.Deposit, 10),
		"totalClaimed":            strconv.FormatUint(state.Settled, 10),
		"withdrawRequestedAt":     state.CloseRequestedAt,
		"chargedCumulativeAmount": strconv.FormatUint(state.ChargedCumulativeAmount, 10),
	}
}

func liveReservations(reservations map[string]ChannelReservation, now int64) map[string]ChannelReservation {
	out := map[string]ChannelReservation{}
	for id, reservation := range reservations {
		if reservation.ExpiresAt > now {
			out[id] = reservation
		}
	}
	return out
}

func withoutReservation(reservations map[string]ChannelReservation, reservationID string) map[string]ChannelReservation {
	out := map[string]ChannelReservation{}
	for id, reservation := range reservations {
		if id != reservationID {
			out[id] = reservation
		}
	}
	return out
}

func withoutExistingFields(extra, existing map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range extra {
		if _, found := existing[key]; found {
			continue
		}
		out[key] = value
	}
	return out
}

func hasReservation(state *ChannelState, pendingID string) bool {
	if state == nil || state.Reservations == nil {
		return false
	}
	_, ok := state.Reservations[pendingID]
	return ok
}

func readVerifiedChannelState(result *x402.VerifyResponse) (VerifiedChannelState, bool) {
	if result == nil || result.Extra == nil {
		return VerifiedChannelState{}, false
	}
	totalText, ok := result.Extra["totalClaimed"].(string)
	if !ok {
		return VerifiedChannelState{}, false
	}
	total, err := paymentchannels.ParseU64(totalText, "totalClaimed")
	if err != nil {
		return VerifiedChannelState{}, false
	}
	snapshot := VerifiedChannelState{TotalClaimed: total}
	if id, ok := result.Extra["channelId"].(string); ok {
		snapshot.ChannelID = &id
	}
	if balanceText, ok := result.Extra["balance"].(string); ok {
		if balance, err := paymentchannels.ParseU64(balanceText, "balance"); err == nil {
			snapshot.Balance = &balance
		}
	}
	if requested, ok := asRequirementInt(result.Extra["withdrawRequestedAt"]); ok {
		snapshot.WithdrawRequestedAt = requested
	}
	return snapshot, true
}

type channelSettleSnapshot struct {
	balance             string
	hasBalance          bool
	totalClaimed        uint64
	withdrawRequestedAt int64
}

func readChannelState(result *x402.SettleResponse) channelSettleSnapshot {
	snapshot := channelSettleSnapshot{}
	if result == nil || result.Extra == nil {
		return snapshot
	}
	raw, _ := result.Extra["channelState"].(map[string]any)
	if raw == nil {
		return snapshot
	}
	if balance, ok := raw["balance"].(string); ok {
		snapshot.balance = balance
		snapshot.hasBalance = true
	}
	if total, ok := raw["totalClaimed"].(string); ok {
		if parsed, err := paymentchannels.ParseU64(total, "totalClaimed"); err == nil {
			snapshot.totalClaimed = parsed
		}
	}
	if requested, ok := asRequirementInt(raw["withdrawRequestedAt"]); ok {
		snapshot.withdrawRequestedAt = requested
	}
	return snapshot
}

func confirmedDeposit(current uint64, confirmed channelSettleSnapshot) uint64 {
	if !confirmed.hasBalance {
		return current
	}
	balance, err := paymentchannels.ParseU64(confirmed.balance, "channelState.balance")
	if err != nil || balance <= current {
		return current
	}
	return balance
}

func isOnchainStateFresh(state ChannelState, configured *int64) bool {
	if state.OnchainSyncedAt == 0 {
		return false
	}
	ttl := defaultOnchainStateTtlMs(state.WithdrawDelay)
	if configured != nil {
		ttl = *configured
	}
	return time.Now().UnixMilli()-state.OnchainSyncedAt <= ttl
}

func defaultOnchainStateTtlMs(withdrawDelaySeconds int) int64 {
	if withdrawDelaySeconds < 0 {
		withdrawDelaySeconds = 0
	}
	ttl := int64(withdrawDelaySeconds) * 1000 / 3
	const minTtl = int64(30_000)
	const maxTtl = int64(5 * 60_000)
	if ttl < minTtl {
		return minTtl
	}
	if ttl > maxTtl {
		return maxTtl
	}
	return ttl
}

func requestChannel(request *RequestContext, parsed batchsettlement.ParsedBatchPayload) string {
	if request != nil && request.ChannelID != "" {
		return request.ChannelID
	}
	if parsed.Voucher != nil && parsed.Voucher.ChannelID != "" {
		return parsed.Voucher.ChannelID
	}
	if parsed.Authorization != nil {
		return parsed.Authorization.ChannelID
	}
	return ""
}
