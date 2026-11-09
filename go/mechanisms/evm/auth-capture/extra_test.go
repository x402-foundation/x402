package authcapture

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/types"
)

func validExtra() map[string]interface{} {
	return map[string]interface{}{
		"name":              "USDC",
		"version":           "2",
		"captureAuthorizer": "0x1111111111111111111111111111111111111111",
		"feeRecipient":      "0x4444444444444444444444444444444444444444",
		"minFeeBps":         float64(0),
		"maxFeeBps":         float64(100),
		"captureDeadline":   float64(4102444800),
		"refundDeadline":    float64(4102531200),
	}
}

func TestParseAuthCaptureExtra(t *testing.T) {
	requirements := types.PaymentRequirements{Asset: "0x3333333333333333333333333333333333333333", Extra: validExtra()}

	extra, deployment, err := ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)
	assert.Equal(t, AuthCaptureDeploymentV1_1, deployment.Version)
	assert.Equal(t, deployment.Escrow, extra.AuthCaptureEscrow)
	assert.Equal(t, uint16(100), extra.MaxFeeBps)
	assert.Equal(t, uint64(4102444800), extra.CaptureDeadline)
	assert.False(t, extra.AutoCapture)

	requirements.Extra["authCaptureEscrow"] = AuthCaptureEscrowV1_0Address
	requirements.Extra["autoCapture"] = true
	requirements.Extra["receiverAuthorizer"] = "0x5555555555555555555555555555555555555555"
	extra, deployment, err = ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)
	assert.Equal(t, AuthCaptureDeploymentV1_0, deployment.Version)
	assert.True(t, extra.AutoCapture)
	assert.Equal(t, "0x5555555555555555555555555555555555555555", extra.ReceiverAuthorizer)
}

func TestParseAuthCaptureExtra_Permit2DoesNotNeedTokenDomain(t *testing.T) {
	extra := validExtra()
	delete(extra, "name")
	delete(extra, "version")

	_, _, err := ParseAuthCaptureExtra(types.PaymentRequirements{Extra: extra})
	require.Error(t, err, "an EIP-3009 requirement still needs the domain")

	extra["assetTransferMethod"] = "permit2"
	parsed, _, err := ParseAuthCaptureExtra(types.PaymentRequirements{Extra: extra})
	require.NoError(t, err)
	assert.Equal(t, "permit2", parsed.AssetTransferMethod)
	assert.Empty(t, parsed.Name)
}

func TestParseAuthCaptureExtra_Rejects(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]interface{})
		want   string
	}{
		{"no name", func(e map[string]interface{}) { delete(e, "name") }, "'name'"},
		{"no version", func(e map[string]interface{}) { delete(e, "version") }, "'version'"},
		{"no captureAuthorizer", func(e map[string]interface{}) { delete(e, "captureAuthorizer") }, "captureAuthorizer"},
		{"no feeRecipient", func(e map[string]interface{}) { delete(e, "feeRecipient") }, "feeRecipient"},
		{"fractional captureDeadline", func(e map[string]interface{}) { e["captureDeadline"] = 1.5 }, "captureDeadline"},
		{"negative refundDeadline", func(e map[string]interface{}) { e["refundDeadline"] = float64(-1) }, "refundDeadline"},
		{"oversized minFeeBps", func(e map[string]interface{}) { e["minFeeBps"] = float64(70000) }, "minFeeBps"},
		{"missing maxFeeBps", func(e map[string]interface{}) { delete(e, "maxFeeBps") }, "maxFeeBps"},
		{"unknown escrow", func(e map[string]interface{}) { e["authCaptureEscrow"] = "0x9999999999999999999999999999999999999999" }, "authCaptureEscrow"},
		{"unknown captureMode", func(e map[string]interface{}) { e["captureMode"] = "lazy" }, "captureMode"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			extra := validExtra()
			tc.mutate(extra)
			_, _, err := ParseAuthCaptureExtra(types.PaymentRequirements{Extra: extra})
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}

	_, _, err := ParseAuthCaptureExtra(types.PaymentRequirements{})
	require.Error(t, err)
}

func TestReconstructPaymentInfo(t *testing.T) {
	requirements := types.PaymentRequirements{
		PayTo:  "0x2222222222222222222222222222222222222222",
		Asset:  "0x3333333333333333333333333333333333333333",
		Amount: "1000000",
		Extra:  validExtra(),
	}
	extra, _, err := ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)

	info := ReconstructPaymentInfo("0xpayer", 42, "0xsalt", requirements, extra)

	assert.Equal(t, PaymentInfoStruct{
		Operator:            extra.CaptureAuthorizer,
		Payer:               "0xpayer",
		Receiver:            requirements.PayTo,
		Token:               requirements.Asset,
		MaxAmount:           "1000000",
		PreApprovalExpiry:   42,
		AuthorizationExpiry: extra.CaptureDeadline,
		RefundExpiry:        extra.RefundDeadline,
		MinFeeBps:           0,
		MaxFeeBps:           100,
		FeeReceiver:         extra.FeeRecipient,
		Salt:                "0xsalt",
	}, info)
}

func TestJSONNumberToUint64(t *testing.T) {
	valid := map[string]interface{}{
		"float64": float64(7), "int": 7, "int32": int32(7), "int64": int64(7),
		"uint16": uint16(7), "uint32": uint32(7), "uint64": uint64(7), "json.Number": json.Number("7"),
	}
	for name, value := range valid {
		n, ok := JSONNumberToUint64(value)
		assert.True(t, ok, name)
		assert.Equal(t, uint64(7), n, name)
	}

	invalid := map[string]interface{}{
		"fractional": 1.5, "negative float": float64(-1), "overflow": math.Pow(2, 70),
		"negative int": -1, "negative int32": int32(-1), "negative int64": int64(-1),
		"negative json.Number": json.Number("-1"), "fractional json.Number": json.Number("1.5"),
		"string": "7", "nil": nil,
	}
	for name, value := range invalid {
		_, ok := JSONNumberToUint64(value)
		assert.False(t, ok, name)
	}
}

func TestJSONNumberToUint16(t *testing.T) {
	n, ok := JSONNumberToUint16(float64(10000))
	assert.True(t, ok)
	assert.Equal(t, uint16(10000), n)

	_, ok = JSONNumberToUint16(float64(65536))
	assert.False(t, ok)
}

func TestParseAuthCaptureExtra_CaptureMode(t *testing.T) {
	for _, mode := range []string{"", CaptureModeSync, CaptureModeDeferred} {
		extra := validExtra()
		if mode != "" {
			extra["captureMode"] = mode
		}
		parsed, _, err := ParseAuthCaptureExtra(types.PaymentRequirements{Extra: extra})
		require.NoError(t, err)
		assert.Equal(t, mode, parsed.CaptureMode)
	}
}
