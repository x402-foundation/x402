package authcapture

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ParseAuthCaptureExtra validates requirements.Extra and returns it with the resolved
// commerce-payments deployment. Shared by the client, server and facilitator.
func ParseAuthCaptureExtra(requirements types.PaymentRequirements) (AuthCaptureExtra, AuthCaptureDeployment, error) {
	ex := requirements.Extra
	if ex == nil {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("'captureAuthorizer' is required in payment requirements extra")
	}

	assetTransferMethod := stringFromExtra(ex, "assetTransferMethod")
	name, _ := ex["name"].(string)
	version, _ := ex["version"].(string)
	// Only the EIP-3009 signature is bound to the token's EIP-712 domain.
	if assetTransferMethod != string(evm.AssetTransferMethodPermit2) {
		if name == "" {
			return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("EIP-712 domain parameter 'name' is required in payment requirements for asset %s", requirements.Asset)
		}
		if version == "" {
			return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("EIP-712 domain parameter 'version' is required in payment requirements for asset %s", requirements.Asset)
		}
	}

	captureAuthorizer, _ := ex["captureAuthorizer"].(string)
	if captureAuthorizer == "" {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("'captureAuthorizer' is required in payment requirements extra")
	}
	feeRecipient, _ := ex["feeRecipient"].(string)
	if feeRecipient == "" {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("'feeRecipient' is required in payment requirements extra")
	}

	captureDeadline, err := extraUint64(ex, "captureDeadline")
	if err != nil {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("'captureDeadline' is required in payment requirements extra")
	}
	refundDeadline, err := extraUint64(ex, "refundDeadline")
	if err != nil {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("'refundDeadline' is required in payment requirements extra")
	}
	minFeeBps, err := extraUint16(ex, "minFeeBps")
	if err != nil {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("'minFeeBps' is required in payment requirements extra")
	}
	maxFeeBps, err := extraUint16(ex, "maxFeeBps")
	if err != nil {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("'maxFeeBps' is required in payment requirements extra")
	}

	deployment := ResolveAuthCaptureDeployment(stringFromExtra(ex, "authCaptureEscrow"))
	if deployment == nil {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("invalid authCaptureEscrow in payment requirements extra")
	}

	captureMode := stringFromExtra(ex, "captureMode")
	if captureMode != "" && captureMode != CaptureModeSync && captureMode != CaptureModeDeferred {
		return AuthCaptureExtra{}, AuthCaptureDeployment{}, fmt.Errorf("invalid captureMode %q", captureMode)
	}

	autoCapture, _ := ex["autoCapture"].(bool)
	return AuthCaptureExtra{
		CaptureAuthorizer:   captureAuthorizer,
		CaptureDeadline:     captureDeadline,
		RefundDeadline:      refundDeadline,
		FeeRecipient:        feeRecipient,
		MinFeeBps:           minFeeBps,
		MaxFeeBps:           maxFeeBps,
		Name:                name,
		Version:             version,
		ReceiverAuthorizer:  stringFromExtra(ex, "receiverAuthorizer"),
		Policy:              stringFromExtra(ex, "policy"),
		PaymentFlow:         stringFromExtra(ex, "paymentFlow"),
		CaptureMode:         captureMode,
		AutoCapture:         autoCapture,
		OperatorType:        stringFromExtra(ex, "operatorType"),
		AssetTransferMethod: assetTransferMethod,
		AuthCaptureEscrow:   deployment.Escrow,
	}, *deployment, nil
}

// ReconstructPaymentInfo rebuilds the onchain PaymentInfo from the payload-derived
// payer, preApprovalExpiry and salt plus the server-published requirements and extra.
func ReconstructPaymentInfo(
	payer string,
	preApprovalExpiry uint64,
	salt string,
	requirements types.PaymentRequirements,
	extra AuthCaptureExtra,
) PaymentInfoStruct {
	return PaymentInfoStruct{
		Operator:            extra.CaptureAuthorizer,
		Payer:               payer,
		Receiver:            requirements.PayTo,
		Token:               requirements.Asset,
		MaxAmount:           requirements.Amount,
		PreApprovalExpiry:   preApprovalExpiry,
		AuthorizationExpiry: extra.CaptureDeadline,
		RefundExpiry:        extra.RefundDeadline,
		MinFeeBps:           extra.MinFeeBps,
		MaxFeeBps:           extra.MaxFeeBps,
		FeeReceiver:         extra.FeeRecipient,
		Salt:                salt,
	}
}

// JSONNumberToUint64 converts a decoded JSON or in-process number to uint64,
// rejecting negative and fractional values.
func JSONNumberToUint64(value interface{}) (uint64, bool) {
	switch v := value.(type) {
	case float64:
		if v < 0 || v != math.Trunc(v) || v > math.MaxUint64 {
			return 0, false
		}
		return uint64(v), true
	case int:
		return nonNegative(int64(v))
	case int32:
		return nonNegative(int64(v))
	case int64:
		return nonNegative(v)
	case uint16:
		return uint64(v), true
	case uint32:
		return uint64(v), true
	case uint64:
		return v, true
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return 0, false
		}
		return nonNegative(n)
	default:
		return 0, false
	}
}

// JSONNumberToUint16 is JSONNumberToUint64 restricted to the uint16 range.
func JSONNumberToUint16(value interface{}) (uint16, bool) {
	n, ok := JSONNumberToUint64(value)
	if !ok || n > math.MaxUint16 {
		return 0, false
	}
	return uint16(n), true
}

func nonNegative(n int64) (uint64, bool) {
	if n < 0 {
		return 0, false
	}
	return uint64(n), true
}

func stringFromExtra(ex map[string]interface{}, key string) string {
	v, _ := ex[key].(string)
	return v
}

func extraUint64(ex map[string]interface{}, key string) (uint64, error) {
	n, ok := JSONNumberToUint64(ex[key])
	if !ok {
		return 0, fmt.Errorf("missing or invalid %s", key)
	}
	return n, nil
}

func extraUint16(ex map[string]interface{}, key string) (uint16, error) {
	n, ok := JSONNumberToUint16(ex[key])
	if !ok {
		return 0, fmt.Errorf("missing or invalid %s", key)
	}
	return n, nil
}

// AuthorizerModeFor selects the authorizer mode for a resolved receiverAuthorizer: the zero
// address is collect-only, the signer's own address is self, and any other address is delegated.
func AuthorizerModeFor(receiverAuthorizer string, signer evm.ClientEvmSigner) AuthorizerMode {
	if !IsNonZeroAddress(receiverAuthorizer) {
		return AuthorizerModeCollectOnly
	}
	if signer != nil && strings.EqualFold(evm.NormalizeAddress(signer.Address()), evm.NormalizeAddress(receiverAuthorizer)) {
		return AuthorizerModeSelf
	}
	return AuthorizerModeDelegated
}
