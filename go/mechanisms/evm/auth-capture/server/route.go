package server

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
)

// deadlineBucketSeconds aligns relative deadlines so 402s issued in the same minute share them.
const deadlineBucketSeconds = 60

// maxExpiry is the largest value a uint48 escrow expiry holds.
const maxExpiry = uint64(1)<<48 - 1

// AuthCaptureRouteExtra is the typed form of a route's auth-capture extra. Pass Map() as the
// route's extra. A field left unset falls back to Config, then to the facilitator's advertised terms.
type AuthCaptureRouteExtra struct {
	// PaymentFlow is "escrow" (default) or "authorization".
	PaymentFlow string `json:"paymentFlow,omitempty"`
	// CaptureMode is "sync" (default) or "deferred" and only applies to the escrow flow.
	CaptureMode string `json:"captureMode,omitempty"`
	// OperatorType is "delegated" (default) or "custom".
	OperatorType string `json:"operatorType,omitempty"`

	CaptureAuthorizer  string  `json:"captureAuthorizer,omitempty"`
	ReceiverAuthorizer string  `json:"receiverAuthorizer,omitempty"`
	FeeRecipient       string  `json:"feeRecipient,omitempty"`
	MinFeeBps          *uint16 `json:"minFeeBps,omitempty"`
	MaxFeeBps          *uint16 `json:"maxFeeBps,omitempty"`
	Policy             string  `json:"policy,omitempty"`

	// CaptureDeadline and RefundDeadline are absolute Unix seconds, the Seconds variants offsets
	// from issue time. Set both of one form, never a mix.
	CaptureDeadline        *uint64 `json:"captureDeadline,omitempty"`
	RefundDeadline         *uint64 `json:"refundDeadline,omitempty"`
	CaptureDeadlineSeconds *uint64 `json:"captureDeadlineSeconds,omitempty"`
	RefundDeadlineSeconds  *uint64 `json:"refundDeadlineSeconds,omitempty"`

	AssetTransferMethod string `json:"assetTransferMethod,omitempty"`
	AuthCaptureEscrow   string `json:"authCaptureEscrow,omitempty"`
}

// Map returns the extra as the untyped map route configuration takes.
func (e AuthCaptureRouteExtra) Map() map[string]interface{} {
	encoded, err := json.Marshal(e)
	if err != nil {
		return nil
	}
	var out map[string]interface{}
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil
	}
	return out
}

func routeError(format string, args ...interface{}) error {
	return fmt.Errorf("%s: %s", ErrInvalidRouteExtra, fmt.Sprintf(format, args...))
}

func overlay(base, over map[string]interface{}) map[string]interface{} {
	merged := make(map[string]interface{}, len(base)+len(over))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range over {
		merged[key] = value
	}
	return merged
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// choice reads a string-enum key, treating an absent or empty value as fallback.
func choice(extra map[string]interface{}, key, fallback string, allowed ...string) (string, error) {
	raw, set := extra[key]
	if !set || raw == nil || raw == "" {
		return fallback, nil
	}
	if value, ok := raw.(string); ok && slices.Contains(allowed, value) {
		return value, nil
	}
	return "", routeError("extra.%s must be one of %s, got %v", key, strings.Join(allowed, ", "), raw)
}

// routeAddress reads an optional address key, "" when absent.
func routeAddress(route map[string]interface{}, key string) (string, error) {
	raw, set := route[key]
	if !set || raw == nil || raw == "" {
		return "", nil
	}
	if value, ok := raw.(string); ok && evm.IsValidAddress(value) {
		return value, nil
	}
	return "", routeError("extra.%s must be an address, got %v", key, raw)
}

// routeBps reads an optional fee bound, reporting whether the route set it.
func routeBps(route map[string]interface{}, key string) (uint16, bool, error) {
	raw, set := route[key]
	if !set || raw == nil {
		return 0, false, nil
	}
	bound, ok := authcapture.JSONNumberToUint16(raw)
	if !ok {
		return 0, false, fmt.Errorf("%s: extra.%s must be an integer of basis points, got %v", ErrInvalidFeeTerms, key, raw)
	}
	return bound, true, nil
}

// resolvedTerms are a route's validated flow decisions.
type resolvedTerms struct {
	paymentFlow  string
	captureMode  string
	operatorType string
}

// resolveTerms validates the route's payment flow, capture mode and operator type.
func resolveTerms(merged map[string]interface{}) (resolvedTerms, error) {
	var terms resolvedTerms
	var err error
	if terms.paymentFlow, err = choice(merged, "paymentFlow", authcapture.PaymentFlowEscrow,
		authcapture.PaymentFlowEscrow, authcapture.PaymentFlowAuthorization); err != nil {
		return terms, err
	}
	if terms.operatorType, err = choice(merged, "operatorType", authcapture.OperatorTypeDelegated,
		authcapture.OperatorTypeDelegated, authcapture.OperatorTypeCustom); err != nil {
		return terms, err
	}

	if terms.paymentFlow == authcapture.PaymentFlowAuthorization {
		if _, set := merged["captureMode"]; set {
			return terms, routeError("extra.captureMode only applies to paymentFlow escrow")
		}
		return terms, nil
	}
	if terms.captureMode, err = choice(merged, "captureMode", authcapture.CaptureModeSync,
		authcapture.CaptureModeSync, authcapture.CaptureModeDeferred); err != nil {
		return terms, err
	}
	if terms.captureMode == authcapture.CaptureModeSync && terms.operatorType == authcapture.OperatorTypeCustom {
		return terms, routeError("operatorType custom is collect-only, so it needs captureMode deferred")
	}
	return terms, nil
}

// resolveCaptureAuthorizer picks the operator: the route's, then Config's, then the facilitator's
// advertised one. A custom operator is the merchant's choice, never the facilitator's.
func (s *AuthCaptureEvmScheme) resolveCaptureAuthorizer(route, advertised map[string]interface{}, operatorType string) (string, error) {
	fromRoute, err := routeAddress(route, "captureAuthorizer")
	if err != nil {
		return "", err
	}
	captureAuthorizer := firstNonEmpty(fromRoute, s.config.CaptureAuthorizer)
	if captureAuthorizer == "" && operatorType == authcapture.OperatorTypeDelegated {
		captureAuthorizer, _ = advertised["captureAuthorizer"].(string)
	}
	if !evm.IsValidAddress(captureAuthorizer) {
		return "", fmt.Errorf("%s: set extra.captureAuthorizer or Config.CaptureAuthorizer (operatorType %s)", ErrMissingCaptureAuthorizer, operatorType)
	}
	return evm.NormalizeAddress(captureAuthorizer), nil
}

type advertisedOperator struct {
	Address      string `json:"address"`
	OperatorType string `json:"operatorType"`
}

// checkOperatorAdmitted fails when the facilitator's advertised allowlist does not admit address
// as a custom operator, since every payment on the route would then be rejected.
func checkOperatorAdmitted(advertised map[string]interface{}, address string) error {
	var entries []advertisedOperator
	if encoded, err := json.Marshal(advertised["operators"]); err == nil {
		_ = json.Unmarshal(encoded, &entries)
	}
	for _, entry := range entries {
		if entry.OperatorType == authcapture.OperatorTypeCustom && (entry.Address == "*" || strings.EqualFold(entry.Address, address)) {
			return nil
		}
	}
	return fmt.Errorf("%s: the facilitator does not advertise %s as an admitted custom operator", ErrOperatorNotAdmitted, address)
}

// resolveFeeTerms picks the fee recipient and bounds: the route's, then Config's, then the
// facilitator's advertised terms. Absent terms mean no fee: the zero address with 0/0 bounds.
func (s *AuthCaptureEvmScheme) resolveFeeTerms(route, advertised map[string]interface{}) (string, uint16, uint16, error) {
	fromRoute, err := routeAddress(route, "feeRecipient")
	if err != nil {
		return "", 0, 0, err
	}
	advertisedRecipient, _ := advertised["feeRecipient"].(string)
	feeRecipient := firstNonEmpty(fromRoute, s.config.FeeRecipient, advertisedRecipient, authcapture.ZeroAddress)
	if !evm.IsValidAddress(feeRecipient) {
		return "", 0, 0, fmt.Errorf("%s: invalid feeRecipient %q", ErrInvalidFeeTerms, feeRecipient)
	}

	bounds := [2]uint16{}
	for i, term := range []struct {
		key        string
		configured *uint16
	}{{"minFeeBps", s.config.MinFeeBps}, {"maxFeeBps", s.config.MaxFeeBps}} {
		fromRoute, set, err := routeBps(route, term.key)
		if err != nil {
			return "", 0, 0, err
		}
		switch {
		case set:
			bounds[i] = fromRoute
		case term.configured != nil:
			bounds[i] = *term.configured
		default:
			bounds[i], _ = authcapture.JSONNumberToUint16(advertised[term.key])
		}
	}

	minFeeBps, maxFeeBps := bounds[0], bounds[1]
	if minFeeBps > maxFeeBps || maxFeeBps > authcapture.BpsDenominator {
		return "", 0, 0, fmt.Errorf("%s: minFeeBps %d and maxFeeBps %d must satisfy min <= max <= %d",
			ErrInvalidFeeTerms, minFeeBps, maxFeeBps, authcapture.BpsDenominator)
	}
	if !authcapture.IsNonZeroAddress(feeRecipient) && maxFeeBps != 0 {
		return "", 0, 0, fmt.Errorf("%s: a non-zero maxFeeBps needs a feeRecipient", ErrMissingFeeRecipient)
	}
	return evm.NormalizeAddress(feeRecipient), minFeeBps, maxFeeBps, nil
}

// advertisedAddress reads an optional address the facilitator advertised, "" when absent.
func advertisedAddress(advertised map[string]interface{}, key string) (string, error) {
	raw, set := advertised[key]
	if !set || raw == nil || raw == "" {
		return "", nil
	}
	if value, ok := raw.(string); ok && evm.IsValidAddress(value) {
		return value, nil
	}
	return "", fmt.Errorf("%s: the facilitator advertised an invalid %s %v", ErrInvalidRouteExtra, key, raw)
}

// resolveReceiverAuthorizer resolves who authorizes facilitator-relayed charge and lifecycle,
// strictly and in order: the scheme signer (self-managed); else the route's own
// receiverAuthorizer (the zero address is explicit collect-only, the facilitator-advertised
// address is delegated, anything else has no way to be signed); else the facilitator-advertised
// address. It fails instead of silently falling back to collect-only, and rejects a collect-only
// result on a route that needs a signed charge or capture.
func (s *AuthCaptureEvmScheme) resolveReceiverAuthorizer(route, advertised map[string]interface{}, terms resolvedTerms) (string, error) {
	fromRoute, err := routeAddress(route, "receiverAuthorizer")
	if err != nil {
		return "", err
	}
	advertisedAddr, err := advertisedAddress(advertised, "receiverAuthorizer")
	if err != nil {
		return "", err
	}
	advertisedNonZero := ""
	if authcapture.IsNonZeroAddress(advertisedAddr) {
		advertisedNonZero = advertisedAddr
	}

	receiverAuthorizer, err := s.pickReceiverAuthorizer(fromRoute, advertisedNonZero)
	if err != nil {
		return "", err
	}
	if authcapture.IsNonZeroAddress(receiverAuthorizer) {
		return receiverAuthorizer, nil
	}
	switch {
	case terms.paymentFlow == authcapture.PaymentFlowAuthorization:
		return "", fmt.Errorf("%s: paymentFlow authorization requires a non-zero receiverAuthorizer "+
			"(extra.receiverAuthorizer of the zero address is collect-only, valid only for escrow with captureMode deferred)",
			ErrMissingReceiverAuthorizer)
	case terms.captureMode == authcapture.CaptureModeSync:
		return "", fmt.Errorf("%s: escrow sync routes require a non-zero receiverAuthorizer "+
			"(extra.receiverAuthorizer of the zero address is collect-only, valid only with captureMode deferred)",
			ErrMissingReceiverAuthorizer)
	}
	return receiverAuthorizer, nil
}

// pickReceiverAuthorizer applies the resolution order of resolveReceiverAuthorizer.
func (s *AuthCaptureEvmScheme) pickReceiverAuthorizer(fromRoute, advertisedNonZero string) (string, error) {
	if signer := s.config.ReceiverAuthorizerSigner; signer != nil {
		address := evm.NormalizeAddress(signer.Address())
		if authcapture.IsNonZeroAddress(fromRoute) && !strings.EqualFold(fromRoute, address) {
			return "", fmt.Errorf("%s: extra.receiverAuthorizer %s is not the configured signer %s", ErrReceiverAuthorizerMismatch, fromRoute, address)
		}
		return address, nil
	}

	if fromRoute != "" {
		switch {
		case !authcapture.IsNonZeroAddress(fromRoute):
			return authcapture.ZeroAddress, nil
		case advertisedNonZero != "" && strings.EqualFold(fromRoute, advertisedNonZero):
			return evm.NormalizeAddress(fromRoute), nil
		}
		return "", fmt.Errorf("%s: extra.receiverAuthorizer %s can not be signed: the scheme has no "+
			"ReceiverAuthorizerSigner and the facilitator does not advertise that address. "+
			"Configure a ReceiverAuthorizerSigner, omit the field to use the facilitator's authorizer, "+
			"or set it to the zero address for collect-only with captureMode deferred",
			ErrUnsignableReceiverAuthorizer, fromRoute)
	}

	if advertisedNonZero != "" {
		return evm.NormalizeAddress(advertisedNonZero), nil
	}
	return "", fmt.Errorf("%s: AuthCapture has no receiverAuthorizer: the route sets none, the scheme has no "+
		"ReceiverAuthorizerSigner, and the facilitator advertises none. Fix one of: "+
		"(1) configure a ReceiverAuthorizerSigner on the scheme, "+
		"(2) use a facilitator that delegates the authorizer (advertises extra.receiverAuthorizer), "+
		"or (3) set extra.receiverAuthorizer to the zero address with captureMode deferred (collect-only)",
		ErrMissingReceiverAuthorizer)
}

// deadlineKey reads an optional positive integer, reporting whether the route set it.
func deadlineKey(route map[string]interface{}, key string) (uint64, bool, error) {
	raw, set := route[key]
	if !set || raw == nil {
		return 0, false, nil
	}
	value, ok := authcapture.JSONNumberToUint64(raw)
	if !ok || value == 0 || value > maxExpiry {
		return 0, false, fmt.Errorf("%s: extra.%s must be a positive whole number of seconds, got %v", ErrInvalidDeadline, key, raw)
	}
	return value, true, nil
}

// resolveDeadlines turns the route's absolute pair, relative pair or Config durations into
// absolute deadlines. Relative offsets count from the start of the current minute so every 402
// issued in that minute carries the same deadlines.
func (s *AuthCaptureEvmScheme) resolveDeadlines(route map[string]interface{}, maxTimeoutSeconds int, now time.Time) (uint64, uint64, error) {
	var set [4]bool
	var values [4]uint64
	for i, key := range []string{"captureDeadline", "refundDeadline", "captureDeadlineSeconds", "refundDeadlineSeconds"} {
		var err error
		if values[i], set[i], err = deadlineKey(route, key); err != nil {
			return 0, 0, err
		}
	}
	absCapture, absRefund, relCapture, relRefund := set[0], set[1], set[2], set[3]
	if (absCapture || absRefund) && (relCapture || relRefund) || absCapture != absRefund || relCapture != relRefund {
		return 0, 0, fmt.Errorf("%s: set both absolute deadlines or both relative offsets, not a mix or a single one", ErrInvalidDeadline)
	}

	bucketStart := uint64(now.Unix()) - uint64(now.Unix())%deadlineBucketSeconds
	var capture, refund, window uint64
	switch {
	case absCapture:
		capture, refund = values[0], values[1]
		if capture > uint64(now.Unix()) {
			window = capture - uint64(now.Unix())
		}
	case relCapture:
		capture, refund, window = bucketStart+values[2], bucketStart+values[3], values[2]
	default:
		window = uint64(durationOrDefault(s.config.CaptureDeadline, DefaultCaptureDeadline) / time.Second)
		capture = bucketStart + window
		refund = bucketStart + uint64(durationOrDefault(s.config.RefundDeadline, DefaultRefundDeadline)/time.Second)
	}

	if uint64(maxTimeoutSeconds) > window {
		return 0, 0, fmt.Errorf("%s: maxTimeoutSeconds %d exceeds the capture window of %ds",
			ErrTimeoutExceedsCaptureDeadline, maxTimeoutSeconds, window)
	}
	if refund < capture {
		return 0, 0, fmt.Errorf("%s: refund deadline %d is before the capture deadline %d", ErrRefundBeforeCaptureDeadline, refund, capture)
	}
	if refund > maxExpiry {
		return 0, 0, fmt.Errorf("%s: refund deadline %d exceeds the uint48 expiry range", ErrInvalidDeadline, refund)
	}
	return capture, refund, nil
}

func durationOrDefault(configured, fallback time.Duration) time.Duration {
	if configured > 0 {
		return configured
	}
	return fallback
}
