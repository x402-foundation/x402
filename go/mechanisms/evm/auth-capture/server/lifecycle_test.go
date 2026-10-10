package server

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

var (
	deferredExtra      = map[string]interface{}{"paymentFlow": "escrow", "captureMode": "deferred"}
	authorizationExtra = map[string]interface{}{"paymentFlow": "authorization"}
	syncExtra          = map[string]interface{}{"paymentFlow": "escrow", "captureMode": "sync"}
	collectOnlyExtra   = map[string]interface{}{"paymentFlow": "escrow", "captureMode": "deferred", "receiverAuthorizer": authcapture.ZeroAddress}
)

func settleContext(phase x402.SettlePhase, extra map[string]interface{}) x402.SettleContext {
	return settleContextWithAmount(phase, extra, "")
}

// settleContextWithAmount sets the effective requirements amount, as a settlement override does.
func settleContextWithAmount(phase x402.SettlePhase, extra map[string]interface{}, amount string) x402.SettleContext {
	requirements := mockRequirements(extra)
	if amount != "" {
		requirements.Amount = amount
	}
	return x402.SettleContext{
		Ctx:          context.Background(),
		Payload:      eip3009CollectPayload(extra),
		Requirements: requirements,
		Phase:        phase,
	}
}

func settled(ctx x402.SettleContext, transaction string) x402.SettleResultContext {
	return x402.SettleResultContext{
		SettleContext: ctx,
		Result:        &x402.SettleResponse{Success: true, Transaction: transaction, Network: testNetwork, Payer: testPayer},
	}
}

func paymentHash(t *testing.T, scheme *AuthCaptureEvmScheme, ctx x402.SettleContext) string {
	t.Helper()
	request, err := scheme.newSettleRequest(ctx)
	require.NoError(t, err)
	return request.paymentInfoHash
}

func storedPayment(t *testing.T, scheme *AuthCaptureEvmScheme, hash string) *AuthorizedPayment {
	t.Helper()
	record, err := scheme.Storage().Get(context.Background(), hash)
	require.NoError(t, err)
	require.NotNil(t, record)
	return record
}

// authorize records the collect of the given route and returns its paymentInfoHash.
func authorize(t *testing.T, scheme *AuthCaptureEvmScheme, extra map[string]interface{}) string {
	t.Helper()
	ctx := settleContext(x402.SettlePhaseBeforeHandler, extra)
	require.NoError(t, scheme.AfterSettleHook()(settled(ctx, "0xcollect")))
	return paymentHash(t, scheme, ctx)
}

func TestStorage(t *testing.T) {
	storage := NewInMemoryAuthorizedPaymentStorage()
	ctx := context.Background()

	missing, err := storage.Get(ctx, "0xAB")
	require.NoError(t, err)
	assert.Nil(t, missing)

	require.NoError(t, storage.Update(ctx, "0xAB", func(current *AuthorizedPayment) *AuthorizedPayment {
		assert.Nil(t, current)
		return &AuthorizedPayment{PaymentInfoHash: "0xAB", CapturableAmount: "5"}
	}))
	stored, err := storage.Get(ctx, "0xab")
	require.NoError(t, err)
	assert.Equal(t, "5", stored.CapturableAmount, "keys are case-insensitive")

	stored.CapturableAmount = "99"
	again, _ := storage.Get(ctx, "0xAB")
	assert.Equal(t, "5", again.CapturableAmount, "a read is a copy")

	require.NoError(t, storage.Update(ctx, "0xAB", func(current *AuthorizedPayment) *AuthorizedPayment {
		current.CapturableAmount = "7"
		return current
	}))
	updated, _ := storage.Get(ctx, "0xAB")
	assert.Equal(t, "7", updated.CapturableAmount)

	all, err := storage.List(ctx)
	require.NoError(t, err)
	assert.Len(t, all, 1)

	require.NoError(t, storage.Update(ctx, "0xAB", func(*AuthorizedPayment) *AuthorizedPayment { return nil }))
	gone, _ := storage.Get(ctx, "0xAB")
	assert.Nil(t, gone)
}

func TestScheme_UsesConfiguredStorage(t *testing.T) {
	storage := NewInMemoryAuthorizedPaymentStorage()
	assert.Same(t, storage, NewAuthCaptureEvmScheme(&Config{Storage: storage}).Storage())
	assert.NotNil(t, NewAuthCaptureEvmScheme(nil).Storage())
}

func TestEnrichSettlementPayload_ChargeCompletesAuthorizationFlow(t *testing.T) {
	signer := &mockSigner{address: testSignerAddress}
	scheme := newTestScheme(signer)
	ctx := settleContext(x402.SettlePhaseAfterHandler, authorizationExtra)

	fields, err := scheme.EnrichSettlementPayload(ctx)
	require.NoError(t, err)

	merged := mergeEnrichment(t, eip3009CollectPayload(authorizationExtra), fields)
	assert.True(t, authcapture.IsEip3009Payload(merged))
	assert.NotContains(t, fields, "type")
	assert.Equal(t, "1000000", fields["amount"])
	assert.Equal(t, evm.NormalizeAddress(testFeeRecipient), fields["feeReceiver"])
	assert.Equal(t, "0xdeadbeef", fields["authorizerSignature"])
	assert.Contains(t, fields, "feeAmount")
	assert.NotContains(t, fields, "feeBps")

	deployment := authcapture.ResolveAuthCaptureDeployment("")
	assert.Equal(t, "Charge", signer.lastPrimaryType)
	assert.Equal(t, evm.NormalizeAddress(deployment.EIP3009Collector), signer.lastMessage["tokenCollector"])
	assert.Equal(t, crypto.Keccak256Hash([]byte{0xde, 0xad, 0xbe, 0xef}).Hex(), signer.lastMessage["collectorDataHash"])
	assert.Equal(t, paymentHash(t, scheme, ctx), signer.lastMessage["paymentInfoHash"])
}

func TestEnrichSettlementPayload_ChargeVariants(t *testing.T) {
	t.Run("v1.0 charges feeBps", func(t *testing.T) {
		extra := map[string]interface{}{"paymentFlow": "authorization", "authCaptureEscrow": authcapture.AuthCaptureEscrowV1_0Address, "minFeeBps": float64(25)}
		fields, err := newTestScheme(&mockSigner{address: testSignerAddress}).EnrichSettlementPayload(settleContext(x402.SettlePhaseAfterHandler, extra))
		require.NoError(t, err)
		assert.Equal(t, uint16(25), fields["feeBps"])
		assert.NotContains(t, fields, "feeAmount")
	})

	t.Run("a settlement override charges less than the signed amount", func(t *testing.T) {
		signer := &mockSigner{address: testSignerAddress}
		extra := map[string]interface{}{"paymentFlow": "authorization", "minFeeBps": float64(100)}
		fields, err := newTestScheme(signer).EnrichSettlementPayload(settleContextWithAmount(x402.SettlePhaseAfterHandler, extra, "400000"))
		require.NoError(t, err)
		assert.Equal(t, "400000", fields["amount"])
		assert.Equal(t, "4000", fields["feeAmount"])
		assert.Equal(t, "400000", signer.lastMessage["amount"].(*big.Int).String())
	})

	t.Run("an override above the signed amount fails", func(t *testing.T) {
		_, err := newTestScheme(&mockSigner{address: testSignerAddress}).EnrichSettlementPayload(
			settleContextWithAmount(x402.SettlePhaseAfterHandler, authorizationExtra, "1000001"))
		require.ErrorContains(t, err, ErrInvalidCaptureAmount)
	})

	t.Run("permit2 binds the permit2 collector", func(t *testing.T) {
		signer := &mockSigner{address: testSignerAddress}
		extra := map[string]interface{}{"paymentFlow": "authorization", "assetTransferMethod": "permit2"}
		ctx := settleContext(x402.SettlePhaseAfterHandler, extra)
		ctx.Payload = types.PaymentPayload{X402Version: 2, Accepted: mockRequirements(extra), Payload: map[string]interface{}{
			"permit2Authorization": map[string]interface{}{
				"from": testPayer, "spender": authcapture.Permit2TokenCollectorAddress, "nonce": "1", "deadline": "1700003600",
				"permitted": map[string]interface{}{"token": testAsset, "amount": "1000000"},
			},
			"signature": "0xdeadbeef", "salt": "0x22", "saltNonce": "0x01",
		}}
		_, err := newTestScheme(signer).EnrichSettlementPayload(ctx)
		require.NoError(t, err)
		deployment := authcapture.ResolveAuthCaptureDeployment("")
		assert.Equal(t, evm.NormalizeAddress(deployment.Permit2Collector), signer.lastMessage["tokenCollector"])
	})

	t.Run("a signer error surfaces", func(t *testing.T) {
		_, err := newTestScheme(&mockSigner{address: testSignerAddress, err: errors.New("boom")}).EnrichSettlementPayload(
			settleContext(x402.SettlePhaseAfterHandler, authorizationExtra))
		require.ErrorContains(t, err, ErrFailedToSignCharge)
	})

}

func TestEnrichSettlementPayload_DeferredAddsNothingAfterTheHandler(t *testing.T) {
	fields, err := newTestScheme(&mockSigner{address: testSignerAddress}).EnrichSettlementPayload(settleContext(x402.SettlePhaseAfterHandler, deferredExtra))
	require.NoError(t, err)
	assert.Nil(t, fields)
}

func TestEnrichSettlementPayload_CaptureNamesTheStoredBalances(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: testSignerAddress})
	hash := authorize(t, scheme, syncExtra)
	require.NoError(t, applyCapture(context.Background(), scheme.Storage(), hash, big.NewInt(300000), false))

	fields, err := scheme.EnrichSettlementPayload(settleContextWithAmount(x402.SettlePhaseAfterHandler, syncExtra, "200000"))
	require.NoError(t, err)
	assert.Equal(t, "700000", fields["expectedCapturableAmount"])
	assert.Equal(t, "300000", fields["expectedRefundableAmount"])
	assert.Contains(t, fields, "voidAuthorizerSignature")

	_, err = scheme.EnrichSettlementPayload(settleContextWithAmount(x402.SettlePhaseAfterHandler, syncExtra, "700001"))
	require.ErrorContains(t, err, ErrInvalidCaptureAmount, "the amount is bounded by what is still capturable")
}

func TestSettleOnCancel_SkipsHoldsItCannotVoid(t *testing.T) {
	cancel := func(scheme *AuthCaptureEvmScheme, extra map[string]interface{}) *types.PaymentRequirements {
		requirements, err := scheme.SettleOnCancel(x402.VerifiedPaymentCanceledContext{
			SettleContext: settleContext(x402.SettlePhaseCancel, extra),
			Reason:        x402.CancellationReasonHandlerFailed,
			SettledPhases: []x402.SettlePhase{x402.SettlePhaseBeforeHandler},
		})
		require.NoError(t, err)
		return requirements
	}
	signed := newTestScheme(&mockSigner{address: testSignerAddress})

	assert.NotNil(t, cancel(signed, syncExtra))
	assert.NotNil(t, cancel(signed, deferredExtra), "a deferred hold is voided when the handler fails")
	assert.Nil(t, cancel(signed, authorizationExtra), "the authorization flow holds nothing")
	assert.Nil(t, cancel(signed, map[string]interface{}{"operatorType": "custom", "captureMode": "deferred"}))
	assert.NotNil(t, cancel(NewAuthCaptureEvmScheme(&Config{}), deferredExtra), "without a local signer the facilitator signs the void")
	assert.Nil(t, cancel(signed, collectOnlyExtra), "a collect-only hold has no authorizer to sign a void")
}

func TestBeforeSettleHook(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: testSignerAddress})
	hook := scheme.BeforeSettleHook()

	t.Run("a deferred route skips the capture and echoes the collect receipt", func(t *testing.T) {
		authorize(t, scheme, deferredExtra)
		result, err := hook(settleContext(x402.SettlePhaseAfterHandler, deferredExtra))
		require.NoError(t, err)
		require.True(t, result.Skip)
		assert.Equal(t, "0xcollect", result.SkipResult.Transaction)
		assert.True(t, result.SkipResult.Success)
		assert.Equal(t, testPayer, result.SkipResult.Payer)
	})

	t.Run("a deferred route with no record aborts", func(t *testing.T) {
		empty := newTestScheme(&mockSigner{address: testSignerAddress})
		result, err := empty.BeforeSettleHook()(settleContext(x402.SettlePhaseAfterHandler, deferredExtra))
		require.NoError(t, err)
		require.True(t, result.Abort)
		assert.Equal(t, ErrPaymentNotFound, result.Reason)
	})

	t.Run("other routes and phases settle normally", func(t *testing.T) {
		for _, ctx := range []x402.SettleContext{
			settleContext(x402.SettlePhaseAfterHandler, syncExtra),
			settleContext(x402.SettlePhaseAfterHandler, authorizationExtra),
			settleContext(x402.SettlePhaseBeforeHandler, deferredExtra),
			settleContext(x402.SettlePhaseCancel, deferredExtra),
		} {
			result, err := hook(ctx)
			require.NoError(t, err)
			assert.Nil(t, result)
		}
	})
}

func TestAfterSettleHook_RecordsTheCollect(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: testSignerAddress})
	hash := authorize(t, scheme, deferredExtra)

	record := storedPayment(t, scheme, hash)
	assert.Equal(t, "1000000", record.CapturableAmount)
	assert.Equal(t, "0", record.RefundableAmount)
	assert.Equal(t, "0xcollect", record.CollectTransaction)
	assert.Equal(t, "0x01", record.SaltNonce)
	assert.Equal(t, "escrow", record.PaymentFlow)
	assert.Equal(t, "delegated", record.OperatorType)
	assert.Equal(t, testPayer, record.PaymentInfo.Payer)
	assert.Equal(t, "1000000", record.PaymentInfo.MaxAmount)
	assert.Equal(t, hash, record.PaymentInfoHash)

	require.NoError(t, applyVoid(context.Background(), scheme.Storage(), hash))
	require.NoError(t, scheme.AfterSettleHook()(settled(settleContext(x402.SettlePhaseBeforeHandler, deferredExtra), "0xretry")))
	retried := storedPayment(t, scheme, hash)
	assert.Equal(t, "0", retried.CapturableAmount, "the first write wins")
	assert.Equal(t, "0xcollect", retried.CollectTransaction)
}

func TestAfterSettleHook_KeepsBalancesInStep(t *testing.T) {
	hook := func(scheme *AuthCaptureEvmScheme, ctx x402.SettleContext) {
		require.NoError(t, scheme.AfterSettleHook()(settled(ctx, "0xsettle")))
	}

	t.Run("a full sync capture", func(t *testing.T) {
		scheme := newTestScheme(&mockSigner{address: testSignerAddress})
		hash := authorize(t, scheme, syncExtra)
		hook(scheme, settleContext(x402.SettlePhaseAfterHandler, syncExtra))
		record := storedPayment(t, scheme, hash)
		assert.Equal(t, "0", record.CapturableAmount)
		assert.Equal(t, "1000000", record.RefundableAmount)
	})

	t.Run("a partial sync capture voids the remainder", func(t *testing.T) {
		scheme := newTestScheme(&mockSigner{address: testSignerAddress})
		hash := authorize(t, scheme, syncExtra)
		hook(scheme, settleContextWithAmount(x402.SettlePhaseAfterHandler, syncExtra, "400000"))
		record := storedPayment(t, scheme, hash)
		assert.Equal(t, "0", record.CapturableAmount)
		assert.Equal(t, "400000", record.RefundableAmount)
	})

	t.Run("a deferred route keeps its hold", func(t *testing.T) {
		scheme := newTestScheme(&mockSigner{address: testSignerAddress})
		hash := authorize(t, scheme, deferredExtra)
		hook(scheme, settleContext(x402.SettlePhaseAfterHandler, deferredExtra))
		assert.Equal(t, "1000000", storedPayment(t, scheme, hash).CapturableAmount)
	})

	t.Run("a cancel void releases the hold", func(t *testing.T) {
		scheme := newTestScheme(&mockSigner{address: testSignerAddress})
		hash := authorize(t, scheme, syncExtra)
		hook(scheme, settleContext(x402.SettlePhaseCancel, syncExtra))
		assert.Equal(t, "0", storedPayment(t, scheme, hash).CapturableAmount)
	})

	t.Run("a charge is recorded as already captured", func(t *testing.T) {
		scheme := newTestScheme(&mockSigner{address: testSignerAddress})
		ctx := settleContextWithAmount(x402.SettlePhaseAfterHandler, authorizationExtra, "400000")
		hook(scheme, ctx)
		record := storedPayment(t, scheme, paymentHash(t, scheme, ctx))
		assert.Equal(t, "0", record.CapturableAmount)
		assert.Equal(t, "400000", record.RefundableAmount)
		assert.Equal(t, "authorization", record.PaymentFlow)
		assert.Equal(t, "1000000", record.PaymentInfo.MaxAmount)
	})

	t.Run("a failed settle changes nothing", func(t *testing.T) {
		scheme := newTestScheme(&mockSigner{address: testSignerAddress})
		ctx := settleContext(x402.SettlePhaseBeforeHandler, syncExtra)
		failed := x402.SettleResultContext{SettleContext: ctx, Result: &x402.SettleResponse{Success: false}}
		require.NoError(t, scheme.AfterSettleHook()(failed))
		record, err := scheme.Storage().Get(context.Background(), paymentHash(t, scheme, ctx))
		require.NoError(t, err)
		assert.Nil(t, record)
	})
}

type fakeFacilitator struct {
	payloads     [][]byte
	requirements [][]byte
	response     *x402.SettleResponse
	err          error
}

func (f *fakeFacilitator) Verify(context.Context, []byte, []byte) (*x402.VerifyResponse, error) {
	return nil, errors.New("unused")
}

func (f *fakeFacilitator) Settle(_ context.Context, payload, requirements []byte) (*x402.SettleResponse, error) {
	f.payloads = append(f.payloads, payload)
	f.requirements = append(f.requirements, requirements)
	if f.response == nil && f.err == nil {
		return &x402.SettleResponse{Success: true, Transaction: "0xlifecycle", Network: testNetwork}, nil
	}
	return f.response, f.err
}

func (f *fakeFacilitator) GetSupported(context.Context) (x402.SupportedResponse, error) {
	return x402.SupportedResponse{}, nil
}

// sent decodes the last lifecycle payload the facilitator received.
func (f *fakeFacilitator) sent(t *testing.T) types.PaymentPayload {
	t.Helper()
	require.NotEmpty(t, f.payloads)
	var payload types.PaymentPayload
	require.NoError(t, json.Unmarshal(f.payloads[len(f.payloads)-1], &payload))
	return payload
}

func newManager(t *testing.T, extra map[string]interface{}) (*LifecycleManager, *fakeFacilitator, *mockSigner, string) {
	t.Helper()
	signer := &mockSigner{address: testSignerAddress}
	scheme := newTestScheme(signer)
	facilitator := &fakeFacilitator{}
	return scheme.NewLifecycleManager(facilitator), facilitator, signer, authorize(t, scheme, extra)
}

func TestLifecycleManager_Capture(t *testing.T) {
	ctx := context.Background()

	t.Run("captures the full hold by default", func(t *testing.T) {
		manager, facilitator, signer, hash := newManager(t, deferredExtra)
		response, err := manager.Capture(ctx, hash, nil)
		require.NoError(t, err)
		assert.True(t, response.Success)

		payload := facilitator.sent(t)
		assert.True(t, authcapture.IsCapturePayload(payload.Payload))
		assert.Equal(t, "1000000", payload.Payload["amount"])
		assert.Equal(t, "1000000", payload.Payload["expectedCapturableAmount"])
		assert.Equal(t, "0", payload.Payload["expectedRefundableAmount"])
		assert.Equal(t, "0x01", payload.Payload["saltNonce"])
		assert.NotContains(t, payload.Payload, "voidAuthorizerSignature")
		assert.Equal(t, "1000000", payload.Accepted.Amount, "accepted carries the authorized amount")
		assert.Equal(t, "Capture", signer.lastPrimaryType)

		record, err := manager.Get(ctx, hash)
		require.NoError(t, err)
		assert.Equal(t, "0", record.CapturableAmount)
		assert.Equal(t, "1000000", record.RefundableAmount)
	})

	t.Run("a partial capture can void the remainder", func(t *testing.T) {
		manager, facilitator, _, hash := newManager(t, deferredExtra)
		_, err := manager.Capture(ctx, hash, &CaptureOptions{Amount: big.NewInt(250000), VoidRemainder: true})
		require.NoError(t, err)

		payload := facilitator.sent(t)
		assert.Equal(t, "250000", payload.Payload["amount"])
		assert.Contains(t, payload.Payload, "voidAuthorizerSignature")

		record, _ := manager.Get(ctx, hash)
		assert.Equal(t, "0", record.CapturableAmount)
		assert.Equal(t, "250000", record.RefundableAmount)
	})

	t.Run("a partial capture can leave the rest capturable", func(t *testing.T) {
		manager, facilitator, _, hash := newManager(t, deferredExtra)
		_, err := manager.Capture(ctx, hash, &CaptureOptions{Amount: big.NewInt(250000)})
		require.NoError(t, err)
		assert.NotContains(t, facilitator.sent(t).Payload, "voidAuthorizerSignature")

		_, err = manager.Capture(ctx, hash, &CaptureOptions{Amount: big.NewInt(750000)})
		require.NoError(t, err)
		payload := facilitator.sent(t)
		assert.Equal(t, "750000", payload.Payload["expectedCapturableAmount"])
		assert.Equal(t, "250000", payload.Payload["expectedRefundableAmount"])

		record, _ := manager.Get(ctx, hash)
		assert.Equal(t, "0", record.CapturableAmount)
		assert.Equal(t, "1000000", record.RefundableAmount)
	})

	t.Run("a fee override is signed", func(t *testing.T) {
		manager, facilitator, signer, hash := newManager(t, deferredExtra)
		fee := authcapture.CaptureFee{Amount: big.NewInt(1234)}
		_, err := manager.Capture(ctx, hash, &CaptureOptions{Fee: &fee, FeeReceiver: testFeeRecipient})
		require.NoError(t, err)
		assert.Equal(t, "1234", facilitator.sent(t).Payload["feeAmount"])
		assert.Equal(t, big.NewInt(1234), signer.lastMessage["feeAmount"])
	})

	t.Run("invalid amounts fail before anything is sent", func(t *testing.T) {
		manager, facilitator, _, hash := newManager(t, deferredExtra)
		for _, opts := range []*CaptureOptions{
			{Amount: big.NewInt(0)},
			{Amount: big.NewInt(1000001)},
			{VoidRemainder: true},
		} {
			_, err := manager.Capture(ctx, hash, opts)
			require.ErrorContains(t, err, ErrInvalidLifecycleAmount)
		}
		assert.Empty(t, facilitator.payloads)
	})

	t.Run("a facilitator rejection leaves the balances alone", func(t *testing.T) {
		manager, facilitator, _, hash := newManager(t, deferredExtra)
		facilitator.response = &x402.SettleResponse{Success: false, ErrorReason: "unexpected_payment_state"}
		response, err := manager.Capture(ctx, hash, nil)
		require.NoError(t, err)
		assert.False(t, response.Success)
		record, _ := manager.Get(ctx, hash)
		assert.Equal(t, "1000000", record.CapturableAmount)

		facilitator.response, facilitator.err = nil, errors.New("down")
		_, err = manager.Capture(ctx, hash, nil)
		require.ErrorContains(t, err, "down")
		record, _ = manager.Get(ctx, hash)
		assert.Equal(t, "1000000", record.CapturableAmount)
	})
}

func TestLifecycleManager_Void(t *testing.T) {
	manager, facilitator, signer, hash := newManager(t, deferredExtra)
	_, err := manager.Void(context.Background(), hash)
	require.NoError(t, err)

	payload := facilitator.sent(t)
	assert.True(t, authcapture.IsVoidPayload(payload.Payload))
	assert.Equal(t, "0x01", payload.Payload["saltNonce"])
	assert.Equal(t, "Void", signer.lastPrimaryType)

	record, _ := manager.Get(context.Background(), hash)
	assert.Equal(t, "0", record.CapturableAmount)
}

func TestLifecycleManager_Refund(t *testing.T) {
	ctx := context.Background()
	manager, facilitator, signer, hash := newManager(t, deferredExtra)

	_, err := manager.Refund(ctx, hash, big.NewInt(1))
	require.ErrorContains(t, err, ErrInvalidLifecycleAmount, "nothing is refundable before a capture")

	_, err = manager.Capture(ctx, hash, nil)
	require.NoError(t, err)
	_, err = manager.Refund(ctx, hash, big.NewInt(400000))
	require.NoError(t, err)

	payload := facilitator.sent(t)
	assert.True(t, authcapture.IsRefundPayload(payload.Payload))
	assert.Equal(t, "400000", payload.Payload["amount"])
	assert.Equal(t, "0", payload.Payload["expectedCapturableAmount"])
	assert.Equal(t, "1000000", payload.Payload["expectedRefundableAmount"])
	assert.Equal(t, "Refund", signer.lastPrimaryType)
	deployment := authcapture.ResolveAuthCaptureDeployment("")
	assert.Equal(t, evm.NormalizeAddress(deployment.OperatorRefundCollector), signer.lastMessage["tokenCollector"])

	record, _ := manager.Get(ctx, hash)
	assert.Equal(t, "600000", record.RefundableAmount)

	_, err = manager.Refund(ctx, hash, big.NewInt(600001))
	require.ErrorContains(t, err, ErrInvalidLifecycleAmount)
}

func TestLifecycleManager_RefundsAChargedPayment(t *testing.T) {
	ctx := context.Background()
	signer := &mockSigner{address: testSignerAddress}
	scheme := newTestScheme(signer)
	facilitator := &fakeFacilitator{}
	manager := scheme.NewLifecycleManager(facilitator)

	charge := settleContext(x402.SettlePhaseAfterHandler, authorizationExtra)
	require.NoError(t, scheme.AfterSettleHook()(settled(charge, "0xcharge")))
	hash := paymentHash(t, scheme, charge)

	_, err := manager.Capture(ctx, hash, nil)
	require.ErrorContains(t, err, ErrLifecycleUnavailable)
	_, err = manager.Void(ctx, hash)
	require.ErrorContains(t, err, ErrLifecycleUnavailable)

	_, err = manager.Refund(ctx, hash, big.NewInt(100))
	require.NoError(t, err)
	assert.Equal(t, "authorization", facilitator.sent(t).Accepted.Extra["paymentFlow"])
}

func TestLifecycleManager_Refusals(t *testing.T) {
	ctx := context.Background()

	t.Run("an unknown payment", func(t *testing.T) {
		manager, _, _, _ := newManager(t, deferredExtra)
		_, err := manager.Capture(ctx, "0xmissing", nil)
		require.ErrorContains(t, err, ErrPaymentNotFound)
	})

	t.Run("a custom operator's payment", func(t *testing.T) {
		manager, facilitator, _, hash := newManager(t, map[string]interface{}{"paymentFlow": "escrow", "captureMode": "deferred", "operatorType": "custom"})
		for _, call := range []func() error{
			func() error { _, err := manager.Capture(ctx, hash, nil); return err },
			func() error { _, err := manager.Void(ctx, hash); return err },
			func() error { _, err := manager.Refund(ctx, hash, big.NewInt(1)); return err },
		} {
			require.ErrorContains(t, call(), ErrLifecycleUnavailable)
		}
		assert.Empty(t, facilitator.payloads)
	})

	t.Run("a record without a saltNonce", func(t *testing.T) {
		manager, _, _, hash := newManager(t, deferredExtra)
		require.NoError(t, manager.scheme.Storage().Update(ctx, hash, func(current *AuthorizedPayment) *AuthorizedPayment {
			current.SaltNonce = ""
			return current
		}))
		_, err := manager.Void(ctx, hash)
		require.ErrorContains(t, err, ErrLifecycleUnavailable)
	})

	t.Run("a collect-only payment", func(t *testing.T) {
		scheme := NewAuthCaptureEvmScheme(&Config{CaptureAuthorizer: testCaptureAuthorizer})
		hash := authorize(t, scheme, collectOnlyExtra)
		manager := scheme.NewLifecycleManager(&fakeFacilitator{})
		_, err := manager.Capture(ctx, hash, nil)
		require.ErrorContains(t, err, "lifecycle is out of band")
		_, err = manager.Void(ctx, hash)
		require.ErrorContains(t, err, "lifecycle is out of band")
		_, err = manager.Refund(ctx, hash, big.NewInt(1))
		require.ErrorContains(t, err, "lifecycle is out of band")
		require.ErrorContains(t, err, ErrLifecycleUnavailable)
	})

	t.Run("listing", func(t *testing.T) {
		manager, _, _, hash := newManager(t, deferredExtra)
		all, err := manager.List(ctx)
		require.NoError(t, err)
		require.Len(t, all, 1)
		assert.Equal(t, hash, all[0].PaymentInfoHash)
	})
}

func TestAuthorizedPayment_RequirementsRoundTrip(t *testing.T) {
	scheme := newTestScheme(&mockSigner{address: testSignerAddress})
	hash := authorize(t, scheme, deferredExtra)
	record := storedPayment(t, scheme, hash)

	requirements := record.requirements()
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)
	assert.Equal(t, record.PaymentInfo.Operator, extra.CaptureAuthorizer)
	assert.Equal(t, record.PaymentInfo.AuthorizationExpiry, extra.CaptureDeadline)
	assert.Equal(t, record.PaymentInfo.RefundExpiry, extra.RefundDeadline)
	assert.Equal(t, record.PaymentInfo.MaxAmount, requirements.Amount)

	rebuilt := authcapture.ReconstructPaymentInfo(record.PaymentInfo.Payer, record.PaymentInfo.PreApprovalExpiry, record.PaymentInfo.Salt, requirements, extra)
	rebuiltHash, err := authcapture.ComputePaymentInfoHash(mustChainID(t, record.Network), rebuilt, rebuilt.Payer, deployment.Escrow)
	require.NoError(t, err)
	assert.Equal(t, record.PaymentInfoHash, rebuiltHash, "the facilitator derives the same hash from the rebuilt requirements")
}

func mustChainID(t *testing.T, network string) *big.Int {
	t.Helper()
	chainID, err := evm.GetEvmChainId(network)
	require.NoError(t, err)
	return chainID
}

var (
	delegatedSyncExtra     = map[string]interface{}{"paymentFlow": "escrow", "captureMode": "sync", "receiverAuthorizer": testFacilitatorAddr}
	delegatedDeferredExtra = map[string]interface{}{"paymentFlow": "escrow", "captureMode": "deferred", "receiverAuthorizer": testFacilitatorAddr}
	delegatedAuthorization = map[string]interface{}{"paymentFlow": "authorization", "receiverAuthorizer": testFacilitatorAddr}
)

// delegatedScheme has no receiver-authorizer signer: the facilitator signs.
func delegatedScheme() *AuthCaptureEvmScheme {
	return NewAuthCaptureEvmScheme(&Config{CaptureAuthorizer: testCaptureAuthorizer})
}

func TestEnrichSettlementPayload_CollectOnlyRouteIsNotEnriched(t *testing.T) {
	scheme := delegatedScheme()
	for _, phase := range []x402.SettlePhase{x402.SettlePhaseAfterHandler, x402.SettlePhaseCancel} {
		fields, err := scheme.EnrichSettlementPayload(settleContext(phase, collectOnlyExtra))
		require.NoError(t, err)
		assert.Nil(t, fields)
	}
}

func TestEnrichSettlementPayload_UnsignedCaptureWhenTheAuthorizerIsDelegated(t *testing.T) {
	t.Run("a partial capture asks the facilitator to void the remainder", func(t *testing.T) {
		fields, err := delegatedScheme().EnrichSettlementPayload(settleContextWithAmount(x402.SettlePhaseAfterHandler, delegatedSyncExtra, "400000"))
		require.NoError(t, err)
		assert.Equal(t, "capture", fields["type"])
		assert.Equal(t, "400000", fields["amount"])
		assert.Equal(t, "1000000", fields["expectedCapturableAmount"])
		assert.Equal(t, "0", fields["expectedRefundableAmount"])
		assert.Equal(t, true, fields["voidRemainder"])
		assert.NotContains(t, fields, "authorizerSignature")
		assert.NotContains(t, fields, "voidAuthorizerSignature")
	})

	t.Run("a full capture omits voidRemainder", func(t *testing.T) {
		fields, err := delegatedScheme().EnrichSettlementPayload(settleContext(x402.SettlePhaseAfterHandler, delegatedSyncExtra))
		require.NoError(t, err)
		assert.Equal(t, "capture", fields["type"])
		assert.Equal(t, "1000000", fields["amount"])
		assert.NotContains(t, fields, "voidRemainder")
	})
}

func TestEnrichSettlementPayload_UnsignedVoidOnCancelWhenDelegated(t *testing.T) {
	fields, err := delegatedScheme().EnrichSettlementPayload(settleContext(x402.SettlePhaseCancel, delegatedSyncExtra))
	require.NoError(t, err)
	assert.Equal(t, "void", fields["type"])
	assert.NotContains(t, fields, "authorizerSignature")
}

func TestEnrichSettlementPayload_UnsignedChargeCompletionWhenDelegated(t *testing.T) {
	fields, err := delegatedScheme().EnrichSettlementPayload(settleContext(x402.SettlePhaseAfterHandler, delegatedAuthorization))
	require.NoError(t, err)
	assert.Equal(t, "1000000", fields["amount"])
	assert.Contains(t, fields, "feeReceiver")
	assert.NotContains(t, fields, "authorizerSignature")
}

func TestSettleOnCancel_ReturnsRequirementsWithoutASignerWhenDelegated(t *testing.T) {
	requirements, err := delegatedScheme().SettleOnCancel(x402.VerifiedPaymentCanceledContext{
		SettleContext: settleContext(x402.SettlePhaseCancel, delegatedDeferredExtra),
		Reason:        x402.CancellationReasonHandlerFailed,
		SettledPhases: []x402.SettlePhase{x402.SettlePhaseBeforeHandler},
	})
	require.NoError(t, err)
	require.NotNil(t, requirements)
	assert.Equal(t, testFacilitatorAddr, requirements.Extra["receiverAuthorizer"])
}

func TestLifecycleManager_SendsUnsignedPayloadsWhenTheAuthorizerIsDelegated(t *testing.T) {
	ctx := context.Background()
	scheme := delegatedScheme()
	facilitator := &fakeFacilitator{}
	manager := scheme.NewLifecycleManager(facilitator)
	hash := authorize(t, scheme, delegatedDeferredExtra)

	_, err := manager.Capture(ctx, hash, &CaptureOptions{Amount: big.NewInt(500000), VoidRemainder: true})
	require.NoError(t, err)
	_, err = manager.Void(ctx, hash)
	require.NoError(t, err)
	_, err = manager.Refund(ctx, hash, big.NewInt(1))
	require.NoError(t, err)

	require.Len(t, facilitator.payloads, 3)
	var capture, voided, refund types.PaymentPayload
	require.NoError(t, json.Unmarshal(facilitator.payloads[0], &capture))
	require.NoError(t, json.Unmarshal(facilitator.payloads[1], &voided))
	require.NoError(t, json.Unmarshal(facilitator.payloads[2], &refund))

	assert.Equal(t, "capture", capture.Payload["type"])
	assert.Equal(t, "500000", capture.Payload["amount"])
	assert.Equal(t, true, capture.Payload["voidRemainder"])
	assert.NotContains(t, capture.Payload, "authorizerSignature")
	assert.NotContains(t, capture.Payload, "voidAuthorizerSignature")
	assert.Equal(t, "void", voided.Payload["type"])
	assert.NotContains(t, voided.Payload, "authorizerSignature")
	assert.Equal(t, "refund", refund.Payload["type"])
	assert.NotContains(t, refund.Payload, "authorizerSignature")
}
