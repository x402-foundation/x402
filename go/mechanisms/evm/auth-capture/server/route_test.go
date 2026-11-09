package server

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testSignerAddress   = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testCustomOperator  = "0xdddddddddddddddddddddddddddddddddddddddd"
	testOtherOperator   = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	testFacilitatorAddr = "0xffffffffffffffffffffffffffffffffffffffff"
)

func signedScheme() *AuthCaptureEvmScheme {
	return NewAuthCaptureEvmScheme(&Config{ReceiverAuthorizerSigner: &mockSigner{address: testSignerAddress}})
}

// routeRequirements are requirements whose route sets only the given extra.
func routeRequirements(extra map[string]interface{}) types.PaymentRequirements {
	requirements := mockRequirements(nil)
	requirements.Extra = extra
	return requirements
}

func facilitatorKind(extra map[string]interface{}) types.SupportedKind {
	base := map[string]interface{}{"captureAuthorizer": testFacilitatorAddr}
	for key, value := range extra {
		base[key] = value
	}
	return types.SupportedKind{Extra: base}
}

func enhance(scheme *AuthCaptureEvmScheme, requirements types.PaymentRequirements, kind types.SupportedKind) (types.PaymentRequirements, error) {
	return scheme.EnhancePaymentRequirements(context.Background(), requirements, kind, nil)
}

func TestSchemeDeclaresDynamicDeadlinesAndBothFlows(t *testing.T) {
	scheme := signedScheme()
	assert.Equal(t, []string{"captureDeadline", "refundDeadline"}, scheme.DynamicExtraFields())

	flows := scheme.PaymentFlows()
	for _, method := range []evm.AssetTransferMethod{evm.AssetTransferMethodEIP3009, evm.AssetTransferMethodPermit2} {
		assert.Equal(t, x402.PaymentFlowEscrow, flows[string(method)].Default)
		assert.Equal(t, []x402.PaymentFlowName{x402.PaymentFlowEscrow, x402.PaymentFlowAuthorization}, flows[string(method)].Supported)
	}
}

func TestEnhance_RelativeDeadlinesAreBucketed(t *testing.T) {
	scheme := signedScheme()
	route := map[string]interface{}{"captureDeadlineSeconds": float64(600), "refundDeadlineSeconds": float64(1200)}

	first, err := enhance(scheme, routeRequirements(route), facilitatorKind(nil))
	require.NoError(t, err)
	assertBucketed(t, first.Extra["captureDeadline"], 600)
	assertBucketed(t, first.Extra["refundDeadline"], 1200)
	assert.NotContains(t, first.Extra, "captureDeadlineSeconds")
	assert.NotContains(t, first.Extra, "refundDeadlineSeconds")

	second, err := enhance(scheme, routeRequirements(route), facilitatorKind(nil))
	require.NoError(t, err)
	if first.Extra["captureDeadline"] != second.Extra["captureDeadline"] {
		t.Skip("minute rolled over between the two calls")
	}
	assert.Equal(t, first.Extra["refundDeadline"], second.Extra["refundDeadline"])
}

func TestEnhance_AbsoluteDeadlinesAreKept(t *testing.T) {
	future := uint64(time.Now().Unix()) + 7200
	enhanced, err := enhance(signedScheme(), routeRequirements(map[string]interface{}{
		"captureDeadline": float64(future), "refundDeadline": float64(future + 3600),
	}), facilitatorKind(nil))
	require.NoError(t, err)
	assert.Equal(t, future, enhanced.Extra["captureDeadline"])
	assert.Equal(t, future+3600, enhanced.Extra["refundDeadline"])
}

func TestEnhance_RouteDeadlinesBeatConfigDurations(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: &mockSigner{address: testSignerAddress},
		CaptureDeadline:          time.Hour,
		RefundDeadline:           48 * time.Hour,
	})
	enhanced, err := enhance(scheme, routeRequirements(map[string]interface{}{
		"captureDeadlineSeconds": float64(900), "refundDeadlineSeconds": float64(1800),
	}), facilitatorKind(nil))
	require.NoError(t, err)
	assertBucketed(t, enhanced.Extra["captureDeadline"], 900)
}

func TestEnhance_InvalidDeadlines(t *testing.T) {
	future := float64(time.Now().Unix() + 7200)
	tests := map[string]map[string]interface{}{
		"absolute and relative mixed": {"captureDeadline": future, "refundDeadline": future + 1, "captureDeadlineSeconds": float64(60), "refundDeadlineSeconds": float64(120)},
		"absolute with relative":      {"captureDeadline": future, "refundDeadlineSeconds": float64(120)},
		"only a capture deadline":     {"captureDeadline": future},
		"only a refund offset":        {"refundDeadlineSeconds": float64(120)},
		"zero offset":                 {"captureDeadlineSeconds": float64(0), "refundDeadlineSeconds": float64(120)},
		"fractional offset":           {"captureDeadlineSeconds": 1.5, "refundDeadlineSeconds": float64(120)},
		"negative offset":             {"captureDeadlineSeconds": float64(-60), "refundDeadlineSeconds": float64(120)},
		"string offset":               {"captureDeadlineSeconds": "600", "refundDeadlineSeconds": float64(1200)},
	}
	for name, route := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := enhance(signedScheme(), routeRequirements(route), facilitatorKind(nil))
			require.ErrorContains(t, err, ErrInvalidDeadline)
		})
	}

	t.Run("refund before capture", func(t *testing.T) {
		_, err := enhance(signedScheme(), routeRequirements(map[string]interface{}{
			"captureDeadlineSeconds": float64(1200), "refundDeadlineSeconds": float64(600),
		}), facilitatorKind(nil))
		require.ErrorContains(t, err, ErrRefundBeforeCaptureDeadline)
	})

	t.Run("timeout beyond the relative capture window", func(t *testing.T) {
		requirements := routeRequirements(map[string]interface{}{"captureDeadlineSeconds": float64(120), "refundDeadlineSeconds": float64(600)})
		requirements.MaxTimeoutSeconds = 121
		_, err := enhance(signedScheme(), requirements, facilitatorKind(nil))
		require.ErrorContains(t, err, ErrTimeoutExceedsCaptureDeadline)
	})
}

func TestEnhance_PrecedenceIsRouteThenConfigThenFacilitator(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: &mockSigner{address: testSignerAddress},
		CaptureAuthorizer:        testCustomOperator,
		FeeRecipient:             testFeeRecipient,
	})

	t.Run("route wins", func(t *testing.T) {
		enhanced, err := enhance(scheme, routeRequirements(AuthCaptureRouteExtra{
			CaptureAuthorizer: testOtherOperator,
			FeeRecipient:      testCaptureAuthorizer,
			MinFeeBps:         ptr(uint16(5)),
			MaxFeeBps:         ptr(uint16(50)),
		}.Map()), facilitatorKind(map[string]interface{}{"feeRecipient": testFacilitatorAddr, "minFeeBps": float64(1), "maxFeeBps": float64(2)}))
		require.NoError(t, err)
		assert.Equal(t, evm.NormalizeAddress(testOtherOperator), enhanced.Extra["captureAuthorizer"])
		assert.Equal(t, evm.NormalizeAddress(testCaptureAuthorizer), enhanced.Extra["feeRecipient"])
		assert.Equal(t, uint16(5), enhanced.Extra["minFeeBps"])
		assert.Equal(t, uint16(50), enhanced.Extra["maxFeeBps"])
	})

	t.Run("config beats the facilitator", func(t *testing.T) {
		enhanced, err := enhance(scheme, routeRequirements(map[string]interface{}{}),
			facilitatorKind(map[string]interface{}{"feeRecipient": testFacilitatorAddr, "maxFeeBps": float64(9)}))
		require.NoError(t, err)
		assert.Equal(t, evm.NormalizeAddress(testCustomOperator), enhanced.Extra["captureAuthorizer"])
		assert.Equal(t, evm.NormalizeAddress(testFeeRecipient), enhanced.Extra["feeRecipient"])
		assert.Equal(t, uint16(9), enhanced.Extra["maxFeeBps"])
	})
}

func TestEnhance_InvalidRouteTerms(t *testing.T) {
	tests := map[string]struct {
		route   map[string]interface{}
		wantErr string
	}{
		"unknown payment flow":        {map[string]interface{}{"paymentFlow": "upfront"}, ErrInvalidRouteExtra},
		"non-string payment flow":     {map[string]interface{}{"paymentFlow": 1}, ErrInvalidRouteExtra},
		"unknown capture mode":        {map[string]interface{}{"captureMode": "later"}, ErrInvalidRouteExtra},
		"unknown operator type":       {map[string]interface{}{"operatorType": "policy"}, ErrInvalidRouteExtra},
		"capture mode on charge":      {map[string]interface{}{"paymentFlow": "authorization", "captureMode": "sync"}, ErrInvalidRouteExtra},
		"custom operator syncs":       {map[string]interface{}{"operatorType": "custom", "captureMode": "sync"}, ErrInvalidRouteExtra},
		"custom operator by default":  {map[string]interface{}{"operatorType": "custom"}, ErrInvalidRouteExtra},
		"autoCapture":                 {map[string]interface{}{"autoCapture": true}, ErrAutoCaptureRemoved},
		"malformed captureAuthorizer": {map[string]interface{}{"captureAuthorizer": "nope"}, ErrInvalidRouteExtra},
		"malformed feeRecipient":      {map[string]interface{}{"feeRecipient": "nope"}, ErrInvalidRouteExtra},
		"malformed policy":            {map[string]interface{}{"policy": "nope"}, ErrInvalidRouteExtra},
		"fractional fee bound":        {map[string]interface{}{"maxFeeBps": 1.5}, ErrInvalidFeeTerms},
		"foreign receiverAuthorizer":  {map[string]interface{}{"receiverAuthorizer": testOtherOperator}, ErrReceiverAuthorizerMismatch},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := enhance(signedScheme(), routeRequirements(test.route), facilitatorKind(nil))
			require.ErrorContains(t, err, test.wantErr)
		})
	}
}

func TestEnhance_FlowsAndModes(t *testing.T) {
	t.Run("escrow defaults to a sync delegated capture", func(t *testing.T) {
		enhanced, err := enhance(signedScheme(), routeRequirements(map[string]interface{}{}), facilitatorKind(nil))
		require.NoError(t, err)
		assert.Equal(t, "escrow", enhanced.Extra["paymentFlow"])
		assert.Equal(t, "sync", enhanced.Extra["captureMode"])
		assert.Equal(t, "delegated", enhanced.Extra["operatorType"])
	})

	t.Run("deferred escrow", func(t *testing.T) {
		enhanced, err := enhance(signedScheme(), routeRequirements(AuthCaptureRouteExtra{CaptureMode: "deferred"}.Map()), facilitatorKind(nil))
		require.NoError(t, err)
		assert.Equal(t, "deferred", enhanced.Extra["captureMode"])
	})

	t.Run("authorization publishes its flow and no capture mode", func(t *testing.T) {
		enhanced, err := enhance(signedScheme(), routeRequirements(AuthCaptureRouteExtra{PaymentFlow: "authorization"}.Map()), facilitatorKind(nil))
		require.NoError(t, err)
		assert.Equal(t, "authorization", enhanced.Extra["paymentFlow"])
		assert.NotContains(t, enhanced.Extra, "captureMode")
		assert.Equal(t, evm.NormalizeAddress(testSignerAddress), enhanced.Extra["receiverAuthorizer"])
	})

	t.Run("the facilitator's operator allowlist stays off the wire", func(t *testing.T) {
		enhanced, err := enhance(signedScheme(), routeRequirements(map[string]interface{}{}),
			facilitatorKind(map[string]interface{}{"operators": []interface{}{map[string]interface{}{"address": "*", "operatorType": "custom"}}}))
		require.NoError(t, err)
		assert.NotContains(t, enhanced.Extra, "operators")
	})

	t.Run("the route may restate the signer as receiverAuthorizer", func(t *testing.T) {
		enhanced, err := enhance(signedScheme(), routeRequirements(map[string]interface{}{"receiverAuthorizer": testSignerAddress}), facilitatorKind(nil))
		require.NoError(t, err)
		assert.Equal(t, evm.NormalizeAddress(testSignerAddress), enhanced.Extra["receiverAuthorizer"])
	})
}

func TestEnhance_CustomOperators(t *testing.T) {
	custom := AuthCaptureRouteExtra{OperatorType: "custom", CaptureMode: "deferred", CaptureAuthorizer: testCustomOperator}.Map()
	admitted := func(address string) map[string]interface{} {
		return map[string]interface{}{"operators": []interface{}{map[string]interface{}{"address": address, "operatorType": "custom"}}}
	}

	t.Run("an allowlisted operator is published", func(t *testing.T) {
		enhanced, err := enhance(signedScheme(), routeRequirements(custom), facilitatorKind(admitted(testCustomOperator)))
		require.NoError(t, err)
		assert.Equal(t, "custom", enhanced.Extra["operatorType"])
		assert.Equal(t, "deferred", enhanced.Extra["captureMode"])
		assert.Equal(t, evm.NormalizeAddress(testCustomOperator), enhanced.Extra["captureAuthorizer"])
	})

	t.Run("a wildcard entry admits any operator", func(t *testing.T) {
		_, err := enhance(signedScheme(), routeRequirements(custom), facilitatorKind(admitted("*")))
		require.NoError(t, err)
	})

	t.Run("an operator off the allowlist fails fast", func(t *testing.T) {
		_, err := enhance(signedScheme(), routeRequirements(custom), facilitatorKind(admitted(testOtherOperator)))
		require.ErrorContains(t, err, ErrOperatorNotAdmitted)
	})

	t.Run("a facilitator without an allowlist fails fast", func(t *testing.T) {
		_, err := enhance(signedScheme(), routeRequirements(custom), facilitatorKind(nil))
		require.ErrorContains(t, err, ErrOperatorNotAdmitted)
	})

	t.Run("an allowlist entry of another type does not admit", func(t *testing.T) {
		kind := facilitatorKind(map[string]interface{}{"operators": []interface{}{map[string]interface{}{"address": "*", "operatorType": "delegated"}}})
		_, err := enhance(signedScheme(), routeRequirements(custom), kind)
		require.ErrorContains(t, err, ErrOperatorNotAdmitted)
	})

	t.Run("a custom operator never defaults to the facilitator's", func(t *testing.T) {
		route := AuthCaptureRouteExtra{OperatorType: "custom", CaptureMode: "deferred"}.Map()
		_, err := enhance(signedScheme(), routeRequirements(route), facilitatorKind(admitted("*")))
		require.ErrorContains(t, err, ErrMissingCaptureAuthorizer)
	})

	t.Run("a collect-only route needs no signer", func(t *testing.T) {
		scheme := NewAuthCaptureEvmScheme(&Config{})
		collectOnly := AuthCaptureRouteExtra{
			OperatorType: "custom", CaptureMode: "deferred", CaptureAuthorizer: testCustomOperator, ReceiverAuthorizer: authcapture.ZeroAddress,
		}.Map()
		enhanced, err := enhance(scheme, routeRequirements(collectOnly), facilitatorKind(admitted("*")))
		require.NoError(t, err)
		assert.Equal(t, authcapture.ZeroAddress, enhanced.Extra["receiverAuthorizer"])
	})
}

func TestEnhance_RoutesThatSignNeedAnAuthorizer(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{CaptureAuthorizer: testCaptureAuthorizer})
	for name, route := range map[string]map[string]interface{}{
		"sync escrow":   {},
		"authorization": {"paymentFlow": "authorization"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := enhance(scheme, routeRequirements(route), facilitatorKind(nil))
			require.ErrorContains(t, err, ErrMissingReceiverAuthorizer)
		})
	}

	t.Run("deferred escrow must name its authorizer or be explicitly collect-only", func(t *testing.T) {
		deferred := map[string]interface{}{"captureMode": "deferred"}
		_, err := enhance(scheme, routeRequirements(deferred), facilitatorKind(nil))
		require.ErrorContains(t, err, ErrMissingReceiverAuthorizer)

		deferred["receiverAuthorizer"] = authcapture.ZeroAddress
		_, err = enhance(scheme, routeRequirements(deferred), facilitatorKind(nil))
		require.NoError(t, err)
	})
}

func TestValidateFacilitatorSupport_CustomOperatorsNeedNoCaptureAuthorizer(t *testing.T) {
	kind := types.SupportedKind{Extra: map[string]interface{}{"operators": []interface{}{}}}
	require.ErrorContains(t, NewAuthCaptureEvmScheme(&Config{}).ValidateFacilitatorSupport(testNetwork, kind, nil), "receiverAuthorizer")
	require.NoError(t, NewAuthCaptureEvmScheme(&Config{CollectOnlyRoutes: true}).ValidateFacilitatorSupport(testNetwork, kind, nil))
	require.NoError(t, newTestScheme(&mockSigner{address: testSignerAddress}).ValidateFacilitatorSupport(testNetwork, kind, nil))
}

func TestAuthCaptureRouteExtra_Map(t *testing.T) {
	assert.Empty(t, AuthCaptureRouteExtra{}.Map())

	capture, refund := uint64(600), uint64(1200)
	route := AuthCaptureRouteExtra{
		PaymentFlow:            "escrow",
		CaptureMode:            "deferred",
		OperatorType:           "delegated",
		MinFeeBps:              ptr(uint16(0)),
		CaptureDeadlineSeconds: &capture,
		RefundDeadlineSeconds:  &refund,
	}.Map()
	assert.Equal(t, "deferred", route["captureMode"])
	assert.Equal(t, float64(0), route["minFeeBps"], "an explicit zero bound is kept")
	assert.Equal(t, float64(600), route["captureDeadlineSeconds"])
	assert.NotContains(t, route, "maxFeeBps")

	_, err := enhance(signedScheme(), routeRequirements(route), facilitatorKind(nil))
	require.NoError(t, err)
}

func ptr[T any](value T) *T { return &value }

func TestEnhance_ReceiverAuthorizerResolution(t *testing.T) {
	const (
		facilitatorAuthorizer = "0x2222222222222222222222222222222222222222"
		other                 = "0x9999999999999999999999999999999999999999"
	)
	route := func(overrides map[string]interface{}) types.PaymentRequirements {
		extra := map[string]interface{}{"captureAuthorizer": testCaptureAuthorizer}
		for key, value := range overrides {
			extra[key] = value
		}
		return routeRequirements(extra)
	}
	kind := func(extra map[string]interface{}) types.SupportedKind { return facilitatorKind(extra) }
	unsignedScheme := func() *AuthCaptureEvmScheme { return NewAuthCaptureEvmScheme(&Config{}) }

	t.Run("defaults an omitted route authorizer to the facilitator-advertised one", func(t *testing.T) {
		result, err := enhance(unsignedScheme(), route(nil), kind(map[string]interface{}{"receiverAuthorizer": facilitatorAuthorizer}))
		require.NoError(t, err)
		assert.Equal(t, facilitatorAuthorizer, result.Extra["receiverAuthorizer"])
		assert.Equal(t, "sync", result.Extra["captureMode"])
	})

	t.Run("accepts a route authorizer equal to the facilitator-advertised one", func(t *testing.T) {
		result, err := enhance(unsignedScheme(),
			route(map[string]interface{}{"receiverAuthorizer": "0x2222222222222222222222222222222222222222"}),
			kind(map[string]interface{}{"receiverAuthorizer": facilitatorAuthorizer}))
		require.NoError(t, err)
		assert.Equal(t, facilitatorAuthorizer, result.Extra["receiverAuthorizer"])
	})

	t.Run("lets the scheme signer win over a facilitator-advertised authorizer", func(t *testing.T) {
		result, err := enhance(signedScheme(), route(nil), kind(map[string]interface{}{"receiverAuthorizer": facilitatorAuthorizer}))
		require.NoError(t, err)
		assert.Equal(t, evm.NormalizeAddress(testSignerAddress), result.Extra["receiverAuthorizer"])
	})

	t.Run("throws naming all three fixes when nothing can authorize", func(t *testing.T) {
		_, err := enhance(unsignedScheme(), route(map[string]interface{}{"captureMode": "deferred"}), kind(nil))
		require.ErrorContains(t, err, "ReceiverAuthorizerSigner")
		require.ErrorContains(t, err, "delegates the authorizer")
		require.ErrorContains(t, err, "zero address")
	})

	t.Run("throws when the route names a non-zero authorizer nobody can sign for", func(t *testing.T) {
		_, err := enhance(unsignedScheme(),
			route(map[string]interface{}{"receiverAuthorizer": other}),
			kind(map[string]interface{}{"receiverAuthorizer": facilitatorAuthorizer}))
		require.ErrorContains(t, err, "can not be signed")
		require.ErrorContains(t, err, ErrUnsignableReceiverAuthorizer)
	})

	t.Run("allows an explicit zero authorizer for escrow deferred, ignoring the advertisement", func(t *testing.T) {
		result, err := enhance(unsignedScheme(),
			route(map[string]interface{}{"receiverAuthorizer": authcapture.ZeroAddress, "captureMode": "deferred"}),
			kind(map[string]interface{}{"receiverAuthorizer": facilitatorAuthorizer}))
		require.NoError(t, err)
		assert.Equal(t, authcapture.ZeroAddress, result.Extra["receiverAuthorizer"])
	})

	t.Run("rejects an explicit zero authorizer on escrow sync and on authorization", func(t *testing.T) {
		_, err := enhance(unsignedScheme(), route(map[string]interface{}{"receiverAuthorizer": authcapture.ZeroAddress}), kind(nil))
		require.ErrorContains(t, err, "non-zero receiverAuthorizer")
		_, err = enhance(unsignedScheme(),
			route(map[string]interface{}{"receiverAuthorizer": authcapture.ZeroAddress, "paymentFlow": "authorization"}), kind(nil))
		require.ErrorContains(t, err, "non-zero receiverAuthorizer")
	})

	t.Run("keeps the signer's conflict check against a different route authorizer", func(t *testing.T) {
		_, err := enhance(signedScheme(), route(map[string]interface{}{"receiverAuthorizer": other}), kind(nil))
		require.ErrorContains(t, err, ErrReceiverAuthorizerMismatch)
	})

	t.Run("delegates an authorization route to the facilitator authorizer", func(t *testing.T) {
		result, err := enhance(unsignedScheme(),
			route(map[string]interface{}{"paymentFlow": "authorization"}),
			kind(map[string]interface{}{"receiverAuthorizer": facilitatorAuthorizer}))
		require.NoError(t, err)
		assert.Equal(t, facilitatorAuthorizer, result.Extra["receiverAuthorizer"])
		assert.Equal(t, "authorization", result.Extra["paymentFlow"])
	})

	t.Run("ignores a zero facilitator advertisement", func(t *testing.T) {
		_, err := enhance(unsignedScheme(), route(nil), kind(map[string]interface{}{"receiverAuthorizer": authcapture.ZeroAddress}))
		require.ErrorContains(t, err, "has no receiverAuthorizer")
	})
}
