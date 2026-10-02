// Package server implements the resource-server role of the EVM auth-capture
// scheme: it advertises the escrow payment flow and signs the receiver-authorizer
// Capture/Void EIP-712 messages the facilitator relays onchain.
package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// DefaultCaptureDeadline is how far in the future authorizationExpiry is set
// when Config.CaptureDeadline is zero.
const DefaultCaptureDeadline = 10 * time.Minute

// DefaultRefundDeadline is how far in the future refundExpiry is set when
// Config.RefundDeadline is zero.
const DefaultRefundDeadline = 24 * time.Hour

// Config configures the server-side EVM auth-capture scheme.
type Config struct {
	// ReceiverAuthorizerSigner signs the Capture and Void messages that let the
	// facilitator (the escrow operator) release funds. Required.
	ReceiverAuthorizerSigner evm.ClientEvmSigner

	// CaptureAuthorizer is the escrow operator; empty uses the facilitator's advertised one.
	CaptureAuthorizer string

	// FeeRecipient receives the capture fee; empty uses the facilitator's advertised one.
	FeeRecipient string

	// MinFeeBps and MaxFeeBps bound the capture fee; nil uses the facilitator's advertised
	// value, else 0. With no fee terms the recipient is the zero address and both bounds are 0.
	MinFeeBps *uint16
	MaxFeeBps *uint16

	// CaptureDeadline and RefundDeadline are how long after issuing requirements capture and
	// refund stay possible onchain; zero selects the defaults.
	CaptureDeadline time.Duration
	RefundDeadline  time.Duration

	// Policy is an optional policy contract bound into the payment's salt.
	Policy string

	// AuthCaptureEscrow optionally pins a commerce-payments deployment (v1.0 or v1.1 escrow address).
	AuthCaptureEscrow string
}

// AuthCaptureEvmScheme implements SchemeNetworkServer for EVM auth-capture payments (escrow flow).
type AuthCaptureEvmScheme struct {
	moneyParsers []x402.MoneyParser
	config       *Config
}

// NewAuthCaptureEvmScheme creates a new AuthCaptureEvmScheme.
func NewAuthCaptureEvmScheme(config *Config) *AuthCaptureEvmScheme {
	if config == nil {
		config = &Config{}
	}
	return &AuthCaptureEvmScheme{
		moneyParsers: []x402.MoneyParser{},
		config:       config,
	}
}

// Scheme returns the scheme identifier.
func (s *AuthCaptureEvmScheme) Scheme() string {
	return authcapture.SchemeAuthCapture
}

// DefaultAssetTransferMethod returns the ATM used when extra.assetTransferMethod is absent.
func (s *AuthCaptureEvmScheme) DefaultAssetTransferMethod() string {
	return string(evm.AssetTransferMethodEIP3009)
}

// PaymentFlows declares the escrow flow for both asset transfer methods.
func (s *AuthCaptureEvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	escrowOnly := x402.PaymentFlowConfig{
		Supported: []x402.PaymentFlowName{x402.PaymentFlowEscrow},
		Default:   x402.PaymentFlowEscrow,
	}
	return map[string]x402.PaymentFlowConfig{
		string(evm.AssetTransferMethodEIP3009): escrowOnly,
		string(evm.AssetTransferMethodPermit2): escrowOnly,
	}
}

// ValidateFacilitatorSupport fails startup when no signer or captureAuthorizer is available.
func (s *AuthCaptureEvmScheme) ValidateFacilitatorSupport(
	network x402.Network,
	supportedKind types.SupportedKind,
	_ []string,
) error {
	if s.config.ReceiverAuthorizerSigner == nil {
		return errors.New(ErrMissingReceiverAuthorizerSigner)
	}
	if s.config.CaptureAuthorizer != "" {
		return nil
	}
	if advertised, _ := supportedKind.Extra["captureAuthorizer"].(string); evm.IsValidAddress(advertised) {
		return nil
	}
	return fmt.Errorf(
		"no captureAuthorizer is configured and the facilitator does not advertise one for auth-capture on %s",
		network,
	)
}

// RegisterMoneyParser adds a custom money parser, tried in registration order before the default.
func (s *AuthCaptureEvmScheme) RegisterMoneyParser(parser x402.MoneyParser) *AuthCaptureEvmScheme {
	s.moneyParsers = append(s.moneyParsers, parser)
	return s
}

// ParsePrice converts a price to an asset amount, returning an AssetAmount as-is.
func (s *AuthCaptureEvmScheme) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	if priceMap, ok := price.(map[string]interface{}); ok {
		if amountVal, hasAmount := priceMap["amount"]; hasAmount {
			amountStr, ok := amountVal.(string)
			if !ok {
				return x402.AssetAmount{}, errors.New(ErrAmountMustBeString)
			}

			asset := ""
			if assetVal, ok := priceMap["asset"].(string); ok {
				asset = assetVal
			}
			if asset == "" {
				return x402.AssetAmount{}, errors.New(ErrNoAssetSpecified)
			}

			extra := make(map[string]interface{})
			if extraMap, ok := priceMap["extra"].(map[string]interface{}); ok {
				extra = extraMap
			}

			return x402.AssetAmount{Amount: amountStr, Asset: asset, Extra: extra}, nil
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

func (s *AuthCaptureEvmScheme) defaultMoneyConversion(amount string, network x402.Network, symbol string) (x402.AssetAmount, error) {
	assetInfo, tokenAmount, err := evm.ConvertDefaultMoney(amount, string(network), symbol)
	if err != nil {
		return x402.AssetAmount{}, err
	}
	return x402.AssetAmount{
		Asset:  assetInfo.Asset,
		Amount: tokenAmount,
		Extra:  assetExtra(assetInfo.Name, assetInfo.Version, assetInfo.AssetTransferMethod, assetInfo.SupportsEip2612),
	}, nil
}

// assetExtra returns the asset-derived extra fields. Permit2-only tokens omit the EIP-712
// domain because they never sign an EIP-3009 authorization.
func assetExtra(name, version string, method evm.AssetTransferMethod, supportsEip2612 bool) map[string]interface{} {
	extra := map[string]interface{}{}
	if includesEip712Domain(method, supportsEip2612) {
		extra["name"] = name
		extra["version"] = version
	}
	if method != "" {
		extra["assetTransferMethod"] = string(method)
	}
	return extra
}

func includesEip712Domain(method evm.AssetTransferMethod, supportsEip2612 bool) bool {
	return method == "" || supportsEip2612
}

// EnhancePaymentRequirements resolves the asset and amount and fills in the auth-capture
// extra. Operator and fee terms come from config, then the facilitator's advertised kind.
func (s *AuthCaptureEvmScheme) EnhancePaymentRequirements(
	ctx context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
	if s.config.ReceiverAuthorizerSigner == nil {
		return requirements, errors.New(ErrMissingReceiverAuthorizerSigner)
	}

	networkStr := string(requirements.Network)
	var assetInfo *evm.AssetInfo
	var err error
	if requirements.Asset != "" {
		assetInfo, err = evm.GetAssetInfo(networkStr, requirements.Asset)
	} else {
		assetInfo, err = evm.GetAssetInfo(networkStr, "")
		if err == nil {
			requirements.Asset = assetInfo.Address
		}
	}
	if err != nil {
		return requirements, fmt.Errorf(ErrNoAssetSpecified+": %w", err)
	}

	if requirements.Amount != "" && strings.Contains(requirements.Amount, ".") {
		amount, err := evm.ParseAmount(requirements.Amount, assetInfo.Decimals)
		if err != nil {
			return requirements, fmt.Errorf(ErrFailedToParseAmount+": %w", err)
		}
		requirements.Amount = amount.String()
	}

	extra := make(map[string]interface{}, len(requirements.Extra)+len(supportedKind.Extra)+12)
	for key, value := range supportedKind.Extra {
		extra[key] = value
	}
	for key, value := range requirements.Extra {
		extra[key] = value
	}

	captureAuthorizer := s.config.CaptureAuthorizer
	if captureAuthorizer == "" {
		captureAuthorizer, _ = extra["captureAuthorizer"].(string)
	}
	if !evm.IsValidAddress(captureAuthorizer) {
		return requirements, errors.New(ErrMissingCaptureAuthorizer)
	}
	extra["captureAuthorizer"] = evm.NormalizeAddress(captureAuthorizer)

	feeRecipient, minFeeBps, maxFeeBps, err := s.resolveFeeTerms(extra)
	if err != nil {
		return requirements, err
	}
	extra["feeRecipient"] = feeRecipient
	extra["minFeeBps"] = minFeeBps
	extra["maxFeeBps"] = maxFeeBps

	extra["receiverAuthorizer"] = evm.NormalizeAddress(s.config.ReceiverAuthorizerSigner.Address())
	if s.config.Policy != "" {
		extra["policy"] = evm.NormalizeAddress(s.config.Policy)
	}

	captureDeadline := s.config.CaptureDeadline
	if captureDeadline <= 0 {
		captureDeadline = DefaultCaptureDeadline
	}
	refundDeadline := s.config.RefundDeadline
	if refundDeadline <= 0 {
		refundDeadline = DefaultRefundDeadline
	}
	if timeout := time.Duration(requirements.MaxTimeoutSeconds) * time.Second; timeout > captureDeadline {
		return requirements, fmt.Errorf("%s: maxTimeoutSeconds %d exceeds the capture deadline of %s",
			ErrTimeoutExceedsCaptureDeadline, requirements.MaxTimeoutSeconds, captureDeadline)
	}
	if refundDeadline < captureDeadline {
		return requirements, fmt.Errorf("%s: refund deadline %s is before the capture deadline %s",
			ErrRefundBeforeCaptureDeadline, refundDeadline, captureDeadline)
	}
	now := time.Now()
	extra["captureDeadline"] = uint64(now.Add(captureDeadline).Unix())
	extra["refundDeadline"] = uint64(now.Add(refundDeadline).Unix())

	extra["paymentFlow"] = "escrow"
	extra["captureMode"] = "sync"
	extra["operatorType"] = "delegated"

	if includesEip712Domain(assetInfo.AssetTransferMethod, assetInfo.SupportsEip2612) {
		if _, ok := extra["name"]; !ok {
			extra["name"] = assetInfo.Name
		}
		if _, ok := extra["version"]; !ok {
			extra["version"] = assetInfo.Version
		}
	}

	deployment := authcapture.ResolveAuthCaptureDeployment(s.config.AuthCaptureEscrow)
	if deployment == nil {
		return requirements, fmt.Errorf("invalid configured AuthCaptureEscrow: %s", s.config.AuthCaptureEscrow)
	}
	extra["authCaptureEscrow"] = deployment.Escrow

	for _, key := range extensionKeys {
		if value, ok := supportedKind.Extra[key]; ok {
			extra[key] = value
		}
	}

	requirements.Extra = extra
	return requirements, nil
}

// resolveFeeTerms picks the fee recipient and bounds from config, then the facilitator's
// advertised extra. Absent terms mean no fee: the zero address with 0/0 bounds.
func (s *AuthCaptureEvmScheme) resolveFeeTerms(extra map[string]interface{}) (string, uint16, uint16, error) {
	feeRecipient := s.config.FeeRecipient
	if feeRecipient == "" {
		feeRecipient, _ = extra["feeRecipient"].(string)
	}
	if feeRecipient == "" {
		feeRecipient = authcapture.ZeroAddress
	}
	if !evm.IsValidAddress(feeRecipient) {
		return "", 0, 0, fmt.Errorf("%s: invalid feeRecipient %q", ErrInvalidFeeTerms, feeRecipient)
	}

	minFeeBps := feeBound(s.config.MinFeeBps, extra["minFeeBps"])
	maxFeeBps := feeBound(s.config.MaxFeeBps, extra["maxFeeBps"])
	if minFeeBps > maxFeeBps || maxFeeBps > authcapture.BpsDenominator {
		return "", 0, 0, fmt.Errorf("%s: minFeeBps %d and maxFeeBps %d must satisfy min <= max <= %d",
			ErrInvalidFeeTerms, minFeeBps, maxFeeBps, authcapture.BpsDenominator)
	}
	if !authcapture.IsNonZeroAddress(feeRecipient) && maxFeeBps != 0 {
		return "", 0, 0, errors.New(ErrMissingFeeRecipient)
	}
	return evm.NormalizeAddress(feeRecipient), minFeeBps, maxFeeBps, nil
}

// feeBound returns the configured bound, else the advertised one, else 0.
func feeBound(configured *uint16, advertised interface{}) uint16 {
	if configured != nil {
		return *configured
	}
	bound, _ := authcapture.JSONNumberToUint16(advertised)
	return bound
}
