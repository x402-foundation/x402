package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

// recordingFacilitator plays the facilitator behind the real resource server, recording every
// settle payload it is sent.
type recordingFacilitator struct {
	fakeFacilitator
	extra map[string]interface{}
}

func (f *recordingFacilitator) Settle(ctx context.Context, payload, requirements []byte) (*x402.SettleResponse, error) {
	f.payloads = append(f.payloads, payload)
	var decoded types.PaymentPayload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return nil, err
	}
	transaction := "0xcollect"
	if kind, _ := decoded.Payload["type"].(string); kind != "" {
		transaction = "0x" + kind
	} else if _, charged := decoded.Payload["authorizerSignature"]; charged {
		transaction = "0xcharge"
	}
	return &x402.SettleResponse{Success: true, Transaction: transaction, Network: testNetwork, Payer: testPayer}, nil
}

func (f *recordingFacilitator) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{Kinds: []types.SupportedKind{{
		X402Version: 2, Scheme: authcapture.SchemeAuthCapture, Network: testNetwork, Extra: f.extra,
	}}}, nil
}

// coreServer wires the scheme into the real resource server and returns the requirements a
// route with the given extra would publish.
func coreServer(t *testing.T, route map[string]interface{}) (resourceServer, *AuthCaptureEvmScheme, *recordingFacilitator, types.PaymentRequirements) {
	t.Helper()
	facilitator := &recordingFacilitator{extra: map[string]interface{}{"captureAuthorizer": testCaptureAuthorizer}}
	scheme := newTestScheme(&mockSigner{address: testSignerAddress})
	server := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilitator))
	server.Register(testNetwork, scheme)
	require.NoError(t, server.Initialize(context.Background()))

	built, err := server.BuildPaymentRequirementsFromConfig(context.Background(), x402.ResourceConfig{
		Scheme:            authcapture.SchemeAuthCapture,
		PayTo:             testPayTo,
		Price:             map[string]interface{}{"amount": "1000000", "asset": testAsset, "extra": map[string]interface{}{"name": "USDC", "version": "2"}},
		Network:           testNetwork,
		MaxTimeoutSeconds: 300,
		Extra:             route,
	})
	require.NoError(t, err)
	require.Len(t, built, 1)
	return server, scheme, facilitator, built[0]
}

// resourceServer is the part of the core resource server these tests drive.
type resourceServer interface {
	SettlePaymentWithExtensions(
		ctx context.Context, payload types.PaymentPayload, requirements types.PaymentRequirements,
		overrides *x402.SettlementOverrides, declaredExtensions map[string]interface{}, phase x402.SettlePhase,
	) (*x402.SettleResponse, error)
	FindMatchingRequirements(available []types.PaymentRequirements, payload types.PaymentPayload) *types.PaymentRequirements
}

func paymentFor(requirements types.PaymentRequirements) types.PaymentPayload {
	return types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload: map[string]interface{}{
			"authorization": map[string]interface{}{
				"from": testPayer, "to": authcapture.EIP3009TokenCollectorAddress, "value": requirements.Amount,
				"validAfter": "0", "validBefore": "1700003600",
				"nonce": "0x1111111111111111111111111111111111111111111111111111111111111111",
			},
			"signature": "0xdeadbeef",
			"salt":      "0x2222222222222222222222222222222222222222222222222222222222222222",
			"saltNonce": "0x01",
		},
	}
}

func settleAt(t *testing.T, server resourceServer, payload types.PaymentPayload, requirements types.PaymentRequirements, phase x402.SettlePhase, overrides *x402.SettlementOverrides) *x402.SettleResponse {
	t.Helper()
	result, err := server.SettlePaymentWithExtensions(context.Background(), payload, requirements, overrides, nil, phase)
	require.NoError(t, err)
	require.True(t, result.Success)
	return result
}

func lastSent(t *testing.T, facilitator *recordingFacilitator) types.PaymentPayload {
	t.Helper()
	require.NotEmpty(t, facilitator.payloads)
	var payload types.PaymentPayload
	require.NoError(t, json.Unmarshal(facilitator.payloads[len(facilitator.payloads)-1], &payload))
	return payload
}

func TestCoreServer_DeferredRouteCapturesLaterThroughTheManager(t *testing.T) {
	server, scheme, facilitator, requirements := coreServer(t, AuthCaptureRouteExtra{CaptureMode: "deferred"}.Map())
	payload := paymentFor(requirements)

	settleAt(t, server, payload, requirements, x402.SettlePhaseBeforeHandler, nil)
	require.Len(t, facilitator.payloads, 1)

	afterHandler := settleAt(t, server, payload, requirements, x402.SettlePhaseAfterHandler, nil)
	assert.Equal(t, "0xcollect", afterHandler.Transaction, "the after-handler settle echoes the collect receipt")
	assert.Len(t, facilitator.payloads, 1, "and never reaches the facilitator")

	records, err := scheme.Storage().List(context.Background())
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Equal(t, "1000000", records[0].CapturableAmount)

	manager := scheme.NewLifecycleManager(facilitator)
	response, err := manager.Capture(context.Background(), records[0].PaymentInfoHash, nil)
	require.NoError(t, err)
	assert.Equal(t, "0xcapture", response.Transaction)
	assert.True(t, authcapture.IsCapturePayload(lastSent(t, facilitator).Payload))
}

func TestCoreServer_SyncRouteCapturesAfterTheHandler(t *testing.T) {
	server, scheme, facilitator, requirements := coreServer(t, nil)
	payload := paymentFor(requirements)

	settleAt(t, server, payload, requirements, x402.SettlePhaseBeforeHandler, nil)
	settleAt(t, server, payload, requirements, x402.SettlePhaseAfterHandler, &x402.SettlementOverrides{Amount: "400000"})

	sent := lastSent(t, facilitator)
	assert.True(t, authcapture.IsCapturePayload(sent.Payload))
	assert.Equal(t, "400000", sent.Payload["amount"])
	assert.Contains(t, sent.Payload, "voidAuthorizerSignature")

	records, err := scheme.Storage().List(context.Background())
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Equal(t, "0", records[0].CapturableAmount)
	assert.Equal(t, "400000", records[0].RefundableAmount)
}

func TestCoreServer_AuthorizationRouteChargesAfterTheHandler(t *testing.T) {
	server, scheme, facilitator, requirements := coreServer(t, AuthCaptureRouteExtra{PaymentFlow: "authorization"}.Map())
	payload := paymentFor(requirements)

	result := settleAt(t, server, payload, requirements, x402.SettlePhaseAfterHandler, &x402.SettlementOverrides{Amount: "250000"})
	assert.Equal(t, "0xcharge", result.Transaction)

	sent := lastSent(t, facilitator)
	assert.True(t, authcapture.IsEip3009Payload(sent.Payload))
	assert.Equal(t, "250000", sent.Payload["amount"])
	assert.Contains(t, sent.Payload, "authorizerSignature")
	assert.NotContains(t, sent.Payload, "type")

	records, err := scheme.Storage().List(context.Background())
	require.NoError(t, err)
	require.Len(t, records, 1)
	assert.Equal(t, "250000", records[0].RefundableAmount)
}

func TestCoreServer_PaymentStillMatchesAfterTheDeadlineBucketRolls(t *testing.T) {
	server, _, _, requirements := coreServer(t, AuthCaptureRouteExtra{CaptureMode: "deferred"}.Map())
	payload := paymentFor(requirements)
	payload.Accepted.Extra = overlay(payload.Accepted.Extra, map[string]interface{}{
		"captureDeadline": requirements.Extra["captureDeadline"].(uint64) - 60,
		"refundDeadline":  requirements.Extra["refundDeadline"].(uint64) - 60,
	})

	assert.NotNil(t, server.FindMatchingRequirements([]types.PaymentRequirements{requirements}, payload))
}
