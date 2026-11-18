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

// DefaultAssetTransferMethod returns the ATM used when extra.assetTransferMethod is absent.
func (s *UptoEvmScheme) DefaultAssetTransferMethod() string {
	return string(evm.AssetTransferMethodPermit2)
}

// PaymentFlows returns ATM-keyed payment flow support for upto EVM.
func (s *UptoEvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	return map[string]x402.PaymentFlowConfig{
		string(evm.AssetTransferMethodPermit2): {
			Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization},
			Default:   x402.PaymentFlowAuthorization,
		},
	}
}

// GetAssetDecimals implements AssetDecimalsProvider. Returns the decimal precision for a
// known default asset. ok is false when the asset is unrecognized.
func (s *UptoEvmScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	found := evm.FindDefaultAsset(asset, string(network))
	if found == nil {
		return 0, false
	}
	return found.Decimals, true
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

	return s.defaultMoneyConversion(decimalAmount, network, symbol)
}

func (s *UptoEvmScheme) defaultMoneyConversion(amount string, network x402.Network, symbol string) (x402.AssetAmount, error) {
	assetInfo, tokenAmount, err := evm.ConvertDefaultMoney(amount, string(network), symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}

	extra := map[string]interface{}{
		"name":                assetInfo.Name,
		"version":             assetInfo.Version,
		"assetTransferMethod": "permit2",
	}

	return x402.AssetAmount{
		Asset:  assetInfo.Asset,
		Amount: tokenAmount,
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
