// Package server implements the Cardano exact scheme for resource servers.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Config is the optional configuration of the Cardano exact server.
type Config struct {
	// MasumiStorage keeps issued Masumi quotes; defaults to an in-memory store.
	// Multi-instance servers need a shared, atomically updating backend.
	MasumiStorage masumi.TermsStorage
	// Masumi enables issuing seller-signed Masumi quotes.
	Masumi *MasumiIssuerConfig
}

// ExactCardanoScheme implements x402.SchemeNetworkServer for Cardano.
type ExactCardanoScheme struct {
	moneyParsers []x402.MoneyParser
	storage      masumi.TermsStorage
	issuer       *MasumiIssuerConfig
}

// NewExactCardanoScheme creates the server scheme.
func NewExactCardanoScheme(config ...*Config) *ExactCardanoScheme {
	cfg := Config{}
	if len(config) > 0 && config[0] != nil {
		cfg = *config[0]
	}
	if cfg.MasumiStorage == nil {
		storage, err := masumi.NewInMemoryTermsStorage(masumi.DefaultTermsStorageEntries)
		if err != nil {
			panic(err) // unreachable: the default capacity is positive
		}
		cfg.MasumiStorage = storage
	}
	return &ExactCardanoScheme{storage: cfg.MasumiStorage, issuer: cfg.Masumi}
}

// Scheme implements x402.SchemeNetworkServer.
func (s *ExactCardanoScheme) Scheme() string { return cardano.SchemeExact }

// DefaultAssetTransferMethod implements x402.SchemeNetworkServer.
func (s *ExactCardanoScheme) DefaultAssetTransferMethod() string {
	return cardano.AssetTransferMethodDefault
}

// PaymentFlows implements x402.SchemeNetworkServer: every method uses the authorization flow.
func (s *ExactCardanoScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	flow := x402.PaymentFlowConfig{Supported: []x402.PaymentFlowName{x402.PaymentFlowAuthorization}, Default: x402.PaymentFlowAuthorization}
	return map[string]x402.PaymentFlowConfig{
		cardano.AssetTransferMethodDefault: flow,
		cardano.AssetTransferMethodMasumi:  flow,
		cardano.AssetTransferMethodScript:  flow,
	}
}

// RegisterMoneyParser adds a parser tried before the default USDM conversion.
func (s *ExactCardanoScheme) RegisterMoneyParser(parser x402.MoneyParser) *ExactCardanoScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice implements x402.SchemeNetworkServer. An AssetAmount (or its map
// form) must name its asset; money strings use registered parsers, then USDM.
func (s *ExactCardanoScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	if amount, ok, err := assetAmountOf(price); ok || err != nil {
		if err != nil {
			return x402.AssetAmount{}, err
		}
		if amount.Asset == "" {
			return x402.AssetAmount{}, fmt.Errorf("asset unit must be specified for AssetAmount on network %s", network)
		}
		if amount.Extra == nil {
			amount.Extra = map[string]interface{}{}
		}
		return validateAssetAmount(amount, "AssetAmount")
	}
	decimal, symbol, err := x402.ParseMoney(price)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	for _, parser := range s.moneyParsers {
		result, err := parser(decimal, network)
		if err != nil {
			return x402.AssetAmount{}, err
		}
		if result != nil {
			return validateAssetAmount(*result, "Custom money parser result")
		}
	}
	asset, err := cardano.GetDefaultAsset(string(network), symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	tokens, err := x402.ConvertToTokenAmount(decimal, asset.Decimals)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	return validateAssetAmount(x402.AssetAmount{Amount: tokens, Asset: asset.Asset, Extra: map[string]interface{}{}}, "Default money conversion")
}

func assetAmountOf(price x402.Price) (x402.AssetAmount, bool, error) {
	switch v := price.(type) {
	case x402.AssetAmount:
		return v, true, nil
	case *x402.AssetAmount:
		if v == nil {
			return x402.AssetAmount{}, false, nil
		}
		return *v, true, nil
	case map[string]interface{}:
		if _, has := v["amount"]; !has {
			return x402.AssetAmount{}, false, nil
		}
		raw, _ := json.Marshal(v)
		var amount x402.AssetAmount
		if err := json.Unmarshal(raw, &amount); err != nil {
			return x402.AssetAmount{}, true, fmt.Errorf("invalid AssetAmount: %w", err)
		}
		return amount, true, nil
	}
	return x402.AssetAmount{}, false, nil
}

func validateAssetAmount(amount x402.AssetAmount, source string) (x402.AssetAmount, error) {
	if !cardano.IsPositiveCanonicalAmount(amount.Amount) {
		return x402.AssetAmount{}, fmt.Errorf("%s amount must be a positive canonical integer: %s", source, amount.Amount)
	}
	if !cardano.IsCanonicalAsset(amount.Asset) {
		return x402.AssetAmount{}, fmt.Errorf("%s asset must use canonical lowercase Cardano form: %s", source, amount.Asset)
	}
	return amount, nil
}

// GetAssetDecimals implements x402.AssetDecimalsProvider.
func (s *ExactCardanoScheme) GetAssetDecimals(asset string, network x402.Network) (int, bool) {
	if info := cardano.FindDefaultAsset(asset, string(network)); info != nil {
		return info.Decimals, true
	}
	return 0, false
}

// EnhancePaymentRequirements checks the requirements against the facilitator's
// advertised capabilities, restates areFeesSponsored and stores served Masumi
// quotes so the paid retry can be bound to them.
func (s *ExactCardanoScheme) EnhancePaymentRequirements(ctx context.Context, requirements types.PaymentRequirements, supportedKind types.SupportedKind, _ []string) (types.PaymentRequirements, error) {
	if !cardano.IsCardanoNetwork(supportedKind.Network) {
		return requirements, fmt.Errorf("unsupported Cardano network: %s", supportedKind.Network)
	}
	if isMasumiTemplate(requirements.Extra) {
		return requirements, errors.New("masumi requirements must carry seller-signed terms: build the route with MasumiPaymentOption or WrapMasumiTool")
	}
	if err := assertFacilitatorSupports(requirements, supportedKind); err != nil {
		return requirements, err
	}
	extra := make(map[string]interface{}, len(requirements.Extra)+1)
	for k, v := range requirements.Extra {
		extra[k] = v
	}
	if sponsored, ok := supportedKind.Extra["areFeesSponsored"].(bool); ok {
		extra["areFeesSponsored"] = sponsored
	}
	requirements.Extra = extra
	if isMasumiExtra(requirements.Extra) {
		if err := s.storeQuote(ctx, requirements); err != nil {
			return requirements, err
		}
	}
	return requirements, nil
}

func assertFacilitatorSupports(requirements types.PaymentRequirements, supportedKind types.SupportedKind) error {
	if supportedKind.Extra == nil {
		return nil
	}
	method, _ := requirements.Extra["assetTransferMethod"].(string)
	if method == "" {
		method = cardano.AssetTransferMethodDefault
	}
	methods, ok := supportedKind.Extra["assetTransferMethods"].([]interface{})
	if !ok {
		if typed, isStrings := supportedKind.Extra["assetTransferMethods"].([]string); isStrings {
			for _, m := range typed {
				methods = append(methods, m)
			}
		} else {
			return errors.New("cardano facilitator did not advertise assetTransferMethods")
		}
	}
	if !slices.Contains(methods, interface{}(method)) {
		return fmt.Errorf("cardano facilitator does not support assetTransferMethod %s", method)
	}
	policy, ok := cardano.ResolveConfirmationPolicy(requirements.Extra)
	if !ok {
		return errors.New("cardano requirements carry an invalid confirmation policy")
	}
	rangeMap, ok := supportedKind.Extra["l1Confirmations"].(map[string]interface{})
	if !ok {
		return errors.New("cardano facilitator did not advertise an l1Confirmations range")
	}
	minimum, minOK := cardano.IntegerValue(rangeMap["minimum"])
	maximum, maxOK := cardano.IntegerValue(rangeMap["maximum"])
	if !minOK || !maxOK || int64(policy.L1Confirmations) < minimum || int64(policy.L1Confirmations) > maximum {
		return fmt.Errorf("cardano facilitator confirmation range does not include %d", policy.L1Confirmations)
	}
	if method == cardano.AssetTransferMethodMasumi {
		if _, err := masumi.ValidateExtra(requirements.Extra, requirements.Network); err != nil {
			return fmt.Errorf("cardano Masumi requirements are invalid: %w", err)
		}
	}
	return nil
}

func isMasumiExtra(extra map[string]interface{}) bool {
	method, _ := extra["assetTransferMethod"].(string)
	return method == cardano.AssetTransferMethodMasumi
}

func isMasumiTemplate(extra map[string]interface{}) bool {
	_, hasTerms := extra["terms"]
	return isMasumiExtra(extra) && !hasTerms
}
