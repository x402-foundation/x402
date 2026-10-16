package server

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// BatchSettlementRequestContext carries per-request state across the verify->settle
// lifecycle for a single payment.
type BatchSettlementRequestContext struct {
	ChannelId              string
	PendingId              string
	ChannelSnapshot        *ChannelSession
	LocalVerify            bool
	ReservationCommitted   *bool
	CorrectiveChannelState *batchsettlement.BatchSettlementChannelStateExtra
	CorrectiveVoucherState *batchsettlement.BatchSettlementVoucherStateExtra
}

func reservationFlag(committed bool) *bool {
	value := committed
	return &value
}

func reservationCommitted(rc *BatchSettlementRequestContext) bool {
	return rc != nil && rc.ReservationCommitted != nil && *rc.ReservationCommitted
}

const (
	ErrAmountMustBeString   = "amount must be a string for batched scheme"
	ErrAssetAddressRequired = "asset address is required for batched scheme"
	ErrFailedToParsePrice   = "failed to parse price"
	ErrUnsupportedPriceType = "unsupported price type"
	ErrFailedToConvertAmt   = "failed to convert amount"
	ErrNoAssetSpecified     = "no asset specified for batched scheme"
	ErrFailedToParseAmount  = "failed to parse amount"
)

// AuthorizerSigner is the interface for the server-controlled receiverAuthorizer key.
// Used for signing refund and claim batch authorizations.
type AuthorizerSigner interface {
	Address() string
	SignTypedData(ctx context.Context, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}) ([]byte, error)
}

// BatchSettlementEvmSchemeServerConfig configures the batched server scheme.
type BatchSettlementEvmSchemeServerConfig struct {
	// Storage is the session persistence backend. Defaults to in-memory.
	Storage SessionStorage
	// LockStorage is the admission-lock backend. Defaults to Storage when it
	// implements ChannelLockStorage, otherwise a separate in-memory lock store.
	LockStorage ChannelLockStorage
	// ReceiverAuthorizerSigner is the server-controlled key for signing refund/claim authorizations.
	ReceiverAuthorizerSigner AuthorizerSigner
	// WithdrawDelay is the withdraw delay in seconds. Defaults to 900 (15 min).
	WithdrawDelay int
	// OnchainStateTtlMs is the maximum age of cached onchain state, in
	// milliseconds, that may be trusted for local voucher verification.
	// When zero, derived from WithdrawDelay (clamped between 30s and 5min).
	OnchainStateTtlMs int64
	// EnforceMinDeposit rejects deposits below the announced extra.minDeposit
	// hint. Default false (hint only). The facilitator never enforces this.
	EnforceMinDeposit bool
	// VoucherStoreMode selects self-managed (default) or facilitator-managed
	// voucher custody. Facilitator-managed treats Storage as a post-settle replica.
	VoucherStoreMode VoucherStoreMode
	// RefundAuthorizerSigner is the server-owned refund authorizer for facilitator-managed mode.
	// Its address is announced as extra.refundAuthorizer, is packed into the channel salt, and
	// its signature on a refund is the consent the facilitator checks. When omitted, the 402
	// omits extra.refundAuthorizer and refunds are authorized by the authenticated /settle
	// caller, which requires the facilitator to advertise extra.delegatedRefund: true.
	// Ignored in self-managed mode.
	RefundAuthorizerSigner AuthorizerSigner
}

// BatchSettlementEvmScheme implements SchemeNetworkServer for batched settlement.
type BatchSettlementEvmScheme struct {
	receiverAddress          string
	storage                  SessionStorage
	lockStorage              ChannelLockStorage
	receiverAuthorizerSigner AuthorizerSigner
	refundAuthorizerSigner   AuthorizerSigner
	withdrawDelay            int
	onchainStateTtlMs        int64
	enforceMinDeposit        bool
	configuredMode           VoucherStoreMode
	moneyParsers             []x402.MoneyParser

	// requestContexts maps a per-payment key to state carried across verify and
	// settle hooks.
	requestContextsMu sync.Mutex
	requestContexts   map[string]*BatchSettlementRequestContext
}

// requestContextKey returns a payment identity that stays stable when server
// enrichment adds settlement-only fields to the payload.
func requestContextKey(payload any) string {
	if payload == nil {
		return ""
	}
	if view, ok := payload.(x402.PaymentPayloadView); ok {
		payloadMap := view.GetPayload()
		payloadType, _ := payloadMap["type"].(string)
		voucher, _ := payloadMap["voucher"].(map[string]interface{})
		channelId, _ := voucher["channelId"].(string)
		maxClaimable, _ := voucher["maxClaimableAmount"].(string)
		signature, _ := voucher["signature"].(string)
		return strings.Join([]string{
			strconv.Itoa(view.GetVersion()),
			view.GetScheme(),
			view.GetNetwork(),
			payloadType,
			strings.ToLower(channelId),
			maxClaimable,
			signature,
			channelConfigKey(payloadMap["channelConfig"]),
		}, "\x00")
	}
	return fmt.Sprintf("%p", payload)
}

func channelConfigKey(raw any) string {
	switch cfg := raw.(type) {
	case batchsettlement.ChannelConfig:
		return formatChannelConfigKey(cfg)
	case *batchsettlement.ChannelConfig:
		if cfg == nil {
			return ""
		}
		return formatChannelConfigKey(*cfg)
	case map[string]interface{}:
		parsed, err := batchsettlement.ChannelConfigFromMap(cfg)
		if err != nil {
			return ""
		}
		return formatChannelConfigKey(parsed)
	default:
		return ""
	}
}

func formatChannelConfigKey(cfg batchsettlement.ChannelConfig) string {
	return strings.Join([]string{
		strings.ToLower(cfg.Payer),
		strings.ToLower(cfg.PayerAuthorizer),
		strings.ToLower(cfg.Receiver),
		strings.ToLower(cfg.ReceiverAuthorizer),
		strings.ToLower(cfg.Token),
		strconv.Itoa(cfg.WithdrawDelay),
		cfg.Salt,
	}, "\x00")
}

// NewBatchSettlementEvmScheme creates a new batched server scheme.
func NewBatchSettlementEvmScheme(receiverAddress string, config *BatchSettlementEvmSchemeServerConfig) *BatchSettlementEvmScheme {
	store := SessionStorage(nil)
	var enforceMinDeposit bool
	var onchainStateTtlMs int64
	if config != nil {
		store = config.Storage
		onchainStateTtlMs = config.OnchainStateTtlMs
		enforceMinDeposit = config.EnforceMinDeposit
	}
	if store == nil {
		store = NewInMemoryChannelStorage()
	}

	scheme := &BatchSettlementEvmScheme{
		receiverAddress:   receiverAddress,
		storage:           store,
		enforceMinDeposit: enforceMinDeposit,
		moneyParsers:      []x402.MoneyParser{},
		requestContexts:   make(map[string]*BatchSettlementRequestContext),
	}

	if config != nil && config.VoucherStoreMode == VoucherStoreModeFacilitator {
		scheme.configuredMode = VoucherStoreModeFacilitator
		scheme.refundAuthorizerSigner = config.RefundAuthorizerSigner
		scheme.withdrawDelay = batchsettlement.MinWithdrawDelay
		if ls, ok := store.(ChannelLockStorage); ok {
			scheme.lockStorage = ls
		} else {
			scheme.lockStorage = NewInMemoryChannelStorage()
		}
	} else {
		scheme.configuredMode = VoucherStoreModeSelf
		var authSigner AuthorizerSigner
		withdrawDelay := batchsettlement.MinWithdrawDelay
		if config != nil {
			authSigner = config.ReceiverAuthorizerSigner
			if config.WithdrawDelay > 0 {
				withdrawDelay = config.WithdrawDelay
			}
		}
		scheme.receiverAuthorizerSigner = authSigner
		scheme.withdrawDelay = withdrawDelay
		lockStorage := ChannelLockStorage(nil)
		if config != nil {
			lockStorage = config.LockStorage
		}
		if lockStorage == nil {
			if ls, ok := store.(ChannelLockStorage); ok {
				lockStorage = ls
			} else {
				lockStorage = NewInMemoryChannelStorage()
			}
		}
		scheme.lockStorage = lockStorage
	}

	if onchainStateTtlMs <= 0 {
		onchainStateTtlMs = storage.DefaultOnchainStateTtlMs(scheme.withdrawDelay)
	}
	scheme.onchainStateTtlMs = onchainStateTtlMs
	return scheme
}

// GetOnchainStateTtlMs returns the configured TTL (in ms) for trusting cached
// onchain channel state for local voucher verification.
func (s *BatchSettlementEvmScheme) GetOnchainStateTtlMs() int64 {
	return s.onchainStateTtlMs
}

// MergeRequestContext merges fields into the per-payload request context,
// creating one if none exists.
func (s *BatchSettlementEvmScheme) MergeRequestContext(payload any, partial BatchSettlementRequestContext) {
	key := requestContextKey(payload)
	if key == "" {
		return
	}
	s.requestContextsMu.Lock()
	defer s.requestContextsMu.Unlock()
	merged := BatchSettlementRequestContext{}
	if cur := s.requestContexts[key]; cur != nil {
		merged = *cur
	}
	if partial.ChannelId != "" {
		merged.ChannelId = partial.ChannelId
	}
	if partial.PendingId != "" {
		merged.PendingId = partial.PendingId
	}
	if partial.ChannelSnapshot != nil {
		merged.ChannelSnapshot = partial.ChannelSnapshot
	}
	if partial.LocalVerify {
		merged.LocalVerify = true
	}
	if partial.ReservationCommitted != nil {
		merged.ReservationCommitted = partial.ReservationCommitted
	}
	if partial.CorrectiveChannelState != nil {
		merged.CorrectiveChannelState = partial.CorrectiveChannelState
	}
	if partial.CorrectiveVoucherState != nil {
		merged.CorrectiveVoucherState = partial.CorrectiveVoucherState
	}
	s.requestContexts[key] = &merged
}

func (s *BatchSettlementEvmScheme) requestContextCount() int {
	s.requestContextsMu.Lock()
	defer s.requestContextsMu.Unlock()
	return len(s.requestContexts)
}

// ReadRequestContext returns the per-payload request context without clearing it.
func (s *BatchSettlementEvmScheme) ReadRequestContext(payload any) *BatchSettlementRequestContext {
	key := requestContextKey(payload)
	if key == "" {
		return nil
	}
	s.requestContextsMu.Lock()
	defer s.requestContextsMu.Unlock()
	return s.requestContexts[key]
}

// TakeRequestContext reads and clears the per-payload request context.
func (s *BatchSettlementEvmScheme) TakeRequestContext(payload any) *BatchSettlementRequestContext {
	key := requestContextKey(payload)
	if key == "" {
		return nil
	}
	s.requestContextsMu.Lock()
	defer s.requestContextsMu.Unlock()
	rc := s.requestContexts[key]
	delete(s.requestContexts, key)
	return rc
}

// RememberChannelSnapshot stores a channel snapshot keyed to a specific payload
// so EnrichPaymentRequiredResponse can echo it in the corrective 402.
func (s *BatchSettlementEvmScheme) RememberChannelSnapshot(payload any, session *ChannelSession) {
	if payload == nil || session == nil {
		return
	}
	s.MergeRequestContext(payload, BatchSettlementRequestContext{
		ChannelId:       session.ChannelId,
		ChannelSnapshot: session,
	})
}

// TakeChannelSnapshot reads and clears the channel snapshot for a payload.
func (s *BatchSettlementEvmScheme) TakeChannelSnapshot(payload any) *ChannelSession {
	rc := s.TakeRequestContext(payload)
	if rc == nil {
		return nil
	}
	return rc.ChannelSnapshot
}

// ReleasePendingRequest releases this request's admission lock without
// touching a newer holder or deleting the request-context entry. Lock-store
// I/O is ignored; implementation/parse errors fail closed.
func (s *BatchSettlementEvmScheme) ReleasePendingRequest(payload any) error {
	rc := s.ReadRequestContext(payload)
	if !reservationCommitted(rc) || rc.ChannelId == "" || rc.PendingId == "" {
		return nil
	}
	if impl := RethrowLockImplementationError(s.lockStorage.Release(context.Background(), rc.ChannelId, rc.PendingId)); impl != nil {
		return impl
	}
	s.MergeRequestContext(payload, BatchSettlementRequestContext{ReservationCommitted: reservationFlag(false)})
	return nil
}

// ClearPendingRequest releases this request's admission lock, then deletes the
// request-context map entry. Use on terminal paths that no longer need the
// snapshot. ReleasePendingRequest is release-only and keeps the entry.
func (s *BatchSettlementEvmScheme) ClearPendingRequest(payload any) error {
	err := s.ReleasePendingRequest(payload)
	s.TakeRequestContext(payload)
	return err
}

// EnrichPaymentRequiredResponse implements x402.PaymentRequiredEnricher.
func (s *BatchSettlementEvmScheme) EnrichPaymentRequiredResponse(ctx x402.PaymentRequiredContext) {
	if ctx.PaymentPayload != nil && !s.handlersMatch(ctx.PaymentPayload.Accepted) {
		return
	}
	switch s.configuredMode {
	case VoucherStoreModeFacilitator:
		handleManagedEnrichPaymentRequiredResponse(s, ctx)
		return
	case VoucherStoreModeSelf:
		handleEnrichPaymentRequiredResponse(s, ctx)
		return
	default:
		_ = s.configuredMode
	}
}

// handleEnrichPaymentRequiredResponse adds corrective ChannelState on a
// cumulative-amount-mismatch verify failure, sourced first from a BeforeVerify
// snapshot, then from storage.
func handleEnrichPaymentRequiredResponse(s *BatchSettlementEvmScheme, ctx x402.PaymentRequiredContext) {
	if ctx.Error != batchsettlement.ErrCumulativeAmountMismatch || ctx.PaymentPayload == nil {
		return
	}

	payload := ctx.PaymentPayload.Payload
	channelId := extractChannelIdFromPayload(payload)
	if channelId == "" {
		return
	}

	// Soft-fail when the claimed channelId does not bind to channelConfig+network.
	if cfgMap, ok := payload["channelConfig"].(map[string]interface{}); ok {
		if cfg, err := batchsettlement.ChannelConfigFromMap(cfgMap); err == nil {
			if batchsettlement.ChannelIdBindingError(cfg, channelId, ctx.PaymentPayload.Accepted.Network) != "" {
				return
			}
		}
	}

	var session *ChannelSession
	if ctx.PaymentPayload != nil {
		session = s.TakeChannelSnapshot(ctx.PaymentPayload)
	}
	if session == nil {
		stored, err := s.storage.Get(context.Background(), channelId)
		if err != nil || stored == nil {
			return
		}
		session = stored
	}

	channelState := batchsettlement.BatchSettlementChannelStateExtra{
		ChannelId:               session.ChannelId,
		Balance:                 session.Balance,
		TotalClaimed:            session.TotalClaimed,
		WithdrawRequestedAt:     session.WithdrawRequestedAt,
		RefundNonce:             fmt.Sprintf("%d", session.RefundNonce),
		ChargedCumulativeAmount: session.ChargedCumulativeAmount,
	}
	voucherState := batchsettlement.BatchSettlementVoucherStateExtra{
		SignedMaxClaimable: session.SignedMaxClaimable,
		Signature:          session.Signature,
	}

	network := ctx.PaymentPayload.Accepted.Network
	for i := range ctx.Requirements {
		if ctx.Requirements[i].Scheme != batchsettlement.SchemeBatched {
			continue
		}
		if ctx.Requirements[i].Network != network {
			continue
		}
		WriteCorrectiveAcceptExtra(&ctx.Requirements[i], channelState, voucherState)
	}
}

// OnVerifiedPaymentCanceledHook returns a hook that releases this request's
// pending reservation when the resource handler errors or returns a non-2xx
// response. Facilitator-managed mode is a no-op: the facilitator owns admission.
func (s *BatchSettlementEvmScheme) OnVerifiedPaymentCanceledHook() x402.OnVerifiedPaymentCanceledHook {
	return func(ctx x402.VerifiedPaymentCanceledContext) error {
		if !s.handlersMatch(ctx.Requirements) {
			return nil
		}
		switch s.configuredMode {
		case VoucherStoreModeFacilitator:
			return handleManagedVerifiedPaymentCanceled(s, ctx)
		case VoucherStoreModeSelf:
			return handleVerifiedPaymentCanceled(s, ctx)
		default:
			return nil
		}
	}
}

func handleVerifiedPaymentCanceled(s *BatchSettlementEvmScheme, ctx x402.VerifiedPaymentCanceledContext) error {
	if ctx.Reason != x402.CancellationReasonHandlerThrew &&
		ctx.Reason != x402.CancellationReasonHandlerFailed &&
		ctx.Reason != x402.CancellationReasonAfterVerifyAborted {
		return nil
	}
	return s.ClearPendingRequest(ctx.Payload)
}

// SettleOnCancel settles a cancel so the facilitator can drop the admission lock.
// Self-managed cleanup stays on OnVerifiedPaymentCanceled.
func (s *BatchSettlementEvmScheme) SettleOnCancel(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	switch s.configuredMode {
	case VoucherStoreModeFacilitator:
		return handleManagedSettleOnCancel(ctx)
	case VoucherStoreModeSelf:
		return nil, nil
	default:
		return nil, fmt.Errorf("unhandled voucher store mode: %s", s.configuredMode)
	}
}

// extractChannelIdFromPayload pulls voucher.channelId from a deposit/voucher/refund payload map.
func extractChannelIdFromPayload(payload map[string]interface{}) string {
	if payload == nil {
		return ""
	}
	if v, ok := payload["voucher"].(map[string]interface{}); ok {
		if id, ok := v["channelId"].(string); ok {
			return id
		}
	}
	return ""
}

// Scheme returns the scheme identifier.
func (s *BatchSettlementEvmScheme) Scheme() string {
	return batchsettlement.SchemeBatched
}

// DefaultAssetTransferMethod returns the ATM used when extra.assetTransferMethod is absent.
func (s *BatchSettlementEvmScheme) DefaultAssetTransferMethod() string {
	return string(evm.AssetTransferMethodEIP3009)
}

// PaymentFlows returns ATM-keyed payment flow support for batch-settlement EVM.
func (s *BatchSettlementEvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	auth := x402.PaymentFlowConfig{
		Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization},
		Default:   x402.PaymentFlowAuthorization,
	}
	return map[string]x402.PaymentFlowConfig{
		string(evm.AssetTransferMethodEIP3009): auth,
		string(evm.AssetTransferMethodPermit2): auth,
	}
}

// GetAssetDecimals implements AssetDecimalsProvider.
func (s *BatchSettlementEvmScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	found := evm.FindDefaultAsset(asset, string(network))
	if found == nil {
		return 0, false
	}
	return found.Decimals, true
}

// RegisterMoneyParser registers a custom money parser.
func (s *BatchSettlementEvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *BatchSettlementEvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// GetStorage returns the underlying session storage.
func (s *BatchSettlementEvmScheme) GetStorage() SessionStorage {
	return s.storage
}

// GetLockStorage returns the admission lock store.
func (s *BatchSettlementEvmScheme) GetLockStorage() ChannelLockStorage {
	return s.lockStorage
}

// GetReceiverAddress returns the receiver address.
func (s *BatchSettlementEvmScheme) GetReceiverAddress() string {
	return s.receiverAddress
}

// GetWithdrawDelay returns the configured withdraw delay.
func (s *BatchSettlementEvmScheme) GetWithdrawDelay() int {
	return s.withdrawDelay
}

// GetEnforceMinDeposit returns whether deposits below extra.minDeposit are rejected.
func (s *BatchSettlementEvmScheme) GetEnforceMinDeposit() bool {
	return s.enforceMinDeposit
}

// GetReceiverAuthorizerAddress returns the receiver authorizer's address.
func (s *BatchSettlementEvmScheme) GetReceiverAuthorizerAddress() string {
	if s.receiverAuthorizerSigner != nil {
		return s.receiverAuthorizerSigner.Address()
	}
	return ""
}

// GetReceiverAuthorizerSigner returns the receiver-authorizer signer, if configured.
func (s *BatchSettlementEvmScheme) GetReceiverAuthorizerSigner() AuthorizerSigner {
	return s.receiverAuthorizerSigner
}

// GetRefundAuthorizerSigner returns the signer used for refund consent.
// Self-managed uses the receiver authorizer; facilitator-managed uses RefundAuthorizerSigner.
func (s *BatchSettlementEvmScheme) GetRefundAuthorizerSigner() AuthorizerSigner {
	switch s.configuredMode {
	case VoucherStoreModeSelf:
		return s.receiverAuthorizerSigner
	case VoucherStoreModeFacilitator:
		return s.refundAuthorizerSigner
	default:
		return nil
	}
}

// IsFacilitatorManagedVoucherStore reports whether this scheme was constructed
// for facilitator voucher custody.
func (s *BatchSettlementEvmScheme) IsFacilitatorManagedVoucherStore(_ x402.Network) bool {
	return s.configuredMode == VoucherStoreModeFacilitator
}

func (s *BatchSettlementEvmScheme) handlersMatch(requirements x402.PaymentRequirementsView) bool {
	return storage.VoucherStoreModeOf(types.PaymentRequirements{Extra: requirements.GetExtra()}) == s.configuredMode
}

func (s *BatchSettlementEvmScheme) requireHandlers(requirements x402.PaymentRequirementsView) error {
	if !s.handlersMatch(requirements) {
		return errors.New(batchsettlement.ErrVoucherStoreModeMismatch)
	}
	return nil
}

func voucherStoreModeMismatchAbort() *x402.BeforeHookResult {
	return &x402.BeforeHookResult{
		Abort:   true,
		Reason:  batchsettlement.ErrVoucherStoreModeMismatch,
		Message: "Payment requirements voucherManager does not match the server voucherStoreMode",
	}
}

func extraInt(extra map[string]interface{}, key string) (int, bool) {
	if extra == nil {
		return 0, false
	}
	return batchsettlement.ExtraInt(extra[key])
}

// ValidateFacilitatorSupport rejects startup when this scheme delegates the
// receiver-authorizer role but the facilitator does not advertise a usable
// receiverAuthorizer.
func (s *BatchSettlementEvmScheme) ValidateFacilitatorSupport(
	network x402.Network,
	supportedKind types.SupportedKind,
	_ []string,
) error {
	advertised, _ := supportedKind.Extra["receiverAuthorizer"].(string)
	hasValidAuthorizer := advertised != "" && !strings.EqualFold(common.HexToAddress(advertised).Hex(), zeroAddress)

	switch s.configuredMode {
	case VoucherStoreModeFacilitator:
		if !storage.AdvertisesVoucherManager(supportedKind.Extra, batchsettlement.VoucherManagerFacilitator) {
			return fmt.Errorf(
				`voucherStoreMode "facilitator" is configured but the facilitator does not advertise voucherManager "facilitator" on %s`,
				network,
			)
		}
		if !hasValidAuthorizer {
			return fmt.Errorf("voucherStore mode requires a non-zero advertised receiverAuthorizer on %s", network)
		}
		delay, ok := extraInt(supportedKind.Extra, "withdrawDelay")
		if !ok || delay < batchsettlement.MinWithdrawDelay || delay > batchsettlement.MaxWithdrawDelay {
			return fmt.Errorf("voucherStore mode requires an in-range advertised withdrawDelay on %s", network)
		}
		if s.refundAuthorizerSigner == nil && !advertisesDelegatedRefund(supportedKind.Extra) {
			return fmt.Errorf(errRefundConsentUnavailable, network)
		}
		return nil
	case VoucherStoreModeSelf:
		if !storage.AdvertisesVoucherManager(supportedKind.Extra, batchsettlement.VoucherManagerServer) {
			return fmt.Errorf(
				`the facilitator advertises voucherManager without "server" on %s, so a self-managed server cannot use it`,
				network,
			)
		}
		if s.receiverAuthorizerSigner != nil {
			return nil
		}
		if hasValidAuthorizer {
			// Delegated receiverAuthorizer: refunds rely on the facilitator honoring unsigned
			// caller-identity refunds. An absent field is a legacy facilitator and passes.
			if explicitlyNoDelegatedRefund(supportedKind.Extra) {
				return fmt.Errorf(
					"the facilitator explicitly advertises delegatedRefund: false on %s, so refunds "+
						"on channels with a delegated receiverAuthorizer cannot work. Configure a "+
						"ReceiverAuthorizerSigner or use a facilitator that supports delegated refunds",
					network,
				)
			}
			return nil
		}
		return fmt.Errorf(
			"no receiver authorizer signer is configured and the facilitator does not advertise "+
				"a receiverAuthorizer on %s. Configure a ReceiverAuthorizerSigner or use a "+
				"facilitator that advertises one",
			network,
		)
	default:
		return fmt.Errorf("unhandled voucher store mode: %s", s.configuredMode)
	}
}

// ParsePrice parses a price and converts it to an asset amount.
func (s *BatchSettlementEvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	// If already an AssetAmount map, return directly
	if priceMap, ok := price.(map[string]interface{}); ok {
		if amountVal, hasAmount := priceMap["amount"]; hasAmount {
			amountStr, ok := amountVal.(string)
			if !ok {
				return x402.AssetAmount{}, errors.New(ErrAmountMustBeString)
			}
			asset := ""
			if assetVal, hasAsset := priceMap["asset"]; hasAsset {
				if assetStr, ok := assetVal.(string); ok {
					asset = assetStr
				}
			}
			if asset == "" {
				return x402.AssetAmount{}, errors.New(ErrAssetAddressRequired)
			}
			extra := make(map[string]interface{})
			if extraVal, hasExtra := priceMap["extra"]; hasExtra {
				if extraMap, ok := extraVal.(map[string]interface{}); ok {
					extra = extraMap
				}
			}
			return x402.AssetAmount{
				Amount: amountStr,
				Asset:  asset,
				Extra:  extra,
			}, nil
		}
	}

	decimalAmount, symbol, err := x402.ParseMoney(price)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	for _, parser := range s.moneyParsers {
		result, err := parser(decimalAmount, network)
		if err != nil {
			continue
		}
		if result != nil {
			return *result, nil
		}
	}

	return defaultMoneyConversion(decimalAmount, network, symbol)
}

// EnhancePaymentRequirements adds batched-specific fields to payment requirements.
func (s *BatchSettlementEvmScheme) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	networkStr := string(requirements.Network)

	// Get or set asset
	var assetInfo *evm.AssetInfo
	var err error
	if requirements.Asset != "" {
		assetInfo, err = evm.GetAssetInfo(networkStr, requirements.Asset)
		if err != nil {
			return requirements, err
		}
	} else {
		assetInfo, err = evm.GetAssetInfo(networkStr, "")
		if err != nil {
			return requirements, fmt.Errorf(ErrNoAssetSpecified+": %w", err)
		}
		requirements.Asset = assetInfo.Address
	}

	// Normalize amount to smallest unit
	if requirements.Amount != "" && strings.Contains(requirements.Amount, ".") {
		amount, err := evm.ParseAmount(requirements.Amount, assetInfo.Decimals)
		if err != nil {
			return requirements, fmt.Errorf(ErrFailedToParseAmount+": %w", err)
		}
		requirements.Amount = amount.String()
	}

	// Initialize Extra
	if requirements.Extra == nil {
		requirements.Extra = make(map[string]interface{})
	}

	// Token EIP-712 domain (`name` / `version`). Always populated when the asset
	// metadata provides them because the ERC-3009 deposit collector and the
	// gas-sponsored EIP-2612 permit segment recompute the token's EIP-712 digest
	// off-chain.
	if _, ok := requirements.Extra["name"]; !ok {
		requirements.Extra["name"] = assetInfo.Name
	}
	if _, ok := requirements.Extra["version"]; !ok {
		requirements.Extra["version"] = assetInfo.Version
	}

	minDeposit, hintErr := s.ResolveMinDepositHint(requirements)
	if hintErr != nil {
		return requirements, hintErr
	}

	switch s.configuredMode {
	case VoucherStoreModeFacilitator:
		if !storage.AdvertisesVoucherManager(supportedKind.Extra, batchsettlement.VoucherManagerFacilitator) {
			return requirements, fmt.Errorf(`facilitator-managed mode requires advertised extra.voucherManager to include "facilitator"`)
		}
		advertisedAuthorizer, _ := supportedKind.Extra["receiverAuthorizer"].(string)
		if advertisedAuthorizer == "" || strings.EqualFold(common.HexToAddress(advertisedAuthorizer).Hex(), zeroAddress) {
			return requirements, fmt.Errorf("payment requirements must include a non-zero extra.receiverAuthorizer")
		}
		advertisedDelay, ok := extraInt(supportedKind.Extra, "withdrawDelay")
		if !ok {
			return requirements, fmt.Errorf("facilitator-managed mode requires advertised extra.withdrawDelay")
		}
		requirements.Extra["receiverAuthorizer"] = common.HexToAddress(advertisedAuthorizer).Hex()
		requirements.Extra["withdrawDelay"] = advertisedDelay
		requirements.Extra["voucherManager"] = batchsettlement.VoucherManagerFacilitator
		// extra.refundAuthorizer is set only for a server-owned refund key. Otherwise the 402
		// omits it and refunds rely on the facilitator's delegatedRefund.
		delete(requirements.Extra, "refundAuthorizer")
		if s.refundAuthorizerSigner != nil {
			requirements.Extra["refundAuthorizer"] = common.HexToAddress(s.refundAuthorizerSigner.Address()).Hex()
		} else if !advertisesDelegatedRefund(supportedKind.Extra) {
			return requirements, fmt.Errorf(errRefundConsentUnavailable, requirements.Network)
		}
		requirements.Extra["minDeposit"] = minDeposit
	case VoucherStoreModeSelf:
		if !storage.AdvertisesVoucherManager(supportedKind.Extra, batchsettlement.VoucherManagerServer) {
			return requirements, fmt.Errorf(`self-managed mode requires advertised extra.voucherManager to include "server"`)
		}
		// Receiver authorizer resolution order:
		//   1. Pre-existing requirements.Extra["receiverAuthorizer"] (caller override).
		//   2. Locally-configured ReceiverAuthorizerSigner address.
		//   3. Facilitator-advertised authorizer from supportedKind.Extra (delegated mode).
		if existing, ok := requirements.Extra["receiverAuthorizer"].(string); !ok || existing == "" || strings.EqualFold(existing, zeroAddress) {
			receiverAuth := s.GetReceiverAuthorizerAddress()
			if (receiverAuth == "" || strings.EqualFold(receiverAuth, zeroAddress)) && supportedKind.Extra != nil {
				if facilitatorAuth, ok := supportedKind.Extra["receiverAuthorizer"].(string); ok {
					receiverAuth = facilitatorAuth
				}
			}
			if receiverAuth == "" || strings.EqualFold(receiverAuth, zeroAddress) {
				return requirements, fmt.Errorf("payment requirements must include a non-zero extra.receiverAuthorizer")
			}
			requirements.Extra["receiverAuthorizer"] = receiverAuth
		}
		if _, ok := requirements.Extra["withdrawDelay"]; !ok {
			requirements.Extra["withdrawDelay"] = s.withdrawDelay
		}
		requirements.Extra["minDeposit"] = minDeposit
	default:
		return requirements, fmt.Errorf("unhandled voucher store mode: %s", s.configuredMode)
	}

	if supportedKind.Extra != nil {
		for _, key := range extensionKeys {
			if val, ok := supportedKind.Extra[key]; ok {
				requirements.Extra[key] = val
			}
		}
	}

	return requirements, nil
}

// errRefundConsentUnavailable is the format for a facilitator-managed server that has neither
// a refund key nor a facilitator that honors caller-identity refunds. It takes the network.
const errRefundConsentUnavailable = "facilitator-managed mode needs a refund consent path on %s: " +
	"configure a RefundAuthorizerSigner or use a facilitator that advertises delegatedRefund: true"

// delegatedRefundField reads the facilitator's extra.delegatedRefund. ok is false when the
// field is absent or not a boolean (a legacy facilitator).
func delegatedRefundField(supportedExtra map[string]interface{}) (value, ok bool) {
	value, ok = supportedExtra["delegatedRefund"].(bool)
	return value, ok
}

// advertisesDelegatedRefund reports whether the facilitator explicitly advertises delegatedRefund: true.
func advertisesDelegatedRefund(supportedExtra map[string]interface{}) bool {
	value, ok := delegatedRefundField(supportedExtra)
	return ok && value
}

// explicitlyNoDelegatedRefund reports whether the facilitator explicitly advertises delegatedRefund: false.
func explicitlyNoDelegatedRefund(supportedExtra map[string]interface{}) bool {
	value, ok := delegatedRefundField(supportedExtra)
	return ok && !value
}

// SignRefund signs a cooperative refund EIP-712 message.
func (s *BatchSettlementEvmScheme) SignRefund(ctx context.Context, channelId string, amount string, nonce string, network string) ([]byte, error) {
	if s.receiverAuthorizerSigner == nil {
		return nil, fmt.Errorf("no receiver authorizer signer configured")
	}
	return signRefundWith(ctx, s.receiverAuthorizerSigner, channelId, amount, nonce, network)
}

func signRefundWith(ctx context.Context, signer AuthorizerSigner, channelId string, amount string, nonce string, network string) ([]byte, error) {
	if signer == nil {
		return nil, fmt.Errorf("no receiver authorizer signer configured")
	}

	chainId, err := evm.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}

	refundAmount, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		return nil, fmt.Errorf("invalid refund amount: %s", amount)
	}
	refundNonce, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce: %s", nonce)
	}

	channelIdBytes, err := evm.HexToBytes(channelId)
	if err != nil {
		return nil, err
	}

	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)

	allTypes := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"Refund": batchsettlement.RefundTypes["Refund"],
	}

	message := map[string]interface{}{
		"channelId": channelIdBytes,
		"nonce":     refundNonce,
		"amount":    refundAmount,
	}

	return signer.SignTypedData(ctx, domain, allTypes, "Refund", message)
}

// SignClaimBatch signs a ClaimBatch EIP-712 message.
func (s *BatchSettlementEvmScheme) SignClaimBatch(ctx context.Context, claims []batchsettlement.BatchSettlementVoucherClaim, network string) ([]byte, error) {
	if s.receiverAuthorizerSigner == nil {
		return nil, fmt.Errorf("no receiver authorizer signer configured")
	}
	return signClaimBatchWith(ctx, s.receiverAuthorizerSigner, claims, network)
}

func signClaimBatchWith(ctx context.Context, signer AuthorizerSigner, claims []batchsettlement.BatchSettlementVoucherClaim, network string) ([]byte, error) {
	if signer == nil {
		return nil, fmt.Errorf("no receiver authorizer signer configured")
	}

	chainId, err := evm.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}

	domain := batchsettlement.GetBatchSettlementEip712Domain(chainId)

	allTypes := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"ClaimBatch": batchsettlement.ClaimBatchTypes["ClaimBatch"],
		"ClaimEntry": batchsettlement.ClaimBatchTypes["ClaimEntry"],
	}

	entries := make([]map[string]interface{}, len(claims))
	for i, claim := range claims {
		channelId, _ := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		channelIdBytes, _ := evm.HexToBytes(channelId)
		maxClaimable, _ := new(big.Int).SetString(claim.Voucher.MaxClaimableAmount, 10)
		totalClaimed, _ := new(big.Int).SetString(claim.TotalClaimed, 10)

		entries[i] = map[string]interface{}{
			"channelId":          channelIdBytes,
			"maxClaimableAmount": maxClaimable,
			"totalClaimed":       totalClaimed,
		}
	}

	message := map[string]interface{}{
		"claims": entries,
	}

	return signer.SignTypedData(ctx, domain, allTypes, "ClaimBatch", message)
}

// CreateChannelManager creates a new channel manager for auto-settlement
// rooted at this scheme's receiver and the network's default settlement asset.
//
// Pass a custom token via NewBatchSettlementChannelManager directly when you need a
// non-default settlement asset for this manager.
func (s *BatchSettlementEvmScheme) CreateChannelManager(facilitator x402.FacilitatorClient, network x402.Network) *BatchSettlementChannelManager {
	token := ""
	if info, err := evm.GetDefaultAsset(string(network), ""); err == nil {
		token = info.Asset
	}
	return NewBatchSettlementChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: facilitator,
		Receiver:    s.receiverAddress,
		Token:       token,
		Network:     network,
	})
}

// GetSession retrieves a session for a channel.
func (s *BatchSettlementEvmScheme) GetSession(channelId string) (*ChannelSession, error) {
	return s.storage.Get(context.Background(), channelId)
}

// ResolveMinDepositHint resolves the extra.minDeposit hint written on every 402.
func (s *BatchSettlementEvmScheme) ResolveMinDepositHint(requirements types.PaymentRequirements) (string, error) {
	amount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok {
		return "", fmt.Errorf("invalid amount: %s", requirements.Amount)
	}

	var routeOverride interface{}
	if requirements.Extra != nil {
		routeOverride = requirements.Extra["minDeposit"]
	}

	var configuredMin *big.Int
	if override, isString := routeOverride.(string); isString {
		if isAtomicMinDeposit(override) {
			parsed, err := parseAtomicMinDeposit(override)
			if err != nil {
				return "", err
			}
			configuredMin = parsed
		} else {
			parsed, err := s.resolveRouteMoneyMinDeposit(override, requirements)
			if err != nil {
				return "", err
			}
			configuredMin = parsed
		}
	}

	if configuredMin == nil {
		return new(big.Int).Mul(amount, big.NewInt(int64(batchsettlement.DefaultServerMinDepositMultiplier))).String(), nil
	}

	if amount.Cmp(configuredMin) > 0 {
		return amount.String(), nil
	}
	return configuredMin.String(), nil
}

func (s *BatchSettlementEvmScheme) resolveRouteMoneyMinDeposit(money string, requirement types.PaymentRequirements) (*big.Int, error) {
	defaultAsset := evm.FindDefaultAsset(requirement.Asset, string(requirement.Network))
	if defaultAsset == nil {
		return nil, fmt.Errorf(
			"extra.minDeposit money values are only supported for default assets; use an integer atomic string for %s on %s",
			requirement.Asset, requirement.Network,
		)
	}
	parsed, _, err := x402.ParseMoney(money)
	if err != nil {
		return nil, err
	}
	atomic, err := x402.ConvertToTokenAmount(parsed, defaultAsset.Decimals)
	if err != nil {
		return nil, err
	}
	return parseAtomicMinDeposit(atomic)
}

func parseAtomicMinDeposit(amount string) (*big.Int, error) {
	if !isAtomicMinDeposit(amount) {
		return nil, fmt.Errorf("minDeposit must resolve to a positive integer")
	}
	value, ok := new(big.Int).SetString(amount, 10)
	if !ok || value.Sign() <= 0 {
		return nil, fmt.Errorf("minDeposit must resolve to a positive integer")
	}
	return value, nil
}

func isAtomicMinDeposit(amount string) bool {
	if amount == "" {
		return false
	}
	for i := 0; i < len(amount); i++ {
		if amount[i] < '0' || amount[i] > '9' {
			return false
		}
	}
	return true
}

// Helper functions

func defaultMoneyConversion(amount string, network x402.Network, symbol string) (x402.AssetAmount, error) {
	assetInfo, tokenAmount, err := evm.ConvertDefaultMoney(amount, string(network), symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	extra := map[string]interface{}{
		"name":    assetInfo.Name,
		"version": assetInfo.Version,
	}
	if assetInfo.AssetTransferMethod != "" {
		extra["assetTransferMethod"] = string(assetInfo.AssetTransferMethod)
	}

	return x402.AssetAmount{
		Asset:  assetInfo.Asset,
		Amount: tokenAmount,
		Extra:  extra,
	}, nil
}
