package server

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/mechanisms/evm"
	"github.com/coinbase/x402/go/types"
)

// UptoEvmScheme implements the SchemeNetworkServer interface for EVM upto payments (V2).
// Always uses Permit2 (no EIP-3009 path).
type UptoEvmScheme struct {
	moneyParsers []x402.MoneyParser
}

func NewUptoEvmScheme() *UptoEvmScheme {
	return &UptoEvmScheme{
		moneyParsers: []x402.MoneyParser{},
	}
}

func (s *UptoEvmScheme) Scheme() string {
	return evm.SchemeUpto
}

// GetAssetDecimals implements AssetDecimalsProvider. Returns the decimal precision for the
// given asset on the given network, falling back to 6 if the asset is not recognized.
func (s *UptoEvmScheme) GetAssetDecimals(asset string, network x402.Network) int {
	info, err := evm.GetAssetInfo(string(network), asset)
	if err != nil || info == nil {
		return 6
	}
	return info.Decimals
}

func (s *UptoEvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *UptoEvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

func (s *UptoEvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
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

	decimalAmount, err := s.parseMoneyToDecimal(price)
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

	return s.defaultMoneyConversion(decimalAmount, network)
}

func (s *UptoEvmScheme) parseMoneyToDecimal(price x402.Price) (float64, error) {
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

func (s *UptoEvmScheme) defaultMoneyConversion(amount float64, network x402.Network) (x402.AssetAmount, error) {
	networkStr := string(network)

	config, err := evm.GetNetworkConfig(networkStr)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	if config.DefaultAsset.Address == "" {
		return x402.AssetAmount{}, fmt.Errorf("no default stablecoin configured for network %s; use RegisterMoneyParser or specify an explicit AssetAmount", networkStr)
	}

	extra := map[string]interface{}{
		"name":                config.DefaultAsset.Name,
		"version":             config.DefaultAsset.Version,
		"assetTransferMethod": "permit2",
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
		return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", err)
	}

	return x402.AssetAmount{
		Asset:  config.DefaultAsset.Address,
		Amount: parsedAmount.String(),
		Extra:  extra,
	}, nil
}

// EnhancePaymentRequirements adds upto payment requirements.
func (s *UptoEvmScheme) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	networkStr := string(requirements.Network)

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

	// Upto always includes name/version and always sets permit2
	if _, ok := requirements.Extra["name"]; !ok {
		requirements.Extra["name"] = assetInfo.Name
	}
	if _, ok := requirements.Extra["version"]; !ok {
		requirements.Extra["version"] = assetInfo.Version
	}
	requirements.Extra["assetTransferMethod"] = "permit2"

	// Copy facilitatorAddress from supportedKind.Extra if present
	if supportedKind.Extra != nil {
		if facilitatorAddr, ok := supportedKind.Extra["facilitatorAddress"].(string); ok && facilitatorAddr != "" {
			requirements.Extra["facilitatorAddress"] = evm.NormalizeAddress(facilitatorAddr)
		}
	}

	// Copy extensions from supportedKind if provided
	if supportedKind.Extra != nil {
		for _, key := range extensionKeys {
			if val, ok := supportedKind.Extra[key]; ok {
				requirements.Extra[key] = val
			}
		}
	}

	return requirements, nil
}

// ValidatePaymentRequirements validates that requirements are valid for this scheme.
func (s *UptoEvmScheme) ValidatePaymentRequirements(requirements x402.PaymentRequirements) error {
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
		networkStr := string(requirements.Network)
		_, err := evm.GetAssetInfo(networkStr, requirements.Asset)
		if err != nil {
			return fmt.Errorf(ErrInvalidAsset+": %s", requirements.Asset)
		}
	}

	return nil
}
