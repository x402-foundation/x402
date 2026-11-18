package authcapture

import (
	"strings"
)

// PaymentInfoStruct is the onchain PaymentInfo struct (canonical Solidity names).
type PaymentInfoStruct struct {
	Operator            string `json:"operator"`
	Payer               string `json:"payer"`
	Receiver            string `json:"receiver"`
	Token               string `json:"token"`
	MaxAmount           string `json:"maxAmount"`
	PreApprovalExpiry   uint64 `json:"preApprovalExpiry"`
	AuthorizationExpiry uint64 `json:"authorizationExpiry"`
	RefundExpiry        uint64 `json:"refundExpiry"`
	MinFeeBps           uint16 `json:"minFeeBps"`
	MaxFeeBps           uint16 `json:"maxFeeBps"`
	FeeReceiver         string `json:"feeReceiver"`
	Salt                string `json:"salt"`
}

// AuthorizerMode says who produces authorizerSignature for a published receiverAuthorizer:
//   - AuthorizerModeSelf: the server's receiver-authorizer signer, which signs locally.
//   - AuthorizerModeDelegated: a non-zero authorizer the server holds no key for; payloads go
//     out unsigned and the facilitator signs after authenticating the request out of band.
//   - AuthorizerModeCollectOnly: the zero address; the facilitator relays no lifecycle.
type AuthorizerMode string

const (
	AuthorizerModeSelf        AuthorizerMode = "self"
	AuthorizerModeDelegated   AuthorizerMode = "delegated"
	AuthorizerModeCollectOnly AuthorizerMode = "collect-only"
)

// AuthCaptureExtra is the parsed requirements.Extra (absolute deadlines).
type AuthCaptureExtra struct {
	CaptureAuthorizer   string
	CaptureDeadline     uint64
	RefundDeadline      uint64
	FeeRecipient        string
	MinFeeBps           uint16
	MaxFeeBps           uint16
	Name                string
	Version             string
	PaymentFlow         string
	CaptureMode         string
	AutoCapture         bool
	ReceiverAuthorizer  string
	Policy              string
	OperatorType        string
	AssetTransferMethod string
	AuthCaptureEscrow   string
}

// Eip3009Authorization is the ERC-3009 ReceiveWithAuthorization message on the wire.
type Eip3009Authorization struct {
	From        string `json:"from"`
	To          string `json:"to"`
	Value       string `json:"value"`
	ValidAfter  string `json:"validAfter"`
	ValidBefore string `json:"validBefore"`
	Nonce       string `json:"nonce"`
}

// Permit2TokenPermissions is the permitted token/amount pair inside PermitTransferFrom.
type Permit2TokenPermissions struct {
	Token  string `json:"token"`
	Amount string `json:"amount"`
}

// Permit2Authorization is the Permit2 PermitTransferFrom message on the wire.
type Permit2Authorization struct {
	From      string                  `json:"from"`
	Permitted Permit2TokenPermissions `json:"permitted"`
	Spender   string                  `json:"spender"`
	Nonce     string                  `json:"nonce"`
	Deadline  string                  `json:"deadline"`
}

// chargeFields are the completion fields a server adds to a collect payload for a charge.
var chargeFields = []string{"amount", "feeBps", "feeAmount", "feeReceiver", "authorizerSignature"}

func isNonEmptyString(value interface{}) bool {
	s, ok := value.(string)
	return ok && s != ""
}

func isJSONNumber(value interface{}) bool {
	_, ok := JSONNumberToUint64(value)
	return ok
}

func isHexString(value interface{}) bool {
	s, ok := value.(string)
	if !ok {
		return false
	}
	if !strings.HasPrefix(s, "0x") && !strings.HasPrefix(s, "0X") {
		return false
	}
	hexPart := s[2:]
	if len(hexPart) == 0 || len(hexPart) > 64 {
		return false
	}
	for _, c := range hexPart {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func hasChargeFields(v map[string]interface{}) bool {
	for _, key := range chargeFields {
		if _, ok := v[key]; ok {
			return true
		}
	}
	return false
}

// hasFeeField reports which fee field a payload carries: feeBps (v1.0) or feeAmount (v1.1).
func hasFeeField(v map[string]interface{}) (hasFeeBps, hasFeeAmount bool) {
	_, hasFeeBps = JSONNumberToUint16(v["feeBps"])
	_, hasFeeAmount = v["feeAmount"].(string)
	return hasFeeBps, hasFeeAmount
}

// isOptionalString reports whether key is absent or a string.
func isOptionalString(v map[string]interface{}, key string) bool {
	value, present := v[key]
	if !present {
		return true
	}
	_, ok := value.(string)
	return ok
}

// isCompleteCharge requires the amount, feeReceiver and exactly one fee field. The authorizer
// signature is optional because a facilitator-delegated authorizer produces it at settle time.
func isCompleteCharge(v map[string]interface{}) bool {
	_, hasAmount := v["amount"].(string)
	_, hasFeeReceiver := v["feeReceiver"].(string)
	hasFeeBps, hasFeeAmount := hasFeeField(v)
	return hasAmount && hasFeeReceiver && isOptionalString(v, "authorizerSignature") && hasFeeBps != hasFeeAmount
}

// isCollectEnvelope checks the fields shared by both collect payload shapes.
func isCollectEnvelope(v map[string]interface{}) bool {
	if _, ok := v["signature"].(string); !ok {
		return false
	}
	if !isHexString(v["salt"]) {
		return false
	}
	saltNonce := v["saltNonce"]
	if saltNonce != nil && !isHexString(saltNonce) {
		return false
	}
	if !hasChargeFields(v) {
		return true
	}
	return saltNonce != nil && isCompleteCharge(v)
}

// IsEip3009Payload reports whether value is an EIP-3009-shaped auth-capture collect payload.
func IsEip3009Payload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok || v["type"] != nil {
		return false
	}
	auth, ok := v["authorization"].(map[string]interface{})
	if !ok || auth == nil {
		return false
	}
	return isCollectEnvelope(v)
}

// IsPermit2Payload reports whether value is a Permit2-shaped auth-capture collect payload.
func IsPermit2Payload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok || v["type"] != nil {
		return false
	}
	auth, ok := v["permit2Authorization"].(map[string]interface{})
	if !ok || auth == nil {
		return false
	}
	for _, key := range []string{"from", "spender", "nonce", "deadline"} {
		if _, ok := auth[key].(string); !ok {
			return false
		}
	}
	permitted, ok := auth["permitted"].(map[string]interface{})
	if !ok || permitted == nil {
		return false
	}
	for _, key := range []string{"token", "amount"} {
		if _, ok := permitted[key].(string); !ok {
			return false
		}
	}
	return isCollectEnvelope(v)
}

func isPaymentInfoStructMap(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	for _, key := range []string{"operator", "payer", "receiver", "token", "feeReceiver", "maxAmount"} {
		if !isNonEmptyString(v[key]) {
			return false
		}
	}
	if !isHexString(v["salt"]) {
		return false
	}
	for _, key := range []string{"preApprovalExpiry", "authorizationExpiry", "refundExpiry", "minFeeBps", "maxFeeBps"} {
		if !isJSONNumber(v[key]) {
			return false
		}
	}
	return true
}

// IsLifecyclePayload reports whether value names a supported lifecycle operation
// ("capture", "void" or "refund"). Field-level validation is in the per-type guards.
func IsLifecyclePayload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	t, ok := v["type"].(string)
	return ok && (t == "capture" || t == "void" || t == "refund")
}

// IsCapturePayload reports whether value is a capture lifecycle payload. The signatures are
// optional so a facilitator-delegated authorizer can sign them at settle time.
func IsCapturePayload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok || !IsLifecyclePayload(value) || v["type"] != "capture" {
		return false
	}
	hasFeeBps, hasFeeAmount := hasFeeField(v)
	if hasFeeBps == hasFeeAmount {
		return false
	}
	if !isPaymentInfoStructMap(v["paymentInfo"]) || !isHexString(v["saltNonce"]) {
		return false
	}
	for _, key := range []string{"amount", "feeReceiver", "expectedCapturableAmount", "expectedRefundableAmount"} {
		if !isNonEmptyString(v[key]) {
			return false
		}
	}
	return isOptionalString(v, "authorizerSignature") &&
		isOptionalString(v, "voidAuthorizerSignature") &&
		isDelegatedCaptureShape(v)
}

// isDelegatedCaptureShape applies the cross-field rules for a capture whose signatures may be
// delegated: a void signature needs the capture signature, and voidRemainder is the unsigned
// stand-in for the void signature.
func isDelegatedCaptureShape(v map[string]interface{}) bool {
	_, hasAuthorizerSig := v["authorizerSignature"]
	_, hasVoidSig := v["voidAuthorizerSignature"]
	if voidRemainder, present := v["voidRemainder"]; present {
		return voidRemainder == true && !hasAuthorizerSig && !hasVoidSig
	}
	return hasAuthorizerSig || !hasVoidSig
}

// IsVoidPayload reports whether value is a void lifecycle payload.
func IsVoidPayload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok || !IsLifecyclePayload(value) || v["type"] != "void" {
		return false
	}
	_, hasVoidRemainder := v["voidRemainder"]
	return isPaymentInfoStructMap(v["paymentInfo"]) &&
		isHexString(v["saltNonce"]) &&
		isOptionalString(v, "authorizerSignature") &&
		!hasVoidRemainder
}

// IsRefundPayload reports whether value is a refund lifecycle payload.
func IsRefundPayload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok || !IsLifecyclePayload(value) || v["type"] != "refund" {
		return false
	}
	if !isPaymentInfoStructMap(v["paymentInfo"]) || !isHexString(v["saltNonce"]) {
		return false
	}
	for _, key := range []string{"amount", "expectedCapturableAmount", "expectedRefundableAmount"} {
		if !isNonEmptyString(v[key]) {
			return false
		}
	}
	_, hasVoidRemainder := v["voidRemainder"]
	return isOptionalString(v, "authorizerSignature") && !hasVoidRemainder
}
