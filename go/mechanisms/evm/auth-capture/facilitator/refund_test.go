package facilitator

import (
	"context"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
)

type refundOpts struct {
	amount             string
	expectedCapturable string
	expectedRefundable string
}

func (fx lifecycleFixture) buildRefund(t *testing.T, opts refundOpts) map[string]interface{} {
	t.Helper()
	if opts.amount == "" {
		opts.amount = "400000"
	}
	if opts.expectedCapturable == "" {
		opts.expectedCapturable = "0"
	}
	if opts.expectedRefundable == "" {
		opts.expectedRefundable = fx.paymentInfo.MaxAmount
	}
	amount, _ := new(big.Int).SetString(opts.amount, 10)
	capturable, _ := new(big.Int).SetString(opts.expectedCapturable, 10)
	refundable, _ := new(big.Int).SetString(opts.expectedRefundable, 10)

	signature, err := authcapture.SignRefund(context.Background(), fx.receiver, fx.extra.CaptureAuthorizer, fx.chainID,
		authcapture.RefundParams{
			PaymentInfoHash:    fx.paymentHash,
			Amount:             amount,
			TokenCollector:     fx.deployment.OperatorRefundCollector,
			ExpectedCapturable: capturable,
			ExpectedRefundable: refundable,
		})
	require.NoError(t, err)

	paymentInfo, err := fx.paymentInfo.ToWireMap()
	require.NoError(t, err)
	return map[string]interface{}{
		"type":                     "refund",
		"paymentInfo":              paymentInfo,
		"saltNonce":                fx.saltNonce,
		"amount":                   opts.amount,
		"expectedCapturableAmount": opts.expectedCapturable,
		"expectedRefundableAmount": opts.expectedRefundable,
		"authorizerSignature":      evm.BytesToHex(signature),
	}
}

func (fx lifecycleFixture) refundSigner() *mockFacSigner {
	signer := fx.signer()
	signer.paymentStateCapturable = big.NewInt(0)
	signer.paymentStateRefundable, _ = new(big.Int).SetString(fx.paymentInfo.MaxAmount, 10)
	return signer
}

func TestVerifyRefund_HappyPath(t *testing.T) {
	for _, escrow := range []string{"", authcapture.AuthCaptureEscrowV1_0Address} {
		fx := newLifecycleFixture(t, map[string]interface{}{"authCaptureEscrow": escrow})
		signer := fx.refundSigner()

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{RefundFunding: true}).Verify(context.Background(), fx.payload(fx.buildRefund(t, refundOpts{})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
		assert.Equal(t, []string{"refund"}, signer.readFunctions)
	}
}

func TestVerifyRefund_RequiresFundingOptIn(t *testing.T) {
	fx := newLifecycleFixture(t, nil)

	_, err := newScheme(fx.refundSigner(), AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload(fx.buildRefund(t, refundOpts{})), fx.requirements, nil)
	assertVerifyReason(t, err, ErrRefundFundingUnavailable)
}

func TestVerifyRefund_Rejections(t *testing.T) {
	tests := []struct {
		name   string
		extra  map[string]interface{}
		opts   refundOpts
		mutate func(fx *lifecycleFixture, wire map[string]interface{}, signer *mockFacSigner)
		reason string
	}{
		{name: "amount above the refundable balance", opts: refundOpts{amount: "1000001"}, reason: ErrRefundExceedsCapture},
		{name: "zero amount", opts: refundOpts{amount: "0"}, reason: ErrRefundExceedsCapture},
		{name: "stale expected balances", opts: refundOpts{expectedRefundable: "1"}, reason: ErrUnexpectedPaymentState},
		{
			name: "refund deadline passed",
			extra: map[string]interface{}{
				"captureDeadline": float64(time.Now().Unix() - 20),
				"refundDeadline":  float64(time.Now().Unix() - 10),
			},
			reason: ErrRefundDeadlineExpired,
		},
		{
			name: "signature from another key",
			mutate: func(fx *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["authorizerSignature"] = fx.voidSignature(t)
			},
			reason: ErrAuthorizerSignature,
		},
		{
			name: "signature over a different amount",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["amount"] = "400001"
			},
			reason: ErrAuthorizerSignature,
		},
		{
			name: "malformed amount",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["amount"] = "-1"
			},
			reason: ErrPayloadFormat,
		},
		{
			name: "payment never collected",
			mutate: func(_ *lifecycleFixture, _ map[string]interface{}, signer *mockFacSigner) {
				signer.paymentStateHasCollected = false
			},
			reason: ErrUnexpectedPaymentState,
		},
		{
			name: "salt does not match the binding",
			mutate: func(_ *lifecycleFixture, wire map[string]interface{}, _ *mockFacSigner) {
				wire["saltNonce"] = "0x02"
			},
			reason: ErrSaltBindingMismatch,
		},
		{
			name:   "custom operator does not relay lifecycle",
			extra:  map[string]interface{}{"operatorType": "custom"},
			reason: ErrLifecycleNotRelayed,
		},
		{
			name: "simulation revert",
			mutate: func(_ *lifecycleFixture, _ map[string]interface{}, signer *mockFacSigner) {
				signer.simulateErr["refund"] = escrowRevert(t, "RefundExceedsCapture", big.NewInt(2), big.NewInt(1))
			},
			reason: ErrRefundExceedsCapture,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fx := newLifecycleFixture(t, test.extra)
			signer := fx.refundSigner()
			wire := fx.buildRefund(t, test.opts)
			if test.mutate != nil {
				test.mutate(&fx, wire, signer)
			}

			_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{RefundFunding: true, Operators: allowAllCustomOperators}).Verify(context.Background(), fx.payload(wire), fx.requirements, nil)
			assertVerifyReason(t, err, test.reason)
		})
	}
}

func TestSettleRefund(t *testing.T) {
	t.Run("submits the refund and reports the amount", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.refundSigner()

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{RefundFunding: true}).Settle(context.Background(), fx.payload(fx.buildRefund(t, refundOpts{})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, []string{"refund"}, signer.writtenFunctions)
		assert.Equal(t, strings.ToLower(fx.paymentInfo.Payer), strings.ToLower(resp.Payer))
	})

	t.Run("re-simulates when configured", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.refundSigner()
		signer.simulateErr["refund"] = escrowRevert(t, "RefundExceedsCapture", big.NewInt(2), big.NewInt(1))

		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{RefundFunding: true, SimulateInSettle: true}).Settle(context.Background(), fx.payload(fx.buildRefund(t, refundOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrRefundExceedsCapture)
		assert.Empty(t, signer.writtenFunctions)
	})

	t.Run("verification failure", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.refundSigner()
		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{RefundFunding: true}).Settle(context.Background(), fx.payload(fx.buildRefund(t, refundOpts{amount: "1000001"})), fx.requirements, nil)
		assertSettleReason(t, err, ErrRefundExceedsCapture)
	})

	t.Run("a pending settlement is resumed instead of resubmitted", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.refundSigner()
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{RefundFunding: true})
		wire := fx.buildRefund(t, refundOpts{})
		require.NoError(t, scheme.pendingStore.Set(context.Background(), scheme.pendingKey(fx.payload(wire), fx.requirements), signer.writeTx))

		resp, err := scheme.Settle(context.Background(), fx.payload(wire), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Empty(t, signer.writtenFunctions)
	})
}
