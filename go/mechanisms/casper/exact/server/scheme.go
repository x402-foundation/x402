package server

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
	"github.com/x402-foundation/x402/go/v2/types"
)

type ExactCasperScheme struct {
	moneyParsers []x402.MoneyParser
}

func NewExactCasperScheme() *ExactCasperScheme {
	return &ExactCasperScheme{}
}

// Scheme returns the scheme identifier
func (s *ExactCasperScheme) Scheme() string {
	return casper.SchemeExact
}

// DefaultAssetTransferMethod returns the SDK ATM sentinel (no on-wire ATM).
func (s *ExactCasperScheme) DefaultAssetTransferMethod() string {
	return x402.SDKDefaultAssetTransferMethod
}

// GetAssetDecimals implements AssetDecimalsProvider. Returns the decimal precision for a
// known default asset. ok is false when the asset is unrecognized.
func (s *ExactCasperScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	found := casper.FindDefaultAsset(asset, string(network))
	if found == nil {
		return 0, false
	}
	return found.Decimals, true
}

// PaymentFlows returns ATM-keyed payment flow support for exact Casper.
func (s *ExactCasperScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	return map[string]x402.PaymentFlowConfig{
		x402.SDKDefaultAssetTransferMethod: {
			Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization},
			Default:   x402.PaymentFlowAuthorization,
		},
	}
}

// RegisterMoneyParser registers a custom money parser in the parser chain.
// Multiple parsers can be registered - they will be tried in registration order.
// Each parser receives a decimal string (e.g., "1.50" for $1.50).
// If a parser returns nil, the next parser in the chain will be tried.
// The default parser is always the final fallback.
//
// Args:
//
//	parser: Custom function to convert amount to AssetAmount (or nil to skip)
//
// Returns:
//
//	The server instance for chaining
//
// Example:
//
//	casperServer.RegisterMoneyParser(func(amount string, network x402.Network) (*x402.AssetAmount, error) {
//	    tokenAmount, err := x402.ConvertToTokenAmount(amount, 9)
//	    if err != nil {
//	        return nil, err
//	    }
//	    return &x402.AssetAmount{
//	        Amount: tokenAmount,
//	        Asset:  "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788",
//	        Extra:  map[string]interface{}{"name": "CustomToken", "version": "1"},
//	    }, nil
//	})
func (s *ExactCasperScheme) RegisterMoneyParser(parser x402.MoneyParser) *ExactCasperScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice parses a price and converts it to an asset amount (V2)
// Explicit asset amounts must be positive U256 integers in atomic units.
// If price is Money (string | number), parses to decimal and tries custom parsers.
// Falls back to default conversion if all custom parsers return nil. Money prices
// that require fractional atomic units are rejected rather than rounded.
//
// Args:
//
//	price: The price to parse (string, number, AssetAmount, or asset/amount map)
//	network: The network identifier
//
// Returns:
//
//	AssetAmount with amount, asset, and optional extra fields
func (s *ExactCasperScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	if amount, ok := price.(x402.AssetAmount); ok {
		if err := validateAssetAmount(amount); err != nil {
			return x402.AssetAmount{}, err
		}
		return amount, nil
	}

	// Handle pre-parsed price object (with amount and asset)
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

			extra := make(map[string]interface{})
			if extraVal, hasExtra := priceMap["extra"]; hasExtra {
				if extraMap, ok := extraVal.(map[string]interface{}); ok {
					extra = extraMap
				}
			}

			result := x402.AssetAmount{
				Amount: amountStr,
				Asset:  asset,
				Extra:  extra,
			}
			if err := validateAssetAmount(result); err != nil {
				return x402.AssetAmount{}, err
			}
			return result, nil
		}
	}

	// Parse Money to a decimal string
	decimalAmount, symbol, err := x402.ParseMoney(price)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	// Try each custom money parser in order
	for _, parser := range s.moneyParsers {
		result, err := parser(decimalAmount, network)
		if err != nil {
			// Parser returned an error, skip it
			continue
		}
		if result != nil {
			// Parser handled the conversion
			if err := validateAssetAmount(*result); err != nil {
				return x402.AssetAmount{}, err
			}
			return *result, nil
		}
		// Parser returned nil, try next one
	}

	// All custom parsers returned nil, use default conversion
	return s.defaultMoneyConversion(decimalAmount, network, symbol)
}

// defaultMoneyConversion converts decimal amount to a default-asset AssetAmount
func (s *ExactCasperScheme) defaultMoneyConversion(amount string, network x402.Network, symbol string) (x402.AssetAmount, error) {
	assetInfo, err := casper.GetDefaultAsset(string(network), symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	if assetInfo.Decimals < 0 || assetInfo.Decimals > 255 {
		return x402.AssetAmount{}, fmt.Errorf("%s: token decimals must be between 0 and 255", ErrFailedToConvertAmount)
	}
	if _, fraction, _ := strings.Cut(amount, "."); len(strings.TrimRight(fraction, "0")) > assetInfo.Decimals {
		return x402.AssetAmount{}, fmt.Errorf("%s: price requires fractional atomic units", ErrFailedToConvertAmount)
	}

	tokenAmount, err := x402.ConvertToTokenAmount(amount, assetInfo.Decimals)
	if err != nil {
		return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", err)
	}

	result := x402.AssetAmount{
		Amount: tokenAmount,
		Asset:  assetInfo.Asset,
		Extra: map[string]interface{}{
			"decimals": assetInfo.Decimals,
			"name":     assetInfo.Name,
			"version":  assetInfo.Version,
		},
	}
	if err := validateAssetAmount(result); err != nil {
		return x402.AssetAmount{}, err
	}
	return result, nil
}

func validateAssetAmount(amount x402.AssetAmount) error {
	if !casper.IsValidContractPackageHash(amount.Asset) {
		return fmt.Errorf("%s: %s", ErrInvalidAsset, amount.Asset)
	}
	value, ok := new(big.Int).SetString(amount.Amount, 10)
	if !ok || value.Sign() <= 0 || value.BitLen() > 256 || strings.HasPrefix(amount.Amount, "+") {
		return fmt.Errorf("%s: amount must be a positive U256 integer in atomic units", ErrFailedToParseAmount)
	}
	return nil
}

// EnhancePaymentRequirements adds scheme-specific enhancements to V2 payment requirements
func (s *ExactCasperScheme) EnhancePaymentRequirements(
	_ context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	networkStr := string(requirements.Network)

	// No asset specified: use the network's default asset
	if requirements.Asset == "" {
		assetInfo, err := casper.GetAssetInfo(networkStr, "")
		if err != nil {
			return requirements, fmt.Errorf("%s: %w", ErrNoDefaultAsset, err)
		}
		requirements.Asset = assetInfo.Asset
	}

	// Convert a decimal amount to atomic units. Only registered assets have known
	// decimals; custom assets must be priced in atomic units.
	if strings.Contains(requirements.Amount, ".") {
		assetInfo, err := casper.GetAssetInfo(networkStr, requirements.Asset)
		if err != nil {
			return requirements, fmt.Errorf("%s: %w", ErrFailedToParseAmount, err)
		}
		amount, err := casper.ParseAmount(requirements.Amount, assetInfo.Decimals)
		if err != nil {
			return requirements, fmt.Errorf("%s: %w", ErrFailedToParseAmount, err)
		}
		requirements.Amount = strconv.FormatUint(amount, 10)
	}

	if err := validateAssetAmount(x402.AssetAmount{Asset: requirements.Asset, Amount: requirements.Amount}); err != nil {
		return requirements, err
	}

	if !casper.IsValidAddress(requirements.PayTo) {
		return requirements, fmt.Errorf("%s: %s", ErrInvalidPayTo, requirements.PayTo)
	}

	if requirements.Extra == nil {
		requirements.Extra = make(map[string]interface{})
	}

	// Registered assets supply their CEP-3009 EIP-712 domain when it is not given
	if defaultAsset := casper.FindDefaultAsset(requirements.Asset, networkStr); defaultAsset != nil {
		if name, ok := requirements.Extra["name"].(string); !ok || name == "" {
			requirements.Extra["name"] = defaultAsset.Name
		}
		if version, ok := requirements.Extra["version"].(string); !ok || version == "" {
			requirements.Extra["version"] = defaultAsset.Version
		}
	}

	if name, ok := requirements.Extra["name"].(string); !ok || name == "" {
		return requirements, errors.New(ErrMissingTokenName)
	}
	if version, ok := requirements.Extra["version"].(string); !ok || version == "" {
		return requirements, errors.New(ErrMissingTokenVersion)
	}

	if supportedKind.Extra != nil {
		for _, key := range extensionKeys {
			if value, ok := supportedKind.Extra[key]; ok {
				requirements.Extra[key] = value
			}
		}
	}

	return requirements, nil
}
