package server

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/types"
)

// BatchSettlementRequestContext carries per-request state across the verify->settle
// lifecycle for a single payment.
type BatchSettlementRequestContext struct {
	ChannelId       string
	PendingId       string
	ChannelSnapshot *ChannelSession
	LocalVerify     bool
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
	// ReceiverAuthorizerSigner is the server-controlled key for signing refund/claim authorizations.
	ReceiverAuthorizerSigner AuthorizerSigner
	// WithdrawDelay is the withdraw delay in seconds. Defaults to 900 (15 min).
	WithdrawDelay int
	// OnchainStateTtlMs is the maximum age of cached onchain state, in
	// milliseconds, that may be trusted for local voucher verification.
	// When zero, derived from WithdrawDelay (clamped between 30s and 5min).
	OnchainStateTtlMs int64
}

// BatchSettlementEvmScheme implements SchemeNetworkServer for batched settlement.
type BatchSettlementEvmScheme struct {
	receiverAddress          string
	storage                  SessionStorage
	receiverAuthorizerSigner AuthorizerSigner
	withdrawDelay            int
	onchainStateTtlMs        int64
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
			batchsettlement.NormalizeChannelId(channelId),
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
	storage := SessionStorage(nil)
	var authSigner AuthorizerSigner
	withdrawDelay := batchsettlement.MinWithdrawDelay
	var onchainStateTtlMs int64

	if config != nil {
		storage = config.Storage
		authSigner = config.ReceiverAuthorizerSigner
		if config.WithdrawDelay > 0 {
			withdrawDelay = config.WithdrawDelay
		}
		onchainStateTtlMs = config.OnchainStateTtlMs
	}

	if onchainStateTtlMs <= 0 {
		onchainStateTtlMs = defaultOnchainStateTtlMs(withdrawDelay)
	}

	if storage == nil {
		storage = NewInMemoryChannelStorage()
	}

	return &BatchSettlementEvmScheme{
		receiverAddress:          receiverAddress,
		storage:                  storage,
		receiverAuthorizerSigner: authSigner,
		withdrawDelay:            withdrawDelay,
		onchainStateTtlMs:        onchainStateTtlMs,
		moneyParsers:             []x402.MoneyParser{},
		requestContexts:          make(map[string]*BatchSettlementRequestContext),
	}
}

// GetOnchainStateTtlMs returns the configured TTL (in ms) for trusting cached
// onchain channel state for local voucher verification.
func (s *BatchSettlementEvmScheme) GetOnchainStateTtlMs() int64 {
	return s.onchainStateTtlMs
}

// defaultOnchainStateTtlMs derives a reasonable TTL from the channel withdraw
// delay: WithdrawDelay/3, clamped to [30s, 5min].
func defaultOnchainStateTtlMs(withdrawDelaySeconds int) int64 {
	if withdrawDelaySeconds < 0 {
		withdrawDelaySeconds = 0
	}
	withdrawDelayMs := int64(withdrawDelaySeconds) * 1000
	ttl := withdrawDelayMs / 3
	const minTtl = int64(30 * 1000)
	const maxTtl = int64(5 * 60 * 1000)
	if ttl < minTtl {
		ttl = minTtl
	}
	if ttl > maxTtl {
		ttl = maxTtl
	}
	return ttl
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
	s.requestContexts[key] = &merged
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

// ClearPendingRequest clears this request's pending reservation in storage,
// without affecting any newer reservation that may have replaced it. If the
// stored channel only existed for this reservation (no snapshot), the channel
// record is deleted entirely.
func (s *BatchSettlementEvmScheme) ClearPendingRequest(payload any) error {
	rc := s.TakeRequestContext(payload)
	if rc == nil || rc.ChannelId == "" || rc.PendingId == "" {
		return nil
	}
	_, err := s.storage.UpdateChannel(rc.ChannelId, func(current *ChannelSession) *ChannelSession {
		if current == nil {
			return current
		}
		if current.PendingRequest == nil || current.PendingRequest.PendingId != rc.PendingId {
			return current
		}
		if rc.ChannelSnapshot == nil {
			return nil // delete: this reservation is the only reason the row exists
		}
		next := *current
		next.PendingRequest = nil
		return &next
	})
	return err
}

// EnrichPaymentRequiredResponse implements x402.PaymentRequiredEnricher.
// On a cumulative-amount-mismatch verify failure it adds corrective ChannelState
// (sourced first from a BeforeVerifyHook snapshot, then from storage) to each
// matching batch-settlement requirement so the client can resync.
func (s *BatchSettlementEvmScheme) EnrichPaymentRequiredResponse(ctx x402.PaymentRequiredContext) {
	if ctx.Error != batchsettlement.ErrCumulativeAmountMismatch || ctx.PaymentPayload == nil {
		return
	}

	channelId := extractChannelIdFromPayload(ctx.PaymentPayload.Payload)
	if channelId == "" {
		return
	}

	var session *ChannelSession
	if ctx.PaymentPayload != nil {
		session = s.TakeChannelSnapshot(ctx.PaymentPayload)
	}
	if session == nil {
		stored, err := s.storage.Get(batchsettlement.NormalizeChannelId(channelId))
		if err != nil || stored == nil {
			return
		}
		session = stored
	}

	channelStateMap := map[string]interface{}{
		"channelId":               session.ChannelId,
		"balance":                 session.Balance,
		"totalClaimed":            session.TotalClaimed,
		"withdrawRequestedAt":     session.WithdrawRequestedAt,
		"refundNonce":             fmt.Sprintf("%d", session.RefundNonce),
		"chargedCumulativeAmount": session.ChargedCumulativeAmount,
	}
	voucherStateMap := map[string]interface{}{}
	if session.SignedMaxClaimable != "" {
		voucherStateMap["signedMaxClaimable"] = session.SignedMaxClaimable
	}
	if session.Signature != "" {
		voucherStateMap["signature"] = session.Signature
	}

	network := ctx.PaymentPayload.Accepted.Network
	for i := range ctx.Requirements {
		if ctx.Requirements[i].Scheme != batchsettlement.SchemeBatched {
			continue
		}
		if ctx.Requirements[i].Network != network {
			continue
		}
		if ctx.Requirements[i].Extra == nil {
			ctx.Requirements[i].Extra = make(map[string]interface{})
		}
		ctx.Requirements[i].Extra["channelState"] = channelStateMap
		if len(voucherStateMap) > 0 {
			ctx.Requirements[i].Extra["voucherState"] = voucherStateMap
		}
	}
}

// OnVerifiedPaymentCanceledHook returns a hook that releases this request's
// pending reservation when the resource handler errors or returns a non-2xx
// response.
func (s *BatchSettlementEvmScheme) OnVerifiedPaymentCanceledHook() x402.OnVerifiedPaymentCanceledHook {
	return func(ctx x402.VerifiedPaymentCanceledContext) error {
		if ctx.Reason != x402.CancellationReasonHandlerThrew &&
			ctx.Reason != x402.CancellationReasonHandlerFailed {
			return nil
		}
		return s.ClearPendingRequest(ctx.Payload)
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

// GetAssetDecimals implements AssetDecimalsProvider.
func (s *BatchSettlementEvmScheme) GetAssetDecimals(asset string, network x402.Network) int {
	info, err := evm.GetAssetInfo(string(network), asset)
	if err != nil || info == nil {
		return 6
	}
	return info.Decimals
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

// GetReceiverAddress returns the receiver address.
func (s *BatchSettlementEvmScheme) GetReceiverAddress() string {
	return s.receiverAddress
}

// GetWithdrawDelay returns the configured withdraw delay.
func (s *BatchSettlementEvmScheme) GetWithdrawDelay() int {
	return s.withdrawDelay
}

// GetReceiverAuthorizerAddress returns the receiver authorizer's address.
func (s *BatchSettlementEvmScheme) GetReceiverAuthorizerAddress() string {
	if s.receiverAuthorizerSigner != nil {
		return s.receiverAuthorizerSigner.Address()
	}
	return ""
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

	decimalAmount, err := parseMoneyToDecimal(price)
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

	return defaultMoneyConversion(decimalAmount, network)
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

	// Add batched-specific fields. Receiver authorizer resolution order:
	//   1. Pre-existing requirements.Extra["receiverAuthorizer"] (caller override).
	//   2. Locally-configured ReceiverAuthorizerSigner address.
	//   3. Facilitator-advertised authorizer from supportedKind.Extra (delegated mode).
	//
	// Hard-fails if all three sources are empty/zero — clients would otherwise
	// derive the wrong channelId, and the onchain deposit transaction would
	// revert at the contract boundary.
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

	// Copy extensions from supportedKind
	if supportedKind.Extra != nil {
		for _, key := range extensionKeys {
			if val, ok := supportedKind.Extra[key]; ok {
				requirements.Extra[key] = val
			}
		}
	}

	return requirements, nil
}

// SignRefund signs a cooperative refund EIP-712 message.
func (s *BatchSettlementEvmScheme) SignRefund(ctx context.Context, channelId string, amount string, nonce string, network string) ([]byte, error) {
	if s.receiverAuthorizerSigner == nil {
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

	domain := evm.TypedDataDomain{
		Name:              batchsettlement.BatchSettlementDomain.Name,
		Version:           batchsettlement.BatchSettlementDomain.Version,
		ChainID:           chainId,
		VerifyingContract: batchsettlement.BatchSettlementAddress,
	}

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

	return s.receiverAuthorizerSigner.SignTypedData(ctx, domain, allTypes, "Refund", message)
}

// SignClaimBatch signs a ClaimBatch EIP-712 message.
func (s *BatchSettlementEvmScheme) SignClaimBatch(ctx context.Context, claims []batchsettlement.BatchSettlementVoucherClaim, network string) ([]byte, error) {
	if s.receiverAuthorizerSigner == nil {
		return nil, fmt.Errorf("no receiver authorizer signer configured")
	}

	chainId, err := evm.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}

	domain := evm.TypedDataDomain{
		Name:              batchsettlement.BatchSettlementDomain.Name,
		Version:           batchsettlement.BatchSettlementDomain.Version,
		ChainID:           chainId,
		VerifyingContract: batchsettlement.BatchSettlementAddress,
	}

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

	return s.receiverAuthorizerSigner.SignTypedData(ctx, domain, allTypes, "ClaimBatch", message)
}

// CreateChannelManager creates a new channel manager for auto-settlement
// rooted at this scheme's receiver and the network's default settlement asset.
//
// Pass a custom token via NewBatchSettlementChannelManager directly when you need a
// non-default settlement asset for this manager.
func (s *BatchSettlementEvmScheme) CreateChannelManager(facilitator x402.FacilitatorClient, network x402.Network) *BatchSettlementChannelManager {
	token := ""
	if cfg, err := evm.GetNetworkConfig(string(network)); err == nil {
		token = cfg.DefaultAsset.Address
	}
	return NewBatchSettlementChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: facilitator,
		Receiver:    s.receiverAddress,
		Token:       token,
		Network:     network,
	})
}

// UpdateSession updates or creates a session for a channel.
func (s *BatchSettlementEvmScheme) UpdateSession(channelId string, session *ChannelSession) error {
	return s.storage.Set(batchsettlement.NormalizeChannelId(channelId), session)
}

// GetSession retrieves a session for a channel.
func (s *BatchSettlementEvmScheme) GetSession(channelId string) (*ChannelSession, error) {
	return s.storage.Get(batchsettlement.NormalizeChannelId(channelId))
}

// DeleteSession removes a session for a channel.
func (s *BatchSettlementEvmScheme) DeleteSession(channelId string) error {
	return s.storage.Delete(batchsettlement.NormalizeChannelId(channelId))
}

// Helper functions

func parseMoneyToDecimal(price x402.Price) (float64, error) {
	switch v := price.(type) {
	case string:
		cleanPrice := strings.TrimSpace(v)
		cleanPrice = strings.TrimPrefix(cleanPrice, "$")
		cleanPrice = strings.TrimSpace(cleanPrice)
		amount, err := strconv.ParseFloat(cleanPrice, 64)
		if err != nil {
			return 0, fmt.Errorf(ErrFailedToParsePrice+": '%s': %w", v, err)
		}
		return amount, nil
	case float64:
		return v, nil
	case int:
		return float64(v), nil
	case int64:
		return float64(v), nil
	default:
		return 0, fmt.Errorf(ErrUnsupportedPriceType+": %T", price)
	}
}

func defaultMoneyConversion(amount float64, network x402.Network) (x402.AssetAmount, error) {
	networkStr := string(network)
	config, err := evm.GetNetworkConfig(networkStr)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	if config.DefaultAsset.Address == "" {
		return x402.AssetAmount{}, fmt.Errorf("no default stablecoin for network %s", networkStr)
	}

	extra := map[string]interface{}{
		// Token EIP-712 domain — see comment in GetExtra above for why both
		// ERC-3009 and Permit2(+EIP-2612) paths need name/version.
		"name":    config.DefaultAsset.Name,
		"version": config.DefaultAsset.Version,
	}
	if config.DefaultAsset.AssetTransferMethod != "" {
		extra["assetTransferMethod"] = string(config.DefaultAsset.AssetTransferMethod)
	}

	oneUnit := float64(1)
	for i := 0; i < config.DefaultAsset.Decimals; i++ {
		oneUnit *= 10
	}

	if amount >= oneUnit && amount == float64(int64(amount)) {
		return x402.AssetAmount{
			Asset:  config.DefaultAsset.Address,
			Amount: fmt.Sprintf("%.0f", amount),
			Extra:  extra,
		}, nil
	}

	amountStr := fmt.Sprintf("%.6f", amount)
	parsedAmount, err := evm.ParseAmount(amountStr, config.DefaultAsset.Decimals)
	if err != nil {
		return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmt+": %w", err)
	}

	return x402.AssetAmount{
		Asset:  config.DefaultAsset.Address,
		Amount: parsedAmount.String(),
		Extra:  extra,
	}, nil
}
