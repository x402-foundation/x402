package facilitator

import (
	"context"
	"math/big"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

type chargeFixture struct {
	requirements types.PaymentRequirements
	payload      types.PaymentPayload
	receiver     evm.ClientEvmSigner
	extra        authcapture.AuthCaptureExtra
	deployment   authcapture.AuthCaptureDeployment
}

func newChargeFixture(t *testing.T, extraOverrides map[string]interface{}, collect collectOpts) chargeFixture {
	t.Helper()
	receiver := newKeySigner(t)
	overrides := map[string]interface{}{"paymentFlow": "authorization", "receiverAuthorizer": receiver.Address()}
	for k, v := range extraOverrides {
		overrides[k] = v
	}
	requirements := facBaseRequirements(facCaptureAuthorizer, overrides)
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)
	return chargeFixture{
		requirements: requirements,
		payload:      buildCollectPayload(t, requirements, newKeySigner(t), collect),
		receiver:     receiver,
		extra:        extra,
		deployment:   deployment,
	}
}

type chargeOpts struct {
	amount      string
	fee         *authcapture.CaptureFee
	feeReceiver string
}

// complete adds the server's charge fields, signed by the receiver authorizer over the same
// values the escrow will charge.
func (fx chargeFixture) complete(t *testing.T, opts chargeOpts) types.PaymentPayload {
	t.Helper()
	if opts.amount == "" {
		opts.amount = fx.requirements.Amount
	}
	if opts.feeReceiver == "" {
		opts.feeReceiver = fx.extra.FeeRecipient
	}
	amount, _ := new(big.Int).SetString(opts.amount, 10)
	fee := authcapture.DefaultCaptureFee(&fx.deployment, amount, fx.extra.MinFeeBps)
	if opts.fee != nil {
		fee = *opts.fee
	}

	wire := map[string]interface{}{}
	for k, v := range fx.payload.Payload {
		wire[k] = v
	}
	validBefore, err := strconv.ParseUint(wire["authorization"].(map[string]interface{})["validBefore"].(string), 10, 64)
	require.NoError(t, err)
	payer := wire["authorization"].(map[string]interface{})["from"].(string)

	chainID, err := evm.GetEvmChainId(fx.requirements.Network)
	require.NoError(t, err)
	paymentInfo := authcapture.ReconstructPaymentInfo(payer, validBefore, wire["salt"].(string), fx.requirements, fx.extra)
	hash, err := authcapture.ComputePaymentInfoHash(chainID, paymentInfo, payer, fx.deployment.Escrow)
	require.NoError(t, err)
	collectorData, err := evm.HexToBytes(wire["signature"].(string))
	require.NoError(t, err)

	signature, err := authcapture.SignCharge(context.Background(), fx.receiver, &fx.deployment, fx.extra.CaptureAuthorizer, chainID,
		authcapture.ChargeParams{
			PaymentInfoHash: hash,
			Amount:          amount,
			TokenCollector:  fx.deployment.EIP3009Collector,
			CollectorData:   collectorData,
			Fee:             fee,
			FeeReceiver:     opts.feeReceiver,
		})
	require.NoError(t, err)

	wire["amount"] = opts.amount
	wire["feeReceiver"] = opts.feeReceiver
	wire["authorizerSignature"] = evm.BytesToHex(signature)
	fee.AddToWire(wire)
	payload := fx.payload
	payload.Payload = wire
	return payload
}

func TestVerifyCharge_HappyPath(t *testing.T) {
	bps := uint16(50)
	tests := []struct {
		name  string
		extra map[string]interface{}
		opts  chargeOpts
	}{
		{name: "v1.1 full amount"},
		{name: "v1.1 partial amount", opts: chargeOpts{amount: "600000"}},
		{name: "v1.1 fee at the upper bound", opts: chargeOpts{fee: &authcapture.CaptureFee{Amount: big.NewInt(10000)}}},
		{name: "v1.0 fee in bps", extra: map[string]interface{}{"authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address}, opts: chargeOpts{fee: &authcapture.CaptureFee{Bps: &bps}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fx := newChargeFixture(t, test.extra, collectOpts{})
			signer := newMockFacSigner(facCaptureAuthorizer)

			resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.complete(t, test.opts), fx.requirements, nil)
			require.NoError(t, err)
			assert.True(t, resp.IsValid)
			assert.Contains(t, signer.readFunctions, "charge")
		})
	}
}

func TestVerifyCharge_UncompletedPayloadSimulatesAFullCharge(t *testing.T) {
	fx := newChargeFixture(t, nil, collectOpts{})
	signer := newMockFacSigner(facCaptureAuthorizer)

	resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), fx.payload, fx.requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, []string{"charge"}, signer.readFunctions)
}

func TestVerifyCharge_Rejections(t *testing.T) {
	tests := []struct {
		name   string
		opts   chargeOpts
		signer evm.ClientEvmSigner
		mutate func(wire map[string]interface{})
		reason string
	}{
		{name: "amount above the signed amount", opts: chargeOpts{amount: "1000001"}, reason: ErrAmountMismatch},
		{name: "zero amount", opts: chargeOpts{amount: "0"}, reason: ErrAmountMismatch},
		{name: "fee above the bound", opts: chargeOpts{fee: &authcapture.CaptureFee{Amount: big.NewInt(10001)}}, reason: ErrFeeBpsOutOfRange},
		{name: "fee receiver differs from extra", opts: chargeOpts{feeReceiver: "0x" + "8888888888888888888888888888888888888888"}, reason: ErrFeeReceiver},
		{name: "signature from another key", signer: newKeySigner(t), reason: ErrAuthorizerSignature},
		{
			name:   "charge amount changed after signing",
			mutate: func(wire map[string]interface{}) { wire["amount"] = "999999" },
			reason: ErrAuthorizerSignature,
		},
		{
			name: "fee field of the other deployment",
			mutate: func(wire map[string]interface{}) {
				delete(wire, "feeAmount")
				wire["feeBps"] = uint16(1)
			},
			reason: ErrPayloadFormat,
		},
		{
			name:   "partial charge fields",
			mutate: func(wire map[string]interface{}) { delete(wire, "feeReceiver") },
			reason: ErrPayloadFormat,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fx := newChargeFixture(t, nil, collectOpts{})
			if test.signer != nil {
				fx.receiver = test.signer
			}
			payload := fx.complete(t, test.opts)
			if test.mutate != nil {
				test.mutate(payload.Payload)
			}

			_, err := newScheme(newMockFacSigner(facCaptureAuthorizer), AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), payload, fx.requirements, nil)
			assertVerifyReason(t, err, test.reason)
		})
	}
}

func TestVerifyCharge_CompletionOnEscrowPayload(t *testing.T) {
	fx := newChargeFixture(t, nil, collectOpts{})
	payload := fx.complete(t, chargeOpts{})
	escrow := fx.requirements
	escrow.Extra = map[string]interface{}{}
	for k, v := range fx.requirements.Extra {
		escrow.Extra[k] = v
	}
	escrow.Extra["paymentFlow"] = "escrow"
	payload.Accepted = escrow

	_, err := newScheme(newMockFacSigner(facCaptureAuthorizer), AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), payload, escrow, nil)
	assertVerifyReason(t, err, ErrPayloadFormat)
}

func TestSettleCharge(t *testing.T) {
	t.Run("a completed charge settles in one transaction", func(t *testing.T) {
		fx := newChargeFixture(t, nil, collectOpts{})
		signer := newMockFacSigner(facCaptureAuthorizer)

		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.complete(t, chargeOpts{}), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, []string{"charge"}, signer.writtenFunctions)
		assert.Equal(t, []string{"charge"}, signer.readFunctions, "a charge is always re-simulated before it moves funds")
	})

	t.Run("a partial charge settles against the overridden amount", func(t *testing.T) {
		fx := newChargeFixture(t, nil, collectOpts{})
		settleRequirements := fx.requirements
		settleRequirements.Amount = "600000"

		signer := newMockFacSigner(facCaptureAuthorizer)
		resp, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.complete(t, chargeOpts{amount: "600000"}), settleRequirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
	})

	t.Run("an uncompleted payload is rejected", func(t *testing.T) {
		fx := newChargeFixture(t, nil, collectOpts{})
		signer := newMockFacSigner(facCaptureAuthorizer)

		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.payload, fx.requirements, nil)
		assertSettleReason(t, err, ErrPayloadFormat)
		assert.Empty(t, signer.writtenFunctions)
	})

	t.Run("a revert at the final simulation is typed", func(t *testing.T) {
		fx := newChargeFixture(t, nil, collectOpts{})
		signer := newMockFacSigner(facCaptureAuthorizer)
		signer.simulateErr["charge"] = escrowRevert(t, "FeeAmountOutOfRange", big.NewInt(1), big.NewInt(0), big.NewInt(0))

		_, err := newScheme(signer, AuthCaptureEvmSchemeConfig{}).Settle(context.Background(), fx.complete(t, chargeOpts{}), fx.requirements, nil)
		assertSettleReason(t, err, ErrFeeBpsOutOfRange)
		assert.Empty(t, signer.writtenFunctions)
	})
}
