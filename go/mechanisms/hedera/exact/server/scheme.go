package server

import (
	"context"
	"errors"
	"fmt"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/hedera"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	ErrAmountMustBeString = "amount must be a string"
	ErrInvalidAsset       = "invalid_hedera_asset"
	ErrNoDefaultAsset     = "no_default_hts_asset"
)

// ExactHederaScheme implements SchemeNetworkServer for Hedera exact (V2).
type ExactHederaScheme struct {
	moneyParsers []x402.MoneyParser
	config       *hedera.ServerConfig
}

// NewExactHederaScheme creates a server-side Hedera exact scheme.
func NewExactHederaScheme(config ...*hedera.ServerConfig) *ExactHederaScheme {
	var cfg *hedera.ServerConfig
	if len(config) > 0 {
		cfg = config[0]
	}
	return &ExactHederaScheme{moneyParsers: []x402.MoneyParser{}, config: cfg}
}

var _ x402.SchemeNetworkServer = (*ExactHederaScheme)(nil)

func (s *ExactHederaScheme) Scheme() string { return hedera.SchemeExact }

func (s *ExactHederaScheme) DefaultAssetTransferMethod() string {
	return x402.SDKDefaultAssetTransferMethod
}

// GetAssetDecimals implements AssetDecimalsProvider for configured and known default assets.
func (s *ExactHederaScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	if cfg := s.defaultAssetFor(string(network)); cfg != nil && cfg.Asset == asset {
		return cfg.Decimals, true
	}
	found := hedera.FindDefaultAsset(asset, string(network))
	if found == nil {
		return 0, false
	}
	return found.Decimals, true
}

func (s *ExactHederaScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	return map[string]x402.PaymentFlowConfig{
		x402.SDKDefaultAssetTransferMethod: {
			Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization, x402.PaymentFlowUpfront},
			Default:   x402.PaymentFlowAuthorization,
		},
	}
}

// RegisterMoneyParser registers a custom money parser (tried in order).
func (s *ExactHederaScheme) RegisterMoneyParser(parser x402.MoneyParser) *ExactHederaScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

func (s *ExactHederaScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	if err := hedera.AssertSupportedNetwork(string(network)); err != nil {
		return x402.AssetAmount{}, err
	}

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
			if asset == "" || !hedera.IsValidAsset(asset) {
				return x402.AssetAmount{}, fmt.Errorf("%s: %v", ErrInvalidAsset, asset)
			}
			extra := make(map[string]interface{})
			if extraVal, hasExtra := priceMap["extra"]; hasExtra {
				if extraMap, ok := extraVal.(map[string]interface{}); ok {
					extra = extraMap
				}
			}
			return x402.AssetAmount{Amount: amountStr, Asset: asset, Extra: extra}, nil
		}
	}

	decimalAmount, _, err := x402.ParseMoney(price)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	for _, parser := range s.moneyParsers {
		parsed, err := parser(decimalAmount, network)
		if err != nil {
			return x402.AssetAmount{}, err
		}
		if parsed != nil {
			return *parsed, nil
		}
	}

	return s.defaultMoneyConversion(decimalAmount, string(network))
}

func (s *ExactHederaScheme) EnhancePaymentRequirements(
	_ context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	_ []string,
) (types.PaymentRequirements, error) {
	if requirements.Extra == nil {
		requirements.Extra = make(map[string]interface{})
	}
	if supportedKind.Extra != nil {
		if feePayer, ok := supportedKind.Extra["feePayer"].(string); ok && feePayer != "" {
			requirements.Extra["feePayer"] = feePayer
		}
	}
	return requirements, nil
}

func (s *ExactHederaScheme) defaultMoneyConversion(amount string, network string) (x402.AssetAmount, error) {
	tokenConfig := s.defaultAssetFor(network)
	if tokenConfig == nil {
		return x402.AssetAmount{}, fmt.Errorf("%s for network %s", ErrNoDefaultAsset, network)
	}
	if !hedera.IsValidAsset(tokenConfig.Asset) || hedera.IsHbarAsset(tokenConfig.Asset) {
		return x402.AssetAmount{}, errors.New("default Hedera asset must be an HTS fungible token ID")
	}
	smallest, err := hedera.ParseAmount(amount, tokenConfig.Decimals)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	return x402.AssetAmount{
		Amount: smallest.String(),
		Asset:  tokenConfig.Asset,
		Extra:  map[string]interface{}{},
	}, nil
}

func (s *ExactHederaScheme) defaultAssetFor(network string) *hedera.DefaultAssetConfig {
	if s.config != nil && s.config.DefaultAssets != nil {
		if cfg, ok := s.config.DefaultAssets[network]; ok {
			return &cfg
		}
	}
	info, err := hedera.GetDefaultAsset(network, "")
	if err != nil {
		return nil
	}
	return &hedera.DefaultAssetConfig{Asset: info.Asset, Decimals: info.Decimals}
}
