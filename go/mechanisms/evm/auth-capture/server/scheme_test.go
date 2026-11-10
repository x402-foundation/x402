package server

import (
	"context"
	"math/big"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

type mockSigner struct {
	address string
	sig     []byte
	err     error

	lastDomain      evm.TypedDataDomain
	lastTypes       map[string][]evm.TypedDataField
	lastPrimaryType string
	lastMessage     map[string]interface{}
}

func (m *mockSigner) Address() string { return m.address }
func (m *mockSigner) SignTypedData(_ context.Context, domain evm.TypedDataDomain, types map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}) ([]byte, error) {
	m.lastDomain = domain
	m.lastTypes = types
	m.lastPrimaryType = primaryType
	m.lastMessage = message
	if m.err != nil {
		return nil, m.err
	}
	if m.sig != nil {
		return m.sig, nil
	}
	return []byte{0xde, 0xad, 0xbe, 0xef}, nil
}

const (
	testNetwork           = "eip155:84532"
	testCaptureAuthorizer = "0xcccccccccccccccccccccccccccccccccccccccc"
	testFeeRecipient      = "0x4444444444444444444444444444444444444444"
	testPayTo             = "0x1234567890123456789012345678901234567890"
	testAsset             = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	testPayer             = "0x9999999999999999999999999999999999999999"
)

func mockRequirements(extra map[string]interface{}) types.PaymentRequirements {
	future := time.Now().Unix() + 86400
	baseExtra := map[string]interface{}{
		"captureAuthorizer":  testCaptureAuthorizer,
		"receiverAuthorizer": testSignerAddress,
		"captureDeadline":    float64(future),
		"refundDeadline":     float64(future + 86400),
		"feeRecipient":       testFeeRecipient,
		"minFeeBps":          float64(0),
		"maxFeeBps":          float64(100),
		"name":               "USDC",
		"version":            "2",
	}
	for k, v := range extra {
		baseExtra[k] = v
	}
	return types.PaymentRequirements{
		Scheme:            authcapture.SchemeAuthCapture,
		Network:           testNetwork,
		Amount:            "1000000",
		Asset:             testAsset,
		PayTo:             testPayTo,
		MaxTimeoutSeconds: 300,
		Extra:             baseExtra,
	}
}

func eip3009CollectPayload(extra map[string]interface{}) types.PaymentPayload {
	requirements := mockRequirements(extra)
	return types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload: map[string]interface{}{
			"authorization": map[string]interface{}{
				"from":        testPayer,
				"to":          authcapture.EIP3009TokenCollectorAddress,
				"value":       requirements.Amount,
				"validAfter":  "0",
				"validBefore": "1700003600",
				"nonce":       "0x1111111111111111111111111111111111111111111111111111111111111111",
			},
			"signature": "0xdeadbeef",
			"salt":      "0x2222222222222222222222222222222222222222222222222222222222222222",
			"saltNonce": "0x01",
		},
	}
}

func TestValidateFacilitatorSupport(t *testing.T) {
	tests := []struct {
		name          string
		config        *Config
		supportedKind types.SupportedKind
		wantErr       string
	}{
		{
			name:          "no signer and the facilitator advertises no receiverAuthorizer",
			config:        &Config{},
			supportedKind: types.SupportedKind{Extra: map[string]interface{}{"captureAuthorizer": testCaptureAuthorizer}},
			wantErr:       "receiverAuthorizer",
		},
		{
			name:          "facilitator advertises capture and receiver authorizers",
			config:        &Config{},
			supportedKind: types.SupportedKind{Extra: map[string]interface{}{"captureAuthorizer": testCaptureAuthorizer, "receiverAuthorizer": testFacilitatorAddr}},
		},
		{
			name:          "collect-only routes need no receiverAuthorizer",
			config:        &Config{CollectOnlyRoutes: true},
			supportedKind: types.SupportedKind{Extra: map[string]interface{}{"captureAuthorizer": testCaptureAuthorizer}},
		},
		{
			name:          "a zero advertised receiverAuthorizer does not count",
			config:        &Config{},
			supportedKind: types.SupportedKind{Extra: map[string]interface{}{"captureAuthorizer": testCaptureAuthorizer, "receiverAuthorizer": authcapture.ZeroAddress}},
			wantErr:       "receiverAuthorizer",
		},
		{
			name:          "facilitator omits captureAuthorizer",
			config:        &Config{},
			supportedKind: types.SupportedKind{Extra: map[string]interface{}{"receiverAuthorizer": testFacilitatorAddr}},
			wantErr:       "captureAuthorizer",
		},
		{
			name:   "local captureAuthorizer configured",
			config: &Config{ReceiverAuthorizerSigner: &mockSigner{}, CaptureAuthorizer: testCaptureAuthorizer},
		},
		{
			name:          "facilitator-advertised captureAuthorizer",
			config:        &Config{ReceiverAuthorizerSigner: &mockSigner{}},
			supportedKind: types.SupportedKind{Extra: map[string]interface{}{"captureAuthorizer": testCaptureAuthorizer}},
		},
		{
			name:    "neither side supplies a captureAuthorizer",
			config:  &Config{ReceiverAuthorizerSigner: &mockSigner{}},
			wantErr: "no captureAuthorizer is configured",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			scheme := NewAuthCaptureEvmScheme(test.config)
			err := scheme.ValidateFacilitatorSupport(testNetwork, test.supportedKind, nil)
			if test.wantErr != "" {
				require.ErrorContains(t, err, test.wantErr)
				return
			}
			require.NoError(t, err)
		})
	}
}

func newTestScheme(signer *mockSigner) *AuthCaptureEvmScheme {
	return NewAuthCaptureEvmScheme(&Config{ReceiverAuthorizerSigner: signer})
}

func TestEnhancePaymentRequirements_NoAuthorizer(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{CaptureAuthorizer: testCaptureAuthorizer})
	_, err := scheme.EnhancePaymentRequirements(context.Background(), routeRequirements(nil), types.SupportedKind{}, nil)
	require.ErrorContains(t, err, ErrMissingReceiverAuthorizer)
}

func TestEnhancePaymentRequirements_ResolvesLocalConfigFirst(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	minFee := uint16(5)
	maxFee := uint16(50)
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: signer,
		CaptureAuthorizer:        testCaptureAuthorizer,
		FeeRecipient:             testFeeRecipient,
		MinFeeBps:                &minFee,
		MaxFeeBps:                &maxFee,
	})

	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}
	supportedKind := types.SupportedKind{Extra: map[string]interface{}{
		"captureAuthorizer": "0xffffffffffffffffffffffffffffffffffffffff",
		"feeRecipient":      "0xffffffffffffffffffffffffffffffffffffffff",
		"minFeeBps":         float64(1),
		"maxFeeBps":         float64(1),
	}}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
	require.NoError(t, err)

	assert.Equal(t, evm.NormalizeAddress(testCaptureAuthorizer), enhanced.Extra["captureAuthorizer"])
	assert.Equal(t, evm.NormalizeAddress(testFeeRecipient), enhanced.Extra["feeRecipient"])
	assert.Equal(t, uint16(5), enhanced.Extra["minFeeBps"])
	assert.Equal(t, uint16(50), enhanced.Extra["maxFeeBps"])
	assert.Equal(t, evm.NormalizeAddress(signer.address), enhanced.Extra["receiverAuthorizer"])
	assert.Equal(t, "escrow", enhanced.Extra["paymentFlow"])
	assert.Equal(t, "sync", enhanced.Extra["captureMode"])
	assert.Equal(t, "delegated", enhanced.Extra["operatorType"])
	assert.Equal(t, "USDC", enhanced.Extra["name"])
	assert.Equal(t, "2", enhanced.Extra["version"])
	assert.NotEmpty(t, enhanced.Extra["authCaptureEscrow"])
	assert.NotZero(t, enhanced.Extra["captureDeadline"])
	assert.NotZero(t, enhanced.Extra["refundDeadline"])
}

func TestEnhancePaymentRequirements_FallsBackToFacilitatorAdvertisement(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := NewAuthCaptureEvmScheme(&Config{ReceiverAuthorizerSigner: signer})

	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}
	supportedKind := types.SupportedKind{Extra: map[string]interface{}{
		"captureAuthorizer": testCaptureAuthorizer,
		"feeRecipient":      testFeeRecipient,
		"minFeeBps":         float64(2),
		"maxFeeBps":         float64(20),
	}}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
	require.NoError(t, err)

	assert.Equal(t, evm.NormalizeAddress(testCaptureAuthorizer), enhanced.Extra["captureAuthorizer"])
	assert.Equal(t, evm.NormalizeAddress(testFeeRecipient), enhanced.Extra["feeRecipient"])
	assert.Equal(t, uint16(2), enhanced.Extra["minFeeBps"])
	assert.Equal(t, uint16(20), enhanced.Extra["maxFeeBps"])
}

func TestEnhancePaymentRequirements_MissingCaptureAuthorizer(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := NewAuthCaptureEvmScheme(&Config{ReceiverAuthorizerSigner: signer})

	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}

	_, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.ErrorContains(t, err, ErrMissingCaptureAuthorizer)
}

func TestEnhancePaymentRequirements_NoFeeTermsPublishesZeroRecipient(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		CaptureAuthorizer:        testCaptureAuthorizer,
	})
	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.NoError(t, err)

	assert.Equal(t, authcapture.ZeroAddress, enhanced.Extra["feeRecipient"])
	assert.Equal(t, uint16(0), enhanced.Extra["minFeeBps"])
	assert.Equal(t, uint16(0), enhanced.Extra["maxFeeBps"])
}

func TestEnhancePaymentRequirements_ConfiguredRecipientDefaultsToNoFee(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		CaptureAuthorizer:        testCaptureAuthorizer,
		FeeRecipient:             testFeeRecipient,
	})
	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.NoError(t, err)

	assert.Equal(t, uint16(0), enhanced.Extra["minFeeBps"])
	assert.Equal(t, uint16(0), enhanced.Extra["maxFeeBps"])
}

func TestEnhancePaymentRequirements_InvalidFeeTerms(t *testing.T) {
	maxFee := uint16(100)
	overMax := uint16(10001)
	minFee := uint16(200)
	tests := []struct {
		name    string
		config  Config
		wantErr string
	}{
		{name: "non-zero bounds without a recipient", config: Config{MaxFeeBps: &maxFee}, wantErr: ErrMissingFeeRecipient},
		{name: "min above max", config: Config{FeeRecipient: testFeeRecipient, MinFeeBps: &minFee, MaxFeeBps: &maxFee}, wantErr: ErrInvalidFeeTerms},
		{name: "max above 10000", config: Config{FeeRecipient: testFeeRecipient, MaxFeeBps: &overMax}, wantErr: ErrInvalidFeeTerms},
		{name: "malformed recipient", config: Config{FeeRecipient: "not-an-address"}, wantErr: ErrInvalidFeeTerms},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := test.config
			config.ReceiverAuthorizerSigner = &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
			config.CaptureAuthorizer = testCaptureAuthorizer
			requirements := mockRequirements(nil)
			requirements.Extra = map[string]interface{}{}

			_, err := NewAuthCaptureEvmScheme(&config).EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
			require.ErrorContains(t, err, test.wantErr)
		})
	}
}

func TestEnhancePaymentRequirements_TimeoutMustFitCaptureDeadline(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		CaptureAuthorizer:        testCaptureAuthorizer,
		CaptureDeadline:          time.Minute,
	})
	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}
	requirements.MaxTimeoutSeconds = 61

	_, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.ErrorContains(t, err, ErrTimeoutExceedsCaptureDeadline)

	requirements.MaxTimeoutSeconds = 60
	_, err = scheme.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.NoError(t, err)
}

func TestEnhancePaymentRequirements_CopiesThroughExtensionKeys(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: signer,
		CaptureAuthorizer:        testCaptureAuthorizer,
		FeeRecipient:             testFeeRecipient,
	})

	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}
	supportedKind := types.SupportedKind{Extra: map[string]interface{}{"someExtensionField": "value"}}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, []string{"someExtensionField"})
	require.NoError(t, err)

	assert.Equal(t, "value", enhanced.Extra["someExtensionField"])
}

func TestEnhancePaymentRequirements_ParsesDollarAmount(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := NewAuthCaptureEvmScheme(&Config{
		ReceiverAuthorizerSigner: signer,
		CaptureAuthorizer:        testCaptureAuthorizer,
		FeeRecipient:             testFeeRecipient,
	})

	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}
	requirements.Amount = "1.5"

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.NoError(t, err)
	assert.Equal(t, "1500000", enhanced.Amount)
}

func TestEnrichSettlementPayload_BeforeHandlerNoOp(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := newTestScheme(signer)

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(nil),
		Requirements: mockRequirements(nil),
		Phase:        x402.SettlePhaseBeforeHandler,
	})
	require.NoError(t, err)
	assert.Nil(t, fields)
}

// mergeEnrichment applies the core's additive settlement-payload policy and merge.
func mergeEnrichment(t *testing.T, payload types.PaymentPayload, enrichment map[string]interface{}) map[string]interface{} {
	t.Helper()
	require.NoError(t, x402.AssertAdditivePayloadEnrichment(payload.Payload, enrichment, "auth-capture"))
	merged := map[string]interface{}{}
	for k, v := range payload.Payload {
		merged[k] = v
	}
	for k, v := range enrichment {
		merged[k] = v
	}
	return merged
}

func TestEnrichSettlementPayload_AfterHandlerSignsCapture(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := newTestScheme(signer)
	requirements := mockRequirements(nil)

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(nil),
		Requirements: requirements,
		Phase:        x402.SettlePhaseAfterHandler,
	})
	require.NoError(t, err)

	assert.True(t, authcapture.IsCapturePayload(mergeEnrichment(t, eip3009CollectPayload(nil), fields)))
	assert.Equal(t, "capture", fields["type"])
	assert.Equal(t, requirements.Amount, fields["amount"])
	assert.Equal(t, requirements.Amount, fields["expectedCapturableAmount"])
	assert.Equal(t, "0", fields["expectedRefundableAmount"])
	assert.Equal(t, "0xdeadbeef", fields["authorizerSignature"])
	assert.NotContains(t, fields, "voidAuthorizerSignature")

	// v1.1 is the default deployment: feeAmount (absolute), not feeBps.
	assert.Contains(t, fields, "feeAmount")
	assert.NotContains(t, fields, "feeBps")

	assert.Equal(t, "Capture", signer.lastPrimaryType)
	assert.Equal(t, authcapture.OperatorEIP712Domain.Name, signer.lastDomain.Name)
	assert.Equal(t, authcapture.OperatorEIP712Domain.Version, signer.lastDomain.Version)
	assert.Equal(t, evm.NormalizeAddress(testCaptureAuthorizer), signer.lastDomain.VerifyingContract)
	assert.Equal(t, requirements.Amount, signer.lastMessage["amount"].(*big.Int).String())
	assert.Equal(t, evm.NormalizeAddress(testFeeRecipient), signer.lastMessage["feeReceiver"])
}

func TestEnrichSettlementPayload_AfterHandlerV1_0UsesFeeBps(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := newTestScheme(signer)
	requirements := mockRequirements(map[string]interface{}{
		"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address,
		"minFeeBps":         float64(25),
	})

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(map[string]interface{}{"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address}),
		Requirements: requirements,
		Phase:        x402.SettlePhaseAfterHandler,
	})
	require.NoError(t, err)

	assert.Contains(t, fields, "feeBps")
	assert.NotContains(t, fields, "feeAmount")
	assert.Equal(t, uint16(25), fields["feeBps"])
	assert.Equal(t, "Capture", signer.lastPrimaryType)
	assert.Contains(t, signer.lastMessage, "feeBps")
}

func TestEnrichSettlementPayload_CancelSignsVoid(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := newTestScheme(signer)
	requirements := mockRequirements(nil)

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(nil),
		Requirements: requirements,
		Phase:        x402.SettlePhaseCancel,
	})
	require.NoError(t, err)

	assert.True(t, authcapture.IsVoidPayload(mergeEnrichment(t, eip3009CollectPayload(nil), fields)))
	assert.Equal(t, "void", fields["type"])
	assert.NotEmpty(t, fields["authorizerSignature"])
	assert.Equal(t, "Void", signer.lastPrimaryType)
	assert.Equal(t, evm.NormalizeAddress(testCaptureAuthorizer), signer.lastDomain.VerifyingContract)
	assert.Len(t, signer.lastMessage, 1)
	assert.Contains(t, signer.lastMessage, "paymentInfoHash")
}

func TestEnrichSettlementPayload_InvalidCollectPayload(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := newTestScheme(signer)

	badPayload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    mockRequirements(nil),
		Payload:     map[string]interface{}{"foo": "bar"},
	}

	_, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      badPayload,
		Requirements: mockRequirements(nil),
		Phase:        x402.SettlePhaseAfterHandler,
	})
	require.ErrorContains(t, err, ErrInvalidCollectPayload)
}

func TestEnrichSettlementPayload_SignerError(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", err: assert.AnError}
	scheme := newTestScheme(signer)

	_, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(nil),
		Requirements: mockRequirements(nil),
		Phase:        x402.SettlePhaseAfterHandler,
	})
	require.ErrorContains(t, err, ErrFailedToSignCapture)
}

func TestSettleOnCancel(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := newTestScheme(signer)
	requirements := mockRequirements(nil)

	tests := []struct {
		name       string
		reason     x402.VerifiedPaymentCancellationReason
		wantResult bool
	}{
		{name: "handler failed", reason: x402.CancellationReasonHandlerFailed, wantResult: true},
		{name: "handler threw", reason: x402.CancellationReasonHandlerThrew, wantResult: true},
		{name: "after verify aborted", reason: x402.CancellationReasonAfterVerifyAborted, wantResult: true},
		{name: "unknown reason", reason: "something_else", wantResult: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := scheme.SettleOnCancel(x402.VerifiedPaymentCanceledContext{
				SettleContext: x402.SettleContext{Requirements: requirements},
				Reason:        test.reason,
				SettledPhases: []x402.SettlePhase{x402.SettlePhaseBeforeHandler},
			})
			require.NoError(t, err)
			if !test.wantResult {
				assert.Nil(t, result)
				return
			}
			require.NotNil(t, result)
			assert.Equal(t, requirements.Amount, result.Amount)
			assert.Equal(t, requirements.PayTo, result.PayTo)
		})
	}
}

func TestSettleOnCancel_SkipsWithoutBeforeHandlerSettle(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})

	result, err := scheme.SettleOnCancel(x402.VerifiedPaymentCanceledContext{
		SettleContext: x402.SettleContext{Requirements: mockRequirements(nil)},
		Reason:        x402.CancellationReasonAfterVerifyAborted,
	})
	require.NoError(t, err)
	assert.Nil(t, result, "no escrow hold exists before the before-handler settle")
}

func TestParsePrice(t *testing.T) {
	scheme := NewAuthCaptureEvmScheme(&Config{})
	network := x402.Network("eip155:84532")

	t.Run("asset amount passes through", func(t *testing.T) {
		got, err := scheme.ParsePrice(map[string]interface{}{"amount": "42", "asset": "0xasset"}, network)
		require.NoError(t, err)
		assert.Equal(t, "42", got.Amount)
		assert.Equal(t, "0xasset", got.Asset)
	})

	t.Run("asset amount needs a string amount and an asset", func(t *testing.T) {
		_, err := scheme.ParsePrice(map[string]interface{}{"amount": 42, "asset": "0xasset"}, network)
		assert.EqualError(t, err, ErrAmountMustBeString)
		_, err = scheme.ParsePrice(map[string]interface{}{"amount": "42"}, network)
		assert.EqualError(t, err, ErrNoAssetSpecified)
	})

	t.Run("dollar amount uses the network default asset", func(t *testing.T) {
		got, err := scheme.ParsePrice("$0.50", network)
		require.NoError(t, err)
		assert.Equal(t, "500000", got.Amount)
		assert.NotEmpty(t, got.Asset)
	})

	t.Run("a registered parser wins over the default", func(t *testing.T) {
		custom := &x402.AssetAmount{Amount: "7", Asset: "0xcustom"}
		scheme.RegisterMoneyParser(func(string, x402.Network) (*x402.AssetAmount, error) { return custom, nil })
		got, err := scheme.ParsePrice("$1", network)
		require.NoError(t, err)
		assert.Equal(t, *custom, got)
	})
}

func TestEnhancePaymentRequirements_DeadlinesAreRelativeToIssueTime(t *testing.T) {
	newScheme := func(capture, refund time.Duration) *AuthCaptureEvmScheme {
		return NewAuthCaptureEvmScheme(&Config{
			ReceiverAuthorizerSigner: &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
			CaptureAuthorizer:        testCaptureAuthorizer,
			CaptureDeadline:          capture,
			RefundDeadline:           refund,
		})
	}
	requirements := mockRequirements(nil)
	requirements.Extra = map[string]interface{}{}

	enhanced, err := newScheme(0, 0).EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.NoError(t, err)
	assertBucketed(t, enhanced.Extra["captureDeadline"], uint64(DefaultCaptureDeadline/time.Second))
	assertBucketed(t, enhanced.Extra["refundDeadline"], uint64(DefaultRefundDeadline/time.Second))

	_, err = newScheme(time.Hour, time.Minute).EnhancePaymentRequirements(context.Background(), requirements, types.SupportedKind{}, nil)
	require.ErrorContains(t, err, ErrRefundBeforeCaptureDeadline)
}

// assertBucketed checks a deadline is the start of the current (or just-ended) minute plus offset.
func assertBucketed(t *testing.T, deadline interface{}, offset uint64) {
	t.Helper()
	got, ok := deadline.(uint64)
	require.True(t, ok, "deadline is %T", deadline)
	start := got - offset
	assert.Zero(t, start%deadlineBucketSeconds)
	now := uint64(time.Now().Unix())
	assert.True(t, start <= now && now-start < 2*deadlineBucketSeconds, "bucket start %d is not within a minute of %d", start, now)
}

func TestEnrichSettlementPayload_PartialCaptureVoidsRemainder(t *testing.T) {
	signer := &mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
	scheme := newTestScheme(signer)
	payload := eip3009CollectPayload(nil)
	override := mockRequirements(nil)
	override.Amount = "400000"

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      payload,
		Requirements: override,
		Phase:        x402.SettlePhaseAfterHandler,
	})
	require.NoError(t, err)

	assert.True(t, authcapture.IsCapturePayload(mergeEnrichment(t, payload, fields)))
	assert.Equal(t, "400000", fields["amount"])
	assert.Equal(t, "1000000", fields["expectedCapturableAmount"])
	assert.Equal(t, "0", fields["expectedRefundableAmount"])
	assert.Equal(t, "0xdeadbeef", fields["voidAuthorizerSignature"])
	assert.Equal(t, "1000000", fields["paymentInfo"].(map[string]interface{})["maxAmount"])
	assert.Equal(t, "Void", signer.lastPrimaryType)
}

func TestEnrichSettlementPayload_PartialCaptureFeeFollowsCaptureAmount(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	override := mockRequirements(map[string]interface{}{"minFeeBps": float64(100)})
	override.Amount = "400000"

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(nil),
		Requirements: override,
		Phase:        x402.SettlePhaseAfterHandler,
	})
	require.NoError(t, err)

	assert.Equal(t, "4000", fields["feeAmount"])
}

func TestEnrichSettlementPayload_CaptureAmountMustFitAuthorizedHold(t *testing.T) {
	for _, amount := range []string{"1000001", "0", "abc"} {
		t.Run(amount, func(t *testing.T) {
			scheme := newTestScheme(&mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
			override := mockRequirements(nil)
			override.Amount = amount

			_, err := scheme.EnrichSettlementPayload(x402.SettleContext{
				Ctx:          context.Background(),
				Payload:      eip3009CollectPayload(nil),
				Requirements: override,
				Phase:        x402.SettlePhaseAfterHandler,
			})
			require.ErrorContains(t, err, ErrInvalidCaptureAmount)
		})
	}
}

func TestEnrichSettlementPayload_CancelAfterAmountOverrideUsesAuthorizedHold(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	override := mockRequirements(nil)
	override.Amount = "400000"

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(nil),
		Requirements: override,
		Phase:        x402.SettlePhaseCancel,
	})
	require.NoError(t, err)
	assert.Equal(t, "1000000", fields["paymentInfo"].(map[string]interface{})["maxAmount"])
}

func TestCollectPayloadFields_Permit2UsesPermittedAmount(t *testing.T) {
	fields, err := collectPayloadFields(map[string]interface{}{
		"permit2Authorization": map[string]interface{}{
			"from":      testPayer,
			"spender":   authcapture.Permit2TokenCollectorAddress,
			"nonce":     "1",
			"deadline":  "1700003600",
			"permitted": map[string]interface{}{"token": testAsset, "amount": "750000"},
		},
		"signature": "0xdeadbeef",
		"salt":      "0x22",
		"saltNonce": "0x01",
	})
	require.NoError(t, err)
	assert.Equal(t, "750000", fields.authorizedAmount)
	assert.Equal(t, uint64(1700003600), fields.preApprovalExpiry)
	assert.Equal(t, testPayer, fields.payer)
}

func TestEnhancePaymentRequirements_MerchantExtraWinsOverFacilitatorKind(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	requirements := mockRequirements(map[string]interface{}{"minFeeBps": float64(3), "maxFeeBps": float64(30)})
	supportedKind := types.SupportedKind{Extra: map[string]interface{}{
		"captureAuthorizer": "0xffffffffffffffffffffffffffffffffffffffff",
		"feeRecipient":      "0xffffffffffffffffffffffffffffffffffffffff",
		"minFeeBps":         float64(1),
		"maxFeeBps":         float64(1),
		"name":              "Facilitator Name",
	}}

	enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
	require.NoError(t, err)

	assert.Equal(t, evm.NormalizeAddress(testCaptureAuthorizer), enhanced.Extra["captureAuthorizer"])
	assert.Equal(t, evm.NormalizeAddress(testFeeRecipient), enhanced.Extra["feeRecipient"])
	assert.Equal(t, uint16(3), enhanced.Extra["minFeeBps"])
	assert.Equal(t, uint16(30), enhanced.Extra["maxFeeBps"])
	assert.Equal(t, "USDC", enhanced.Extra["name"])
}

func TestAssetDerivedExtra(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	const (
		permit2Only  = x402.Network("eip155:38833")
		permit2With  = x402.Network("eip155:4326")
		eip3009Asset = x402.Network("eip155:84532")
	)

	t.Run("eip3009 default asset carries the domain only", func(t *testing.T) {
		got, err := scheme.ParsePrice("$1", eip3009Asset)
		require.NoError(t, err)
		assert.Contains(t, got.Extra, "name")
		assert.Contains(t, got.Extra, "version")
		assert.NotContains(t, got.Extra, "assetTransferMethod")
	})

	t.Run("permit2 asset without eip2612 publishes the method and no domain", func(t *testing.T) {
		got, err := scheme.ParsePrice("$1", permit2Only)
		require.NoError(t, err)
		assert.Equal(t, "permit2", got.Extra["assetTransferMethod"])
		assert.NotContains(t, got.Extra, "name")
		assert.NotContains(t, got.Extra, "version")
	})

	t.Run("permit2 asset with eip2612 publishes the method and the domain", func(t *testing.T) {
		got, err := scheme.ParsePrice("$1", permit2With)
		require.NoError(t, err)
		assert.Equal(t, "permit2", got.Extra["assetTransferMethod"])
		assert.Contains(t, got.Extra, "name")
		assert.Contains(t, got.Extra, "version")
	})

	t.Run("enhance leaves the domain off a permit2-only asset", func(t *testing.T) {
		requirements := mockRequirements(nil)
		requirements.Network = string(permit2Only)
		requirements.Asset = ""
		requirements.Extra = map[string]interface{}{"assetTransferMethod": "permit2"}
		supportedKind := types.SupportedKind{Extra: map[string]interface{}{
			"captureAuthorizer": testCaptureAuthorizer,
			"feeRecipient":      testFeeRecipient,
			"minFeeBps":         float64(0),
			"maxFeeBps":         float64(100),
		}}

		enhanced, err := scheme.EnhancePaymentRequirements(context.Background(), requirements, supportedKind, nil)
		require.NoError(t, err)
		assert.Equal(t, "permit2", enhanced.Extra["assetTransferMethod"])
		assert.NotContains(t, enhanced.Extra, "name")
		assert.NotContains(t, enhanced.Extra, "version")
	})
}

func TestPermit2OnlyAsset_WithoutTokenDomain(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	requirements := mockRequirements(map[string]interface{}{"assetTransferMethod": "permit2"})
	delete(requirements.Extra, "name")
	delete(requirements.Extra, "version")

	fields, err := scheme.EnrichSettlementPayload(x402.SettleContext{
		Ctx: context.Background(),
		Payload: types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: map[string]interface{}{
			"permit2Authorization": map[string]interface{}{
				"from":      testPayer,
				"spender":   authcapture.Permit2TokenCollectorAddress,
				"nonce":     "1",
				"deadline":  "1700003600",
				"permitted": map[string]interface{}{"token": testAsset, "amount": requirements.Amount},
			},
			"signature": "0xdeadbeef",
			"salt":      "0x2222222222222222222222222222222222222222222222222222222222222222",
			"saltNonce": "0x01",
		}},
		Requirements: requirements,
		Phase:        x402.SettlePhaseAfterHandler,
	})
	require.NoError(t, err)
	assert.Equal(t, "capture", fields["type"])
}
