package server

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/types"
)

// AuthCaptureEvmScheme implements the SchemeNetworkServer interface for EVM authCapture payments.
type AuthCaptureEvmScheme struct {
	moneyParsers []x402.MoneyParser
}

// NewAuthCaptureEvmScheme creates a new AuthCaptureEvmScheme.
func NewAuthCaptureEvmScheme() *AuthCaptureEvmScheme {
	return &AuthCaptureEvmScheme{
		moneyParsers: []x402.MoneyParser{},
	}
}

// Scheme returns the scheme identifier.
func (s *AuthCaptureEvmScheme) Scheme() string {
	return evm.SchemeAuthCapture
}

// RegisterMoneyParser registers a custom money parser in the parser chain.
func (s *AuthCaptureEvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *AuthCaptureEvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice parses a price string and converts it to an asset amount.
// If price is already an AssetAmount, returns it directly.
// If price is Money (string | number), parses to decimal and tries custom parsers.
// Falls back to default conversion if all custom parsers return nil.
func (s *AuthCaptureEvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	// If already an AssetAmount (map with "amount" and "asset"), return it directly
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

	// Parse Money to decimal number
	decimalAmount, err := s.parseMoneyToDecimal(price)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	// Try each custom money parser in order
	for _, parser := range s.moneyParsers {
		result, err := parser(decimalAmount, network)
		if err != nil {
			continue
		}
		if result != nil {
			return *result, nil
		}
	}

	// All custom parsers returned nil; use default conversion
	return s.defaultMoneyConversion(decimalAmount, network)
}

// parseMoneyToDecimal converts Money (string | number) to decimal amount.
func (s *AuthCaptureEvmScheme) parseMoneyToDecimal(price x402.Price) (float64, error) {
	switch v := price.(type) {
	case string:
		cleanPrice := strings.TrimSpace(v)
		cleanPrice = strings.TrimPrefix(cleanPrice, "$")
		cleanPrice = strings.TrimSuffix(cleanPrice, " USD")
		cleanPrice = strings.TrimSuffix(cleanPrice, " USDC")
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

// defaultMoneyConversion converts decimal amount to USDC AssetAmount.
func (s *AuthCaptureEvmScheme) defaultMoneyConversion(amount float64, network x402.Network) (x402.AssetAmount, error) {
	networkStr := string(network)

	config, err := evm.GetNetworkConfig(networkStr)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	oneUnit := float64(1)
	for i := 0; i < config.DefaultAsset.Decimals; i++ {
		oneUnit *= 10
	}

	if amount >= oneUnit && amount == float64(int64(amount)) {
		return x402.AssetAmount{
			Asset:  config.DefaultAsset.Address,
			Amount: fmt.Sprintf("%.0f", amount),
			Extra:  make(map[string]interface{}),
		}, nil
	}

	amountStr := fmt.Sprintf("%.6f", amount)
	parsedAmount, err := evm.ParseAmount(amountStr, config.DefaultAsset.Decimals)
	if err != nil {
		return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", err)
	}

	return x402.AssetAmount{
		Asset:  config.DefaultAsset.Address,
		Amount: parsedAmount.String(),
		Extra:  make(map[string]interface{}),
	}, nil
}

// EnhancePaymentRequirements adds authCapture-specific enhancements to payment requirements.
// Validates that all required authCapture extra fields are present and applies defaults.
func (s *AuthCaptureEvmScheme) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	networkStr := string(requirements.Network)

	// Resolve asset info
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

	if requirements.Extra == nil {
		requirements.Extra = make(map[string]interface{})
	}

	// Add EIP-712 domain fields for ERC-3009 signing
	if _, ok := requirements.Extra["name"]; !ok {
		requirements.Extra["name"] = assetInfo.Name
	}
	if _, ok := requirements.Extra["version"]; !ok {
		requirements.Extra["version"] = assetInfo.Version
	}

	// Copy extension keys from supportedKind.Extra
	if supportedKind.Extra != nil {
		for _, key := range extensionKeys {
			if val, ok := supportedKind.Extra[key]; ok {
				requirements.Extra[key] = val
			}
		}
	}

	// Validate required authCapture extra fields
	if _, ok := requirements.Extra["captureAuthorizer"]; !ok {
		return requirements, errors.New(ErrMissingCaptureAuthorizer)
	}
	if _, ok := requirements.Extra["captureDeadline"]; !ok {
		return requirements, errors.New(ErrMissingCaptureDeadline)
	}
	if _, ok := requirements.Extra["refundDeadline"]; !ok {
		return requirements, errors.New(ErrMissingRefundDeadline)
	}
	if _, ok := requirements.Extra["feeRecipient"]; !ok {
		return requirements, errors.New(ErrMissingFeeRecipient)
	}
	if _, ok := requirements.Extra["minFeeBps"]; !ok {
		return requirements, errors.New(ErrMissingMinFeeBps)
	}
	if _, ok := requirements.Extra["maxFeeBps"]; !ok {
		return requirements, errors.New(ErrMissingMaxFeeBps)
	}

	// Validate deadline ordering if both are present as numeric types
	captureDeadline, cErr := toUint48(requirements.Extra["captureDeadline"])
	refundDeadline, rErr := toUint48(requirements.Extra["refundDeadline"])
	if cErr != nil {
		return requirements, errors.New(ErrInvalidCaptureDeadline)
	}
	if rErr != nil {
		return requirements, errors.New(ErrInvalidRefundDeadline)
	}
	if refundDeadline < captureDeadline {
		return requirements, errors.New(ErrInvalidDeadlineOrdering)
	}

	return requirements, nil
}

// ValidatePaymentRequirements validates that requirements are valid for this scheme.
func (s *AuthCaptureEvmScheme) ValidatePaymentRequirements(requirements x402.PaymentRequirements) error {
	if !evm.IsValidAddress(requirements.PayTo) {
		return fmt.Errorf(ErrInvalidPayToAddress+": %s", requirements.PayTo)
	}

	if requirements.Amount == "" {
		return errors.New(ErrAmountRequired)
	}

	amount, ok := new(big.Int).SetString(requirements.Amount, 10)
	if !ok || amount.Sign() <= 0 {
		return fmt.Errorf(ErrInvalidAmount+": %s", requirements.Amount)
	}

	if requirements.Asset != "" && !evm.IsValidAddress(requirements.Asset) {
		return fmt.Errorf(ErrInvalidAsset+": %s", requirements.Asset)
	}

	return nil
}

// toUint48 converts an interface{} extra field value to uint64 (uint48 on-chain).
func toUint48(v interface{}) (uint64, error) {
	switch t := v.(type) {
	case float64:
		if t < 0 {
			return 0, fmt.Errorf("negative value")
		}
		return uint64(t), nil
	case int64:
		if t < 0 {
			return 0, fmt.Errorf("negative value")
		}
		return uint64(t), nil
	case int:
		if t < 0 {
			return 0, fmt.Errorf("negative value")
		}
		return uint64(t), nil
	case uint64:
		return t, nil
	default:
		return 0, fmt.Errorf("unsupported type %T", v)
	}
}
