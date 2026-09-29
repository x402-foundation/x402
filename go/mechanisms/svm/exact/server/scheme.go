package server

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/gagliardetto/solana-go/rpc"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ExactSvmScheme implements the SchemeNetworkServer interface for SVM (Solana) exact payments (V2)
type ExactSvmScheme struct {
	moneyParsers []x402.MoneyParser
	config       *svm.ServerConfig
}

// NewExactSvmScheme creates a new ExactSvmScheme
func NewExactSvmScheme(config ...*svm.ServerConfig) *ExactSvmScheme {
	var cfg *svm.ServerConfig
	if len(config) > 0 {
		cfg = config[0]
	}
	return &ExactSvmScheme{
		moneyParsers: []x402.MoneyParser{},
		config:       cfg,
	}
}

// Scheme returns the scheme identifier
func (s *ExactSvmScheme) Scheme() string {
	return svm.SchemeExact
}

// DefaultAssetTransferMethod returns the SDK ATM sentinel (no on-wire ATM).
func (s *ExactSvmScheme) DefaultAssetTransferMethod() string {
	return x402.SDKDefaultAssetTransferMethod
}

// GetAssetDecimals implements AssetDecimalsProvider. Returns the decimal precision for a
// known default asset. ok is false when the asset is unrecognized.
func (s *ExactSvmScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	found := svm.FindDefaultAsset(asset, string(network))
	if found == nil {
		return 0, false
	}
	return found.Decimals, true
}

// DynamicExtraFields returns extra keys regenerated on each PaymentRequired response.
func (s *ExactSvmScheme) DynamicExtraFields() []string {
	return []string{"recentBlockhash", "lastValidBlockHeight"}
}

// PaymentFlows returns ATM-keyed payment flow support for exact SVM.
func (s *ExactSvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	return map[string]x402.PaymentFlowConfig{
		x402.SDKDefaultAssetTransferMethod: {
			Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization, x402.PaymentFlowUpfront},
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
//	svmServer.RegisterMoneyParser(func(amount string, network x402.Network) (*x402.AssetAmount, error) {
//	    tokenAmount, err := x402.ConvertToTokenAmount(amount, 9)
//	    if err != nil {
//	        return nil, err
//	    }
//	    return &x402.AssetAmount{
//	        Amount: tokenAmount,
//	        Asset:  "CustomTokenMint111111111111111111111",
//	        Extra:  map[string]interface{}{"token": "CUSTOM", "tier": "large"},
//	    }, nil
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

	defaultAsset, err := svm.GetDefaultAsset(networkStr, "")
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

			asset := defaultAsset.Asset
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
			return *result, nil
		}
		// Parser returned nil, try next one
	}

	// All custom parsers returned nil, use default conversion
	return s.defaultMoneyConversion(decimalAmount, network, symbol)
}

// defaultMoneyConversion converts decimal amount to a default-asset AssetAmount
func (s *ExactSvmScheme) defaultMoneyConversion(amount string, network x402.Network, symbol string) (x402.AssetAmount, error) {
	assetInfo, err := svm.GetDefaultAsset(string(network), symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	tokenAmount, err := x402.ConvertToTokenAmount(amount, assetInfo.Decimals)
	if err != nil {
		return x402.AssetAmount{}, fmt.Errorf(ErrFailedToConvertAmount+": %w", err)
	}

	return x402.AssetAmount{
		Amount: tokenAmount,
		Asset:  assetInfo.Asset,
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
	if _, err := svm.NormalizeNetwork(networkStr); err != nil {
		return requirements, err
	}

	// Get asset info
	var assetInfo *svm.AssetInfo
	var err error
	if requirements.Asset != "" {
		assetInfo, err = svm.GetAssetInfo(networkStr, requirements.Asset)
		if err != nil {
			return requirements, err
		}
	} else {
		assetInfo, err = svm.GetAssetInfo(networkStr, "")
		if err != nil {
			return requirements, err
		}
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

	s.enrichRecentBlockhash(ctx, requirements.Extra)

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

func (s *ExactSvmScheme) enrichRecentBlockhash(ctx context.Context, extra map[string]interface{}) {
	if s.config == nil || s.config.RPCURL == "" {
		return
	}

	latestBlockhash, err := rpc.New(s.config.RPCURL).GetLatestBlockhash(ctx, rpc.CommitmentFinalized)
	if err != nil {
		return
	}

	extra["recentBlockhash"] = latestBlockhash.Value.Blockhash.String()
	extra["lastValidBlockHeight"] = strconv.FormatUint(latestBlockhash.Value.LastValidBlockHeight, 10)
}
