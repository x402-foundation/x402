package server

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/svm"
	"github.com/x402-foundation/x402/go/types"
)

// ExactSvmScheme implements the SchemeNetworkServer interface for SVM (Solana) exact payments (V2)
type ExactSvmScheme struct {
	moneyParsers []x402.MoneyParser
}

// NewExactSvmScheme creates a new ExactSvmScheme
func NewExactSvmScheme() *ExactSvmScheme {
	return &ExactSvmScheme{
		moneyParsers: []x402.MoneyParser{},
	}
}

// Scheme returns the scheme identifier
func (s *ExactSvmScheme) Scheme() string {
	return svm.SchemeExact
}

// RegisterMoneyParser registers a custom money parser in the parser chain.
// Multiple parsers can be registered - they will be tried in registration order.
// Each parser receives a decimal amount (e.g., 1.50 for $1.50).
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
//	svmServer.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
//	    // Use custom token for large amounts
//	    if amount > 100 {
//	        return &x402.AssetAmount{
//	            Amount: fmt.Sprintf("%.0f", amount * 1e9),
//	            Asset:  "CustomTokenMint111111111111111111111",
//	            Extra:  map[string]interface{}{"token": "CUSTOM", "tier": "large"},
//	        }, nil
//	    }
//	    return nil, nil // Use next parser
//	})
func (s *ExactSvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *ExactSvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice parses a price and converts it to an asset amount (V2)
// If price is already an AssetAmount, returns it directly.
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
func (s *ExactSvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	networkStr := string(network)

	// Get network config to determine the default asset
	config, err := svm.GetNetworkConfig(networkStr)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	// Handle pre-parsed price object (with amount and asset)
	if priceMap, ok := price.(map[string]interface{}); ok {
		if amountVal, hasAmount := priceMap["amount"]; hasAmount {
			amountStr, ok := amountVal.(string)
			if !ok {
				return x402.AssetAmount{}, errors.New(ErrAmountMustBeString)
			}

			asset := config.DefaultAsset.Address
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
			// Parser returned an error, skip it
			continue
		}
		if result != nil {
			// Parser handled the conversion
			return *result, nil
		}
		// Parser returned nil, try next one
	}

	// All custom parsers returned nil, use default conversion
	return s.defaultMoneyConversion(decimalAmount, config)
}

// parseMoneyToDecimal converts Money (string | number) to decimal amount
func (s *ExactSvmScheme) parseMoneyToDecimal(price x402.Price) (float64, error) {
	// Handle string prices
	if priceStr, ok := price.(string); ok {
		// Remove $ sign and currency identifiers
		cleanPrice := strings.TrimSpace(priceStr)
		cleanPrice = strings.TrimPrefix(cleanPrice, "$")
		cleanPrice = strings.TrimSpace(cleanPrice)

		// Check if it contains a currency/asset identifier
		parts := strings.Fields(cleanPrice)
		if len(parts) >= 1 {
			// Use the first part as the amount
			amount, err := strconv.ParseFloat(parts[0], 64)
			if err != nil {
				return 0, fmt.Errorf(ErrFailedToParsePrice+": '%s': %w", priceStr, err)
			}
			return amount, nil
		}
	}

	// Handle number input
	switch v := price.(type) {
	case float64:
		return v, nil
	case int:
		return float64(v), nil
	case int64:
		return float64(v), nil
	}

	return 0, fmt.Errorf(ErrInvalidPriceFormat+": %v", price)
}

// defaultMoneyConversion converts decimal amount to USDC AssetAmount
func (s *ExactSvmScheme) defaultMoneyConversion(amount float64, config *svm.NetworkConfig) (x402.AssetAmount, error) {
	// Convert decimal to smallest unit (e.g., $1.50 -> 1500000 for USDC with 6 decimals)
	amountStr := fmt.Sprintf("%.6f", amount)
	parsedAmount, err := svm.ParseAmount(amountStr, config.DefaultAsset.Decimals)
	if err != nil {
		return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", err)
	}

	return x402.AssetAmount{
		Amount: strconv.FormatUint(parsedAmount, 10),
		Asset:  config.DefaultAsset.Address,
		Extra:  make(map[string]interface{}),
	}, nil
}

// EnhancePaymentRequirements adds scheme-specific enhancements to V2 payment requirements
func (s *ExactSvmScheme) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	// Mark unused parameter
	_ = ctx

	// Get network config
	networkStr := string(requirements.Network)
	config, err := svm.GetNetworkConfig(networkStr)
	if err != nil {
		return requirements, err
	}

	// Get asset info
	var assetInfo *svm.AssetInfo
	if requirements.Asset != "" {
		assetInfo, err = svm.GetAssetInfo(networkStr, requirements.Asset)
		if err != nil {
			return requirements, err
		}
	} else {
		// Use default asset if not specified
		assetInfo = &config.DefaultAsset
		requirements.Asset = assetInfo.Address
	}

	// Ensure amount is in the correct format (smallest unit)
	if requirements.Amount != "" && strings.Contains(requirements.Amount, ".") {
		// Convert decimal to smallest unit
		amount, err := svm.ParseAmount(requirements.Amount, assetInfo.Decimals)
		if err != nil {
			return requirements, fmt.Errorf(ErrFailedToParseAmount+": %w", err)
		}
		requirements.Amount = strconv.FormatUint(amount, 10)
	}

	// Initialize extra map if needed
	if requirements.Extra == nil {
		requirements.Extra = make(map[string]interface{})
	}

	// Add feePayer from supportedKind.extra to payment requirements
	// The facilitator provides its address as the fee payer for transaction fees
	if supportedKind.Extra != nil {
		if feePayer, ok := supportedKind.Extra["feePayer"]; ok {
			requirements.Extra["feePayer"] = feePayer
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
