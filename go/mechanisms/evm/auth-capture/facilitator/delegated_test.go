package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	"github.com/x402-foundation/x402/go/v2/types"
)

const delegatedCaller = "caller-1"

// recordingAuthorizer is the delegated authorizer signer; it records what it was asked to sign.
type recordingAuthorizer struct {
	evm.ClientEvmSigner
	primaryTypes []string
}

func (r *recordingAuthorizer) SignTypedData(ctx context.Context, domain evm.TypedDataDomain, fields map[string][]evm.TypedDataField, primaryType string, message map[string]interface{}) ([]byte, error) {
	r.primaryTypes = append(r.primaryTypes, primaryType)
	return r.ClientEvmSigner.SignTypedData(ctx, domain, fields, primaryType, message)
}

// failingGetStorage fails every Get.
type failingGetStorage struct {
	AuthCaptureDelegatedAuthStorage
}

func (failingGetStorage) Get(context.Context, x402.Network, string) (*AuthCaptureDelegatedAuthRecord, error) {
	return nil, errors.New("db down")
}

// failingDeleteStorage fails every Delete.
type failingDeleteStorage struct {
	AuthCaptureDelegatedAuthStorage
}

func (failingDeleteStorage) Delete(context.Context, x402.Network, string) error {
	return errors.New("db down")
}

// delegatedHarness is a facilitator whose receiverAuthorizer key it holds.
type delegatedHarness struct {
	scheme     *AuthCaptureEvmScheme
	signer     *mockFacSigner
	storage    AuthCaptureDelegatedAuthStorage
	authorizer *recordingAuthorizer
	reported   *recordedStorageErrors
	settles    []DelegatedSettleContext
}

type delegatedOpts struct {
	// identity is what the resolver returns; nil selects delegatedCaller and "" is unauthenticated.
	identity        *string
	resolverErr     error
	storage         AuthCaptureDelegatedAuthStorage
	noRefundFunding bool
}

func newDelegatedHarness(signer *mockFacSigner, receiver evm.ClientEvmSigner, opts delegatedOpts) *delegatedHarness {
	h := &delegatedHarness{
		signer:     signer,
		storage:    opts.storage,
		authorizer: &recordingAuthorizer{ClientEvmSigner: receiver},
		reported:   &recordedStorageErrors{},
	}
	if h.storage == nil {
		h.storage = NewInMemoryAuthCaptureDelegatedAuthStorage()
	}
	identity := delegatedCaller
	if opts.identity != nil {
		identity = *opts.identity
	}
	h.scheme = newScheme(signer, AuthCaptureEvmSchemeConfig{
		AuthorizerSigner: h.authorizer,
		ResolveCallerIdentity: func(_ context.Context, settle DelegatedSettleContext) (string, error) {
			h.settles = append(h.settles, settle)
			return identity, opts.resolverErr
		},
		DelegatedAuthStorage: h.storage,
		OnStorageError:       h.reported.report,
		RefundFunding:        !opts.noRefundFunding,
	})
	return h
}

func (h *delegatedHarness) binding(t *testing.T, hash string) *AuthCaptureDelegatedAuthRecord {
	t.Helper()
	record, err := h.storage.Get(context.Background(), facNetwork, hash)
	require.NoError(t, err)
	return record
}

func (h *delegatedHarness) bindRow(t *testing.T, hash, identity string, expiresAt uint64) {
	t.Helper()
	_, err := h.storage.Bind(context.Background(), AuthCaptureDelegatedAuthRecord{
		Network: facNetwork, PaymentInfoHash: hash, CallerIdentity: identity, ExpiresAt: expiresAt,
	})
	require.NoError(t, err)
}

func strPtr(value string) *string { return &value }

func unsigned(payload types.PaymentPayload) types.PaymentPayload {
	wire := map[string]interface{}{}
	for key, value := range payload.Payload {
		wire[key] = value
	}
	delete(wire, "authorizerSignature")
	payload.Payload = wire
	return payload
}

// collectPaymentInfoHash is the paymentInfoHash of a collect payload.
func collectPaymentInfoHash(t *testing.T, requirements types.PaymentRequirements, payload types.PaymentPayload) string {
	t.Helper()
	extra, deployment, err := authcapture.ParseAuthCaptureExtra(requirements)
	require.NoError(t, err)
	authorization := payload.Payload["authorization"].(map[string]interface{})
	validBefore, err := strconv.ParseUint(authorization["validBefore"].(string), 10, 64)
	require.NoError(t, err)
	payer := authorization["from"].(string)
	chainID, err := evm.GetEvmChainId(requirements.Network)
	require.NoError(t, err)
	paymentInfo := authcapture.ReconstructPaymentInfo(payer, validBefore, payload.Payload["salt"].(string), requirements, extra)
	hash, err := authcapture.ComputePaymentInfoHash(chainID, paymentInfo, payer, deployment.Escrow)
	require.NoError(t, err)
	return hash
}

func TestDelegatedConfiguration(t *testing.T) {
	signer := newMockFacSigner(facCaptureAuthorizer)
	authorizer := stubAuthorizerSigner{address: delegatedTestAuthorizer}
	resolve := func(context.Context, DelegatedSettleContext) (string, error) { return delegatedCaller, nil }
	onError := func(error, x402.Network, string) {}
	storage := NewInMemoryAuthCaptureDelegatedAuthStorage()
	build := func(config AuthCaptureEvmSchemeConfig) func() { return func() { newScheme(signer, config) } }

	t.Run("requires the full delegation quartet together", func(t *testing.T) {
		assert.PanicsWithValue(t, "AuthorizerSigner requires ResolveCallerIdentity",
			build(AuthCaptureEvmSchemeConfig{AuthorizerSigner: authorizer}))
		assert.PanicsWithValue(t, "facilitator-delegated receiver authorization requires AuthorizerSigner",
			build(AuthCaptureEvmSchemeConfig{ResolveCallerIdentity: resolve}))
		assert.PanicsWithValue(t, "AuthorizerSigner requires DelegatedAuthStorage",
			build(AuthCaptureEvmSchemeConfig{AuthorizerSigner: authorizer, ResolveCallerIdentity: resolve}))
		assert.PanicsWithValue(t, "AuthorizerSigner requires OnStorageError",
			build(AuthCaptureEvmSchemeConfig{AuthorizerSigner: authorizer, ResolveCallerIdentity: resolve, DelegatedAuthStorage: storage}))
		assert.PanicsWithValue(t, "facilitator-delegated receiver authorization requires AuthorizerSigner",
			build(AuthCaptureEvmSchemeConfig{DelegatedAuthStorage: storage}))
		assert.NotPanics(t,
			build(AuthCaptureEvmSchemeConfig{AuthorizerSigner: authorizer, ResolveCallerIdentity: resolve, DelegatedAuthStorage: storage, OnStorageError: onError}))
	})

	t.Run("advertises the authorizer address as receiverAuthorizer", func(t *testing.T) {
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{
			AuthorizerSigner: authorizer, ResolveCallerIdentity: resolve, DelegatedAuthStorage: storage, OnStorageError: onError,
		})
		extra := scheme.GetExtra(facNetwork)
		assert.Equal(t, delegatedTestAuthorizer, extra["receiverAuthorizer"])
	})

	t.Run("does not advertise receiverAuthorizer when delegation is not configured", func(t *testing.T) {
		extra := newScheme(signer, AuthCaptureEvmSchemeConfig{}).GetExtra(facNetwork)
		assert.NotContains(t, extra, "receiverAuthorizer")
	})
}

func TestDelegatedCharge(t *testing.T) {
	newCharge := func(t *testing.T, opts delegatedOpts) (chargeFixture, *delegatedHarness, string) {
		t.Helper()
		fx := newChargeFixture(t, nil, collectOpts{})
		h := newDelegatedHarness(newMockFacSigner(facCaptureAuthorizer), fx.receiver, opts)
		return fx, h, collectPaymentInfoHash(t, fx.requirements, fx.payload)
	}

	t.Run("verifies an unsigned charge without resolving identity or binding", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{})
		resp, err := h.scheme.Verify(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
		assert.Empty(t, h.settles)
		assert.Nil(t, h.binding(t, hash))
	})

	t.Run("rejects an unsigned charge when no delegated authorizer is configured", func(t *testing.T) {
		fx := newChargeFixture(t, nil, collectOpts{})
		scheme := newScheme(newMockFacSigner(facCaptureAuthorizer), AuthCaptureEvmSchemeConfig{})
		_, err := scheme.Verify(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		assertVerifyReason(t, err, ErrAuthorizerSignature)
	})

	t.Run("signs the Charge digest, binds the caller until refundDeadline, then broadcasts", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{})
		resp, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, []string{"Charge"}, h.authorizer.primaryTypes)

		require.Len(t, h.settles, 1)
		assert.Equal(t, DelegatedStepCharge, h.settles[0].Step)
		assert.Equal(t, hash, h.settles[0].PaymentInfoHash)

		binding := h.binding(t, hash)
		require.NotNil(t, binding)
		assert.Equal(t, delegatedCaller, binding.CallerIdentity)
		assert.Equal(t, fx.extra.RefundDeadline, binding.ExpiresAt)
		assert.Equal(t, []string{"charge"}, h.signer.writtenFunctions)
	})

	t.Run("does not bind a charge that cannot be refunded through this facilitator", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{noRefundFunding: true})
		resp, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Nil(t, h.binding(t, hash))
	})

	t.Run("refuses to sign or broadcast for an unauthenticated caller", func(t *testing.T) {
		fx, h, _ := newCharge(t, delegatedOpts{identity: strPtr("")})
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrUnauthenticatedAuthorizerRequest)
		assert.Empty(t, h.authorizer.primaryTypes)
		assert.Empty(t, h.signer.writtenFunctions)
	})

	t.Run("treats a failing identity resolver as unauthenticated", func(t *testing.T) {
		fx, h, _ := newCharge(t, delegatedOpts{resolverErr: errors.New("auth backend down")})
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrUnauthenticatedAuthorizerRequest)
		assert.Empty(t, h.signer.writtenFunctions)
	})

	t.Run("fails closed with no broadcast when another identity already holds the binding", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{})
		h.bindRow(t, hash, "someone-else", fx.extra.RefundDeadline)
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrUnauthenticatedAuthorizerRequest)
		assert.Empty(t, h.signer.writtenFunctions)
		assert.Equal(t, "someone-else", h.binding(t, hash).CallerIdentity)
	})

	t.Run("fails closed with no broadcast when the binding store is unavailable", func(t *testing.T) {
		fx, h, _ := newCharge(t, delegatedOpts{storage: failingBindStorage{NewInMemoryAuthCaptureDelegatedAuthStorage()}})
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrDelegatedAuthUnavailable)
		assert.Empty(t, h.signer.writtenFunctions)
	})

	t.Run("reverts the binding it created when the broadcast is rejected", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{})
		h.signer.writeErr["charge"] = errors.New("insufficient funds for gas")
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		require.Error(t, err)
		assert.Nil(t, h.binding(t, hash))
	})

	t.Run("reverts the binding it created when the transaction reverts onchain", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{})
		h.signer.receipt = &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: h.signer.writeTx}
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		assertSettleReason(t, err, ErrTransactionReverted)
		assert.Nil(t, h.binding(t, hash))
	})

	t.Run("keeps the binding when the receipt wait times out", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{})
		h.signer.receiptErr = errors.New("receipt timeout")
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		require.Error(t, err)
		binding := h.binding(t, hash)
		require.NotNil(t, binding)
		assert.Equal(t, delegatedCaller, binding.CallerIdentity)
	})

	t.Run("does not delete a pre-existing binding when a same-identity retry reverts", func(t *testing.T) {
		fx, h, hash := newCharge(t, delegatedOpts{})
		h.bindRow(t, hash, delegatedCaller, fx.extra.RefundDeadline)
		h.signer.receipt = &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: h.signer.writeTx}
		_, err := h.scheme.Settle(context.Background(), unsigned(fx.complete(t, chargeOpts{})), fx.requirements, nil)
		require.Error(t, err)
		assert.NotNil(t, h.binding(t, hash))
	})

	t.Run("binds an authorize settle for a delegated operator", func(t *testing.T) {
		receiver := newKeySigner(t)
		requirements := facBaseRequirements(facCaptureAuthorizer, map[string]interface{}{"receiverAuthorizer": receiver.Address()})
		payload := buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})
		h := newDelegatedHarness(newMockFacSigner(facCaptureAuthorizer), receiver, delegatedOpts{})

		resp, err := h.scheme.Settle(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		require.Len(t, h.settles, 1)
		assert.Equal(t, DelegatedStepAuthorize, h.settles[0].Step)

		binding := h.binding(t, collectPaymentInfoHash(t, requirements, payload))
		require.NotNil(t, binding)
		assert.Equal(t, delegatedCaller, binding.CallerIdentity)
	})
}

// delegatedLifecycle is a lifecycle fixture served by a delegated harness.
func newDelegatedLifecycle(t *testing.T, opts delegatedOpts) (lifecycleFixture, *delegatedHarness) {
	t.Helper()
	fx := newLifecycleFixture(t, nil)
	return fx, newDelegatedHarness(fx.signer(), fx.receiver, opts)
}

// unsignedCapture is a capture the server built without a local receiver-authorizer signer.
func unsignedCapture(t *testing.T, fx lifecycleFixture, opts captureOpts, voidRemainder bool) types.PaymentPayload {
	t.Helper()
	wire := fx.buildCapture(t, opts)
	delete(wire, "authorizerSignature")
	delete(wire, "voidAuthorizerSignature")
	if voidRemainder {
		wire["voidRemainder"] = true
	}
	return fx.payload(wire)
}

func TestDelegatedLifecycle(t *testing.T) {

	t.Run("signs and settles an unsigned capture for the bound caller", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)

		resp, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{}, false), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		require.Len(t, h.settles, 1)
		assert.Equal(t, DelegatedStepCapture, h.settles[0].Step)
		assert.Equal(t, []string{"Capture"}, h.authorizer.primaryTypes)
		assert.Equal(t, []string{"capture"}, h.signer.writtenFunctions)
	})

	t.Run("verifies an unsigned capture for the bound caller and rejects everyone else", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		payload := unsignedCapture(t, fx, captureOpts{}, false)

		_, err := h.scheme.Verify(context.Background(), payload, fx.requirements, nil)
		assertVerifyReason(t, err, ErrUnauthenticatedAuthorizerRequest)

		h.bindRow(t, fx.paymentHash, "someone-else", fx.extra.RefundDeadline)
		_, err = h.scheme.Verify(context.Background(), payload, fx.requirements, nil)
		assertVerifyReason(t, err, ErrUnauthenticatedAuthorizerRequest)

		require.NoError(t, h.storage.Delete(context.Background(), facNetwork, fx.paymentHash))
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)
		resp, err := h.scheme.Verify(context.Background(), payload, fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})

	t.Run("rejects an unauthenticated caller before touching the binding store", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{identity: strPtr("")})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)

		_, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{}, false), fx.requirements, nil)
		assertSettleReason(t, err, ErrUnauthenticatedAuthorizerRequest)
		assert.Empty(t, h.signer.writtenFunctions)
	})

	t.Run("treats an expired binding as absent", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, 1)

		_, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{}, false), fx.requirements, nil)
		assertSettleReason(t, err, ErrUnauthenticatedAuthorizerRequest)
		assert.Empty(t, h.signer.writtenFunctions)
	})

	t.Run("reports the binding store being unavailable instead of unauthenticated", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{storage: failingGetStorage{NewInMemoryAuthCaptureDelegatedAuthStorage()}})

		_, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{}, false), fx.requirements, nil)
		assertSettleReason(t, err, ErrDelegatedAuthUnavailable)
		assert.Empty(t, h.signer.writtenFunctions)
	})

	t.Run("signs both legs of a capture that voids the remainder", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)
		h.signer.afterWrite = func(function string) {
			if function == "capture" {
				h.signer.paymentStateCapturable = big.NewInt(400000)
			}
		}

		resp, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{amount: "600000"}, true), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, []string{"Capture", "Void"}, h.authorizer.primaryTypes)
		assert.Equal(t, []string{"capture", "void"}, h.signer.writtenFunctions)
	})

	t.Run("rejects voidRemainder combined with a signature as a malformed payload", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)
		payload := unsignedCapture(t, fx, captureOpts{amount: "600000"}, true)
		payload.Payload["voidAuthorizerSignature"] = fx.voidSignature(t)

		_, err := h.scheme.Verify(context.Background(), payload, fx.requirements, nil)
		assertVerifyReason(t, err, ErrPayloadFormat)
		_, err = h.scheme.Settle(context.Background(), payload, fx.requirements, nil)
		assertSettleReason(t, err, ErrPayloadFormat)

		signed := fx.buildCapture(t, captureOpts{amount: "600000"})
		signed["voidRemainder"] = true
		_, err = h.scheme.Settle(context.Background(), fx.payload(signed), fx.requirements, nil)
		assertSettleReason(t, err, ErrPayloadFormat)
		assert.Empty(t, h.signer.writtenFunctions)
	})

	t.Run("rejects voidRemainder when the authorizer is not delegated", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		payload := unsignedCapture(t, fx, captureOpts{amount: "600000"}, true)

		_, err := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{}).Verify(context.Background(), payload, fx.requirements, nil)
		assertVerifyReason(t, err, ErrAuthorizerSignature)
	})

	t.Run("signs an unsigned void and releases the binding once nothing is left", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)
		h.signer.afterWrite = func(string) {
			h.signer.paymentStateCapturable = big.NewInt(0)
			h.signer.paymentStateRefundable = big.NewInt(0)
		}

		resp, err := h.scheme.Settle(context.Background(), unsigned(fx.payload(fx.buildVoid(t))), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, []string{"Void"}, h.authorizer.primaryTypes)
		assert.Nil(t, h.binding(t, fx.paymentHash))
	})

	t.Run("keeps the binding after a capture that leaves a refundable balance", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)

		resp, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{}, false), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.NotNil(t, h.binding(t, fx.paymentHash))
	})

	t.Run("does not release the binding when the lifecycle settle fails", func(t *testing.T) {
		fx, h := newDelegatedLifecycle(t, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)
		h.signer.writeErr["capture"] = errors.New("insufficient funds for gas")

		_, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{amount: "1000000"}, false), fx.requirements, nil)
		require.Error(t, err)
		assert.NotNil(t, h.binding(t, fx.paymentHash))
	})

	t.Run("reports a failing early delete to OnStorageError without failing the settle", func(t *testing.T) {
		storage := failingDeleteStorage{NewInMemoryAuthCaptureDelegatedAuthStorage()}
		fx, h := newDelegatedLifecycle(t, delegatedOpts{storage: storage})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)
		h.signer.afterWrite = func(string) {
			h.signer.paymentStateCapturable = big.NewInt(0)
			h.signer.paymentStateRefundable = big.NewInt(0)
		}

		resp, err := h.scheme.Settle(context.Background(), unsignedCapture(t, fx, captureOpts{amount: "600000"}, true), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.NotEmpty(t, h.reported.errs)
	})
}
