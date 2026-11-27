package server

import (
	"context"
	"errors"
	"fmt"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ExactEvmScheme implements the SchemeNetworkServer interface for EVM exact payments (V2)
type ExactEvmScheme struct {
	moneyParsers []x402.MoneyParser
}

// NewExactEvmScheme creates a new ExactEvmScheme
func NewExactEvmScheme() *ExactEvmScheme {
	return &ExactEvmScheme{
		moneyParsers: []x402.MoneyParser{},
	}
}

// Scheme returns the scheme identifier
func (s *ExactEvmScheme) Scheme() string {
	return evm.SchemeExact
}

// DefaultAssetTransferMethod returns the ATM used when extra.assetTransferMethod is absent.
func (s *ExactEvmScheme) DefaultAssetTransferMethod() string {
	return string(evm.AssetTransferMethodEIP3009)
}

// PaymentFlows returns ATM-keyed payment flow support for exact EVM.
func (s *ExactEvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	authAndUpfront := x402.PaymentFlowConfig{
		Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization, x402.PaymentFlowUpfront},
		Default:   x402.PaymentFlowAuthorization,
	}
	return map[string]x402.PaymentFlowConfig{
		string(evm.AssetTransferMethodEIP3009): authAndUpfront,
		string(evm.AssetTransferMethodPermit2): authAndUpfront,
	}
}

// GetAssetDecimals implements AssetDecimalsProvider. Returns the decimal precision for a
// known default asset. ok is false when the asset is unrecognized.
func (s *ExactEvmScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	found := evm.FindDefaultAsset(asset, string(network))
	if found == nil {
		return 0, false
	}
	return found.Decimals, true
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
//	evmServer.RegisterMoneyParser(func(amount string, network x402.Network) (*x402.AssetAmount, error) {
//	    tokenAmount, err := x402.ConvertToTokenAmount(amount, 18)
//	    if err != nil {
//	        return nil, err
//	    }
//	    return &x402.AssetAmount{
//	        Amount: tokenAmount,
//	        Asset:  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
//	        Extra:  map[string]interface{}{"token": "DAI"},
//	    }, nil
//	})
func (s *ExactEvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *ExactEvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice parses a price string and converts it to an asset amount (V2)
// If price is already an AssetAmount, an atomic amount must be a uint256 decimal string.
// A dotted amount is left unchanged.
// If price is Money (string | number), parses to decimal and tries custom parsers.
// Falls back to default conversion if all custom parsers return nil.
//
// Args:
//
//	price: The price to parse (can be string, number, or AssetAmount map)
//	network: The network identifier
//
// Returns:
//
//	AssetAmount with amount, asset, and optional extra fields
func (s *ExactEvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	// If already an AssetAmount (map with "amount" and "asset"), validate an atomic amount and return it
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

			parsed := x402.AssetAmount{
				Amount: amountStr,
				Asset:  asset,
				Extra:  extra,
			}
			if err := uint256AmountErrorUnlessDecimal(parsed.Amount); err != nil {
				return x402.AssetAmount{}, err
			}
			return parsed, nil
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
			if err := uint256AmountErrorUnlessDecimal(result.Amount); err != nil {
				return x402.AssetAmount{}, err
			}
			return *result, nil
		}
		// Parser returned nil, try next one
	}

	// All custom parsers returned nil, use default conversion
	parsed, err := s.defaultMoneyConversion(decimalAmount, network, symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	if err := uint256AmountErrorUnlessDecimal(parsed.Amount); err != nil {
		return x402.AssetAmount{}, err
	}
	return parsed, nil
}

func uint256AmountErrorUnlessDecimal(amount string) error {
	if strings.Contains(amount, ".") {
		return nil
	}
	return uint256AmountError(amount)
}

func uint256AmountError(amount string) error {
	if _, ok := evm.ParseUint256String(amount); ok {
		return nil
	}
	return fmt.Errorf("%s: amount must be a uint256 decimal string, got %q", ErrAmountNotUint256, amount)
}

// defaultMoneyConversion converts a decimal amount to an AssetAmount using the default token.
func (s *ExactEvmScheme) defaultMoneyConversion(amount string, network x402.Network, symbol string) (x402.AssetAmount, error) {
	assetInfo, tokenAmount, err := evm.ConvertDefaultMoney(amount, string(network), symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	extra := map[string]interface{}{}
	includeEip712Domain := assetInfo.AssetTransferMethod == "" || assetInfo.SupportsEip2612
	if includeEip712Domain {
		extra["name"] = assetInfo.Name
		extra["version"] = assetInfo.Version
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

// EnhancePaymentRequirements adds scheme-specific enhancements to V2 payment requirements
func (s *ExactEvmScheme) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	networkStr := string(requirements.Network)

	if requirements.Asset == "" {
		assetInfo, err := evm.GetAssetInfo(networkStr, "")
		if err != nil {
			return requirements, fmt.Errorf(ErrNoAssetSpecified+": %w", err)
		}
		requirements.Asset = assetInfo.Address
	}

	// Decimals and EIP-712 domain are only known for default assets; other tokens are left as configured.
	defaultAsset := evm.FindDefaultAsset(requirements.Asset, networkStr)

	// Ensure amount is in the correct format (smallest unit)
	if requirements.Amount != "" && strings.Contains(requirements.Amount, ".") {
		if defaultAsset == nil {
			return requirements, fmt.Errorf("%s: token %s is not a registered asset for network %s; provide amount in atomic units", ErrFailedToParseAmount, requirements.Asset, networkStr)
		}
		amount, err := evm.ParseAmount(requirements.Amount, defaultAsset.Decimals)
		if err != nil {
			return requirements, fmt.Errorf(ErrFailedToParseAmount+": %w", err)
		}
		requirements.Amount = amount.String()
	}

	// Add EIP-3009 specific fields to Extra if not present
	if requirements.Extra == nil {
		requirements.Extra = make(map[string]interface{})
	}

	// EIP-3009 tokens always need name/version; permit2 tokens only if they support EIP-2612
	if defaultAsset != nil && (defaultAsset.AssetTransferMethod == "" || defaultAsset.SupportsEip2612) {
		if _, ok := requirements.Extra["name"]; !ok {
			requirements.Extra["name"] = defaultAsset.Name
		}
		if _, ok := requirements.Extra["version"]; !ok {
			requirements.Extra["version"] = defaultAsset.Version
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

	return requirements, uint256AmountError(requirements.Amount)
}
