// Package server implements the resource-server role of the EVM auth-capture scheme: it
// advertises the escrow and authorization payment flows, signs the receiver-authorizer
// Capture/Void/Charge/Refund EIP-712 messages the facilitator relays onchain, and records
// authorized payments so a deferred capture, void or refund can happen after the request.
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
	// ReceiverAuthorizerSigner signs the Capture, Void, Charge and Refund messages that let the
	// facilitator release funds. Without it a route's receiverAuthorizer is delegated to the
	// facilitator, which signs the unsigned payloads after authenticating the caller, or is the
	// zero address for a collect-only route.
	ReceiverAuthorizerSigner evm.ClientEvmSigner

	// CollectOnlyRoutes skips the startup check that the facilitator advertises
	// extra.receiverAuthorizer when no ReceiverAuthorizerSigner is configured. Use it only when
	// every route is collect-only (escrow + deferred + explicit receiverAuthorizer of the zero address).
	CollectOnlyRoutes bool

	// CaptureAuthorizer is the default escrow operator for every route, which a route's own
	// extra.captureAuthorizer overrides. A delegated route falls back to the facilitator's
	// advertised operator, a custom route has no fallback.
	CaptureAuthorizer string

	// FeeRecipient receives the fee; empty uses the facilitator's advertised one.
	FeeRecipient string

	// MinFeeBps and MaxFeeBps bound the fee; nil uses the facilitator's advertised value,
	// else 0. With no fee terms the recipient is the zero address and both bounds are 0.
	MinFeeBps *uint16
	MaxFeeBps *uint16

	// CaptureDeadline and RefundDeadline are how long after issuing requirements capture and
	// refund stay possible onchain, used when a route sets no deadlines; zero selects the defaults.
	CaptureDeadline time.Duration
	RefundDeadline  time.Duration

	// Policy is an optional policy contract bound into the payment's salt.
	Policy string

	// AuthCaptureEscrow optionally pins a commerce-payments deployment (v1.0 or v1.1 escrow address).
	AuthCaptureEscrow string

	// Storage records authorized payments for later capture, void and refund; nil keeps them in memory.
	Storage AuthorizedPaymentStorage
}

// AuthCaptureEvmScheme implements SchemeNetworkServer for EVM auth-capture payments.
type AuthCaptureEvmScheme struct {
	moneyParsers []x402.MoneyParser
	config       *Config
	storage      AuthorizedPaymentStorage
}

// NewAuthCaptureEvmScheme creates a new AuthCaptureEvmScheme.
func NewAuthCaptureEvmScheme(config *Config) *AuthCaptureEvmScheme {
	if config == nil {
		config = &Config{}
	}
	storage := config.Storage
	if storage == nil {
		storage = NewInMemoryAuthorizedPaymentStorage()
	}
	return &AuthCaptureEvmScheme{
		moneyParsers: []x402.MoneyParser{},
		config:       config,
		storage:      storage,
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

// DynamicExtraFields lists the extra keys regenerated on every 402, so a payment signed against an
// earlier 402 still matches the route.
func (s *AuthCaptureEvmScheme) DynamicExtraFields() []string {
	return []string{"captureDeadline", "refundDeadline"}
}

// PaymentFlows declares the escrow and authorization flows for both asset transfer methods.
func (s *AuthCaptureEvmScheme) PaymentFlows() map[string]x402.PaymentFlowConfig {
	both := x402.PaymentFlowConfig{
		Supported: []x402.PaymentFlowName{x402.PaymentFlowEscrow, x402.PaymentFlowAuthorization},
		Default:   x402.PaymentFlowEscrow,
	}
	return map[string]x402.PaymentFlowConfig{
		string(evm.AssetTransferMethodEIP3009): both,
		string(evm.AssetTransferMethodPermit2): both,
	}
}

// Storage returns the authorized-payment storage backend.
func (s *AuthCaptureEvmScheme) Storage() AuthorizedPaymentStorage {
	return s.storage
}

// ValidateFacilitatorSupport fails startup when the facilitator advertises no usable
// captureAuthorizer, or when this server delegates receiver signing but the facilitator does not
// advertise a non-zero receiverAuthorizer. A facilitator that admits custom operators lets a
// server run without a captureAuthorizer, because its routes then name their own operator.
func (s *AuthCaptureEvmScheme) ValidateFacilitatorSupport(
	network x402.Network,
	supportedKind types.SupportedKind,
	_ []string,
) error {
	customOperators := supportedKind.Extra["operators"] != nil
	if s.config.CaptureAuthorizer == "" && !customOperators {
		advertised, _ := supportedKind.Extra["captureAuthorizer"].(string)
		if !authcapture.IsNonZeroAddress(advertised) {
			return fmt.Errorf(
				"no captureAuthorizer is configured and the facilitator does not advertise one for auth-capture on %s",
				network,
			)
		}
	}

	if s.config.ReceiverAuthorizerSigner != nil || s.config.CollectOnlyRoutes {
		return nil
	}
	advertised, _ := supportedKind.Extra["receiverAuthorizer"].(string)
	if !authcapture.IsNonZeroAddress(advertised) {
		return fmt.Errorf(
			"no ReceiverAuthorizerSigner is configured and the facilitator does not advertise a "+
				"receiverAuthorizer on %s. Configure a ReceiverAuthorizerSigner, use a facilitator that "+
				"advertises one, or set CollectOnlyRoutes when every route is collect-only "+
				"(escrow + deferred + extra.receiverAuthorizer of the zero address)",
			network,
		)
	}
	return nil
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

// EnhancePaymentRequirements resolves the asset and amount and builds the auth-capture extra. A term
// the route sets wins over Config, which wins over the facilitator's advertised kind, and a route
// that cannot work fails here rather than at the first payment.
func (s *AuthCaptureEvmScheme) EnhancePaymentRequirements(
	_ context.Context,
	requirements types.PaymentRequirements,
	supportedKind types.SupportedKind,
	extensionKeys []string,
) (types.PaymentRequirements, error) {
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

	route, advertised := requirements.Extra, supportedKind.Extra
	extra := overlay(advertised, route)
	delete(extra, "operators")
	delete(extra, "captureDeadlineSeconds")
	delete(extra, "refundDeadlineSeconds")
	if _, removed := extra["autoCapture"]; removed {
		return requirements, fmt.Errorf("%s: use extra.paymentFlow instead", ErrAutoCaptureRemoved)
	}

	terms, err := resolveTerms(extra)
	if err != nil {
		return requirements, err
	}
	captureAuthorizer, err := s.resolveCaptureAuthorizer(route, advertised, terms.operatorType)
	if err != nil {
		return requirements, err
	}
	if terms.operatorType == authcapture.OperatorTypeCustom {
		if err := checkOperatorAdmitted(advertised, captureAuthorizer); err != nil {
			return requirements, err
		}
	}
	feeRecipient, minFeeBps, maxFeeBps, err := s.resolveFeeTerms(route, advertised)
	if err != nil {
		return requirements, err
	}
	receiverAuthorizer, err := s.resolveReceiverAuthorizer(route, advertised, terms)
	if err != nil {
		return requirements, err
	}
	policy, err := routeAddress(route, "policy")
	if err != nil {
		return requirements, err
	}
	captureDeadline, refundDeadline, err := s.resolveDeadlines(route, requirements.MaxTimeoutSeconds, time.Now())
	if err != nil {
		return requirements, err
	}

	extra["captureAuthorizer"] = captureAuthorizer
	extra["feeRecipient"] = feeRecipient
	extra["minFeeBps"] = minFeeBps
	extra["maxFeeBps"] = maxFeeBps
	extra["receiverAuthorizer"] = receiverAuthorizer
	if policy = firstNonEmpty(policy, s.config.Policy); policy != "" {
		extra["policy"] = evm.NormalizeAddress(policy)
	}
	extra["captureDeadline"] = captureDeadline
	extra["refundDeadline"] = refundDeadline
	extra["paymentFlow"] = terms.paymentFlow
	extra["operatorType"] = terms.operatorType
	if terms.captureMode != "" {
		extra["captureMode"] = terms.captureMode
	}

	if includesEip712Domain(assetInfo.AssetTransferMethod, assetInfo.SupportsEip2612) {
		if _, ok := extra["name"]; !ok {
			extra["name"] = assetInfo.Name
		}
		if _, ok := extra["version"]; !ok {
			extra["version"] = assetInfo.Version
		}
	}

	escrow, _ := extra["authCaptureEscrow"].(string)
	if escrow == "" {
		escrow = s.config.AuthCaptureEscrow
	}
	deployment := authcapture.ResolveAuthCaptureDeployment(escrow)
	if deployment == nil {
		return requirements, fmt.Errorf("invalid configured AuthCaptureEscrow: %s", escrow)
	}
	extra["authCaptureEscrow"] = deployment.Escrow

	for _, key := range extensionKeys {
		if value, ok := advertised[key]; ok {
			extra[key] = value
		}
	}

	requirements.Extra = extra
	return requirements, nil
}
