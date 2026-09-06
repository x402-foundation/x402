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

// AuthCaptureExtra is the wire extra after facilitator enhancement (absolute deadlines).
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

// IsAuthCaptureExtra reports whether value has every spec-mandated AuthCaptureExtra field.
func IsAuthCaptureExtra(value interface{}) bool {
	m, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	if !isNonEmptyString(m["captureAuthorizer"]) {
		return false
	}
	if !isJSONNumber(m["captureDeadline"]) {
		return false
	}
	if !isJSONNumber(m["refundDeadline"]) {
		return false
	}
	if !isNonEmptyString(m["feeRecipient"]) {
		return false
	}
	if !isJSONNumber(m["minFeeBps"]) {
		return false
	}
	if !isJSONNumber(m["maxFeeBps"]) {
		return false
	}
	if !isNonEmptyString(m["name"]) {
		return false
	}
	return isNonEmptyString(m["version"])
}

func isNonEmptyString(value interface{}) bool {
	s, ok := value.(string)
	return ok && s != ""
}

func isJSONNumber(value interface{}) bool {
	switch value.(type) {
	case float64, int, int64, uint64, uint16, int32, uint32:
		return true
	default:
		return false
	}
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

func collectSaltFields(v map[string]interface{}) (saltNonce string, ok bool) {
	if !isHexString(v["salt"]) {
		return "", false
	}
	if v["saltNonce"] == nil {
		return "", true
	}
	if !isHexString(v["saltNonce"]) {
		return "", false
	}
	return v["saltNonce"].(string), true
}

func readChargeCompletion(v map[string]interface{}) bool {
	hasAny := false
	for _, key := range []string{"amount", "feeBps", "feeAmount", "feeReceiver", "authorizerSignature"} {
		if _, ok := v[key]; ok {
			hasAny = true
			break
		}
	}
	if !hasAny {
		return true
	}
	_, hasAmount := v["amount"].(string)
	_, hasFeeBpsFloat := v["feeBps"].(float64)
	_, hasFeeBpsInt := v["feeBps"].(int)
	hasFeeBps := hasFeeBpsFloat || hasFeeBpsInt
	_, hasFeeAmount := v["feeAmount"].(string)
	_, hasFeeReceiver := v["feeReceiver"].(string)
	_, hasAuthorizerSig := v["authorizerSignature"].(string)
	if !hasAmount || !hasFeeReceiver || !hasAuthorizerSig {
		return false
	}
	if hasFeeBps && !hasFeeAmount {
		return true
	}
	if hasFeeAmount && !hasFeeBps {
		return true
	}
	return false
}

// IsEip3009Payload reports whether value is an EIP-3009-shaped auth-capture collect payload.
func IsEip3009Payload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	if v["type"] != nil {
		return false
	}
	auth, ok := v["authorization"].(map[string]interface{})
	if !ok || auth == nil {
		return false
	}
	if _, ok := v["signature"].(string); !ok {
		return false
	}
	saltNonce, ok := collectSaltFields(v)
	if !ok {
		return false
	}
	hasAnyCharge := false
	for _, key := range []string{"amount", "feeBps", "feeAmount", "feeReceiver", "authorizerSignature"} {
		if _, ok := v[key]; ok {
			hasAnyCharge = true
			break
		}
	}
	if hasAnyCharge {
		if saltNonce == "" {
			return false
		}
		return readChargeCompletion(v)
	}
	return true
}

// IsPermit2Payload reports whether value is a Permit2-shaped auth-capture collect payload.
func IsPermit2Payload(value interface{}) bool {
	v, ok := value.(map[string]interface{})
	if !ok {
		return false
	}
	if v["type"] != nil {
		return false
	}
	if _, ok := v["signature"].(string); !ok {
		return false
	}
	auth, ok := v["permit2Authorization"].(map[string]interface{})
	if !ok || auth == nil {
		return false
	}
	if _, ok := auth["from"].(string); !ok {
		return false
	}
	if _, ok := auth["spender"].(string); !ok {
		return false
	}
	if _, ok := auth["nonce"].(string); !ok {
		return false
	}
	if _, ok := auth["deadline"].(string); !ok {
		return false
	}
	permitted, ok := auth["permitted"].(map[string]interface{})
	if !ok || permitted == nil {
		return false
	}
	if _, ok := permitted["token"].(string); !ok {
		return false
	}
	if _, ok := permitted["amount"].(string); !ok {
		return false
	}
	saltNonce, ok := collectSaltFields(v)
	if !ok {
		return false
	}
	hasAnyCharge := false
	for _, key := range []string{"amount", "feeBps", "feeAmount", "feeReceiver", "authorizerSignature"} {
		if _, ok := v[key]; ok {
			hasAnyCharge = true
			break
		}
	}
	if hasAnyCharge {
		if saltNonce == "" {
			return false
		}
		return readChargeCompletion(v)
	}
	return true
}
