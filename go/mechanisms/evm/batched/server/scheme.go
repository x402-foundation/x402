package server

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

const (
	ErrAmountMustBeString   = "amount must be a string for batched scheme"
	ErrAssetAddressRequired = "asset address is required for batched scheme"
	ErrFailedToParsePrice   = "failed to parse price"
	ErrUnsupportedPriceType = "unsupported price type"
	ErrFailedToConvertAmt   = "failed to convert amount"
	ErrNoAssetSpecified     = "no asset specified for batched scheme"
	ErrFailedToParseAmount  = "failed to parse amount"
	ErrInvalidPayToAddress  = "invalid payTo address"
	ErrAmountRequired       = "amount is required"
	ErrInvalidAmount        = "invalid amount"
)

// AuthorizerSigner is the interface for the server-controlled receiverAuthorizer key.
// Used for signing refund and claim batch authorizations.
type AuthorizerSigner interface {
	Address() string
	SignTypedData(ctx context.Context, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}) ([]byte, error)
}

// BatchedEvmSchemeConfig configures the batched server scheme.
type BatchedEvmSchemeConfig struct {
	// Storage is the session persistence backend. Defaults to in-memory.
	Storage SessionStorage
	// ReceiverAuthorizerSigner is the server-controlled key for signing refund/claim authorizations.
	ReceiverAuthorizerSigner AuthorizerSigner
	// WithdrawDelay is the withdraw delay in seconds. Defaults to 900 (15 min).
	WithdrawDelay int
}

// BatchedEvmScheme implements SchemeNetworkServer for batched settlement.
type BatchedEvmScheme struct {
	receiverAddress          string
	storage                  SessionStorage
	receiverAuthorizerSigner AuthorizerSigner
	withdrawDelay            int
	moneyParsers             []x402.MoneyParser
}

// NewBatchedEvmScheme creates a new batched server scheme.
func NewBatchedEvmScheme(receiverAddress string, config *BatchedEvmSchemeConfig) *BatchedEvmScheme {
	storage := SessionStorage(nil)
	var authSigner AuthorizerSigner
	withdrawDelay := batched.MinWithdrawDelay

	if config != nil {
		storage = config.Storage
		authSigner = config.ReceiverAuthorizerSigner
		if config.WithdrawDelay > 0 {
			withdrawDelay = config.WithdrawDelay
		}
	}

	if storage == nil {
		storage = NewInMemorySessionStorage()
	}

	return &BatchedEvmScheme{
		receiverAddress:          receiverAddress,
		storage:                  storage,
		receiverAuthorizerSigner: authSigner,
		withdrawDelay:            withdrawDelay,
		moneyParsers:             []x402.MoneyParser{},
	}
}

// Scheme returns the scheme identifier.
func (s *BatchedEvmScheme) Scheme() string {
	return batched.SchemeBatched
}

// GetAssetDecimals implements AssetDecimalsProvider.
func (s *BatchedEvmScheme) GetAssetDecimals(asset string, network x402.Network) int {
	info, err := evm.GetAssetInfo(string(network), asset)
	if err != nil || info == nil {
		return 6
	}
	return info.Decimals
}

// RegisterMoneyParser registers a custom money parser.
func (s *BatchedEvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *BatchedEvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// GetStorage returns the underlying session storage.
func (s *BatchedEvmScheme) GetStorage() SessionStorage {
	return s.storage
}

// GetReceiverAddress returns the receiver address.
func (s *BatchedEvmScheme) GetReceiverAddress() string {
	return s.receiverAddress
}

// GetWithdrawDelay returns the configured withdraw delay.
func (s *BatchedEvmScheme) GetWithdrawDelay() int {
	return s.withdrawDelay
}

// GetReceiverAuthorizerAddress returns the receiver authorizer's address.
func (s *BatchedEvmScheme) GetReceiverAuthorizerAddress() string {
	if s.receiverAuthorizerSigner != nil {
		return s.receiverAuthorizerSigner.Address()
	}
	return ""
}

// ParsePrice parses a price and converts it to an asset amount.
func (s *BatchedEvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
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
func (s *BatchedEvmScheme) EnhancePaymentRequirements(
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

	// Add token domain info
	includeEip712Domain := assetInfo.AssetTransferMethod == "" || assetInfo.SupportsEip2612
	if includeEip712Domain {
		if _, ok := requirements.Extra["name"]; !ok {
			requirements.Extra["name"] = assetInfo.Name
		}
		if _, ok := requirements.Extra["version"]; !ok {
			requirements.Extra["version"] = assetInfo.Version
		}
	}

	// Add batched-specific fields
	if _, ok := requirements.Extra["receiverAuthorizer"]; !ok {
		receiverAuth := s.GetReceiverAuthorizerAddress()
		if receiverAuth != "" {
			requirements.Extra["receiverAuthorizer"] = receiverAuth
		}
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

// GetClaimableVouchers returns voucher claims ready for on-chain settlement.
type GetClaimableVouchersOpts struct {
	IdleSecs int // Filter sessions idle for at least this many seconds
}

func (s *BatchedEvmScheme) GetClaimableVouchers(opts *GetClaimableVouchersOpts) ([]batched.BatchedVoucherClaim, error) {
	sessions, err := s.storage.List()
	if err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	claims := make([]batched.BatchedVoucherClaim, 0)

	for _, session := range sessions {
		// Filter by idle time if specified
		if opts != nil && opts.IdleSecs > 0 {
			idleMs := now - session.LastRequestTimestamp
			if idleMs < int64(opts.IdleSecs)*1000 {
				continue
			}
		}

		// Only include sessions with claimable amount
		signed, _ := new(big.Int).SetString(session.SignedMaxClaimable, 10)
		claimed, _ := new(big.Int).SetString(session.TotalClaimed, 10)
		if signed == nil || claimed == nil {
			continue
		}
		if signed.Cmp(claimed) <= 0 {
			continue
		}

		claims = append(claims, batched.BatchedVoucherClaim{
			Voucher: struct {
				Channel            batched.ChannelConfig `json:"channel"`
				MaxClaimableAmount string                `json:"maxClaimableAmount"`
			}{
				Channel:            session.ChannelConfig,
				MaxClaimableAmount: session.SignedMaxClaimable,
			},
			Signature:    session.Signature,
			TotalClaimed: session.TotalClaimed,
		})
	}

	return claims, nil
}

// GetWithdrawalPendingSessions returns sessions that have a pending withdrawal
// (withdrawRequestedAt > 0).
func (s *BatchedEvmScheme) GetWithdrawalPendingSessions() ([]*ChannelSession, error) {
	sessions, err := s.storage.List()
	if err != nil {
		return nil, err
	}
	var result []*ChannelSession
	for _, session := range sessions {
		if session.WithdrawRequestedAt > 0 {
			result = append(result, session)
		}
	}
	return result, nil
}

// SignRefund signs a cooperative refund EIP-712 message.
func (s *BatchedEvmScheme) SignRefund(ctx context.Context, channelId string, amount string, nonce string, network string) ([]byte, error) {
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
		Name:              batched.BatchSettlementDomain.Name,
		Version:           batched.BatchSettlementDomain.Version,
		ChainID:           chainId,
		VerifyingContract: batched.BatchSettlementAddress,
	}

	allTypes := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"Refund": batched.RefundTypes["Refund"],
	}

	message := map[string]interface{}{
		"channelId": channelIdBytes,
		"nonce":     refundNonce,
		"amount":    refundAmount,
	}

	return s.receiverAuthorizerSigner.SignTypedData(ctx, domain, allTypes, "Refund", message)
}

// SignClaimBatch signs a ClaimBatch EIP-712 message.
func (s *BatchedEvmScheme) SignClaimBatch(ctx context.Context, claims []batched.BatchedVoucherClaim, network string) ([]byte, error) {
	if s.receiverAuthorizerSigner == nil {
		return nil, fmt.Errorf("no receiver authorizer signer configured")
	}

	chainId, err := evm.GetEvmChainId(network)
	if err != nil {
		return nil, err
	}

	domain := evm.TypedDataDomain{
		Name:              batched.BatchSettlementDomain.Name,
		Version:           batched.BatchSettlementDomain.Version,
		ChainID:           chainId,
		VerifyingContract: batched.BatchSettlementAddress,
	}

	allTypes := map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"ClaimBatch": batched.ClaimBatchTypes["ClaimBatch"],
		"ClaimEntry": batched.ClaimBatchTypes["ClaimEntry"],
	}

	entries := make([]map[string]interface{}, len(claims))
	for i, claim := range claims {
		channelId, _ := batched.ComputeChannelId(claim.Voucher.Channel)
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

// CreateChannelManager creates a new channel manager for auto-settlement.
func (s *BatchedEvmScheme) CreateChannelManager(facilitator x402.FacilitatorClient, network x402.Network) *BatchedChannelManager {
	return NewBatchedChannelManager(ChannelManagerConfig{
		Scheme:      s,
		Facilitator: facilitator,
		Network:     network,
	})
}

// UpdateSession updates or creates a session for a channel.
func (s *BatchedEvmScheme) UpdateSession(channelId string, session *ChannelSession) error {
	return s.storage.Set(batched.NormalizeChannelId(channelId), session)
}

// GetSession retrieves a session for a channel.
func (s *BatchedEvmScheme) GetSession(channelId string) (*ChannelSession, error) {
	return s.storage.Get(batched.NormalizeChannelId(channelId))
}

// DeleteSession removes a session for a channel.
func (s *BatchedEvmScheme) DeleteSession(channelId string) error {
	return s.storage.Delete(batched.NormalizeChannelId(channelId))
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

	extra := map[string]interface{}{}
	includeEip712Domain := config.DefaultAsset.AssetTransferMethod == "" || config.DefaultAsset.SupportsEip2612
	if includeEip712Domain {
		extra["name"] = config.DefaultAsset.Name
		extra["version"] = config.DefaultAsset.Version
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
