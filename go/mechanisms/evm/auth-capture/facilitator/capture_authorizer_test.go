package facilitator

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
)

var (
	poolAuthorizerA = "0x" + strings.Repeat("a1", 20)
	poolAuthorizerB = "0x" + strings.Repeat("b2", 20)
	poolAuthorizerC = "0x" + strings.Repeat("c3", 20)
)

func TestWriteIsPinnedToTheOperator(t *testing.T) {
	t.Run("a multi-address signer writes as the operator", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.addresses = []string{poolAuthorizerA, facCaptureAuthorizer}
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})

		resp, err := scheme.Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{})), fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, []string{facCaptureAuthorizer}, signer.writeFroms)
		assert.Equal(t, []string{"capture"}, signer.writtenFunctions)
	})

	t.Run("a capture with a void pins both writes", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		signer := fx.signer()
		signer.addresses = []string{poolAuthorizerA, facCaptureAuthorizer}
		signer.afterWrite = func(function string) {
			if function == "capture" {
				signer.paymentStateCapturable.SetInt64(400000)
			}
		}
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})

		_, err := scheme.Settle(context.Background(), fx.payload(fx.buildCapture(t, captureOpts{amount: "600000", withVoid: true})), fx.requirements, nil)
		require.NoError(t, err)
		assert.Equal(t, []string{facCaptureAuthorizer, facCaptureAuthorizer}, signer.writeFroms)
	})

	t.Run("a collect is pinned too", func(t *testing.T) {
		requirements := facBaseRequirements(facCaptureAuthorizer, nil)
		payload := buildCollectPayload(t, requirements, newKeySigner(t), collectOpts{})
		signer := newMockFacSigner(poolAuthorizerA, facCaptureAuthorizer)
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})

		resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Equal(t, []string{facCaptureAuthorizer}, signer.writeFroms)
	})
}

func TestNewAuthCaptureEvmSchemeWithError(t *testing.T) {
	multi := func() *mockFacSigner { return newMockFacSigner(poolAuthorizerA, poolAuthorizerB) }

	t.Run("accepts a pool of signer addresses", func(t *testing.T) {
		scheme, err := NewAuthCaptureEvmSchemeWithError(multi(), AuthCaptureEvmSchemeConfig{CaptureAuthorizers: []string{poolAuthorizerA, poolAuthorizerB}})
		require.NoError(t, err)
		assert.NotNil(t, scheme)
	})

	t.Run("accepts a relay-only multi-address signer without a pool", func(t *testing.T) {
		plain := &plainSigner{Signer: multi()}
		_, err := NewAuthCaptureEvmSchemeWithError(plain, AuthCaptureEvmSchemeConfig{Operators: allowAllCustomOperators})
		require.NoError(t, err)
	})

	t.Run("accepts a single-address signer without the sender capabilities", func(t *testing.T) {
		plain := &plainSigner{Signer: newMockFacSigner(poolAuthorizerA)}
		_, err := NewAuthCaptureEvmSchemeWithError(plain, AuthCaptureEvmSchemeConfig{CaptureAuthorizer: poolAuthorizerA})
		require.NoError(t, err)
	})

	t.Run("rejects a pool member the signer does not hold", func(t *testing.T) {
		_, err := NewAuthCaptureEvmSchemeWithError(multi(), AuthCaptureEvmSchemeConfig{CaptureAuthorizers: []string{poolAuthorizerA, poolAuthorizerC}})
		require.ErrorContains(t, err, "not one of the signer's addresses")
	})

	t.Run("rejects a shorthand outside the pool", func(t *testing.T) {
		_, err := NewAuthCaptureEvmSchemeWithError(multi(), AuthCaptureEvmSchemeConfig{
			CaptureAuthorizers: []string{poolAuthorizerA}, CaptureAuthorizer: poolAuthorizerB,
		})
		require.ErrorContains(t, err, "member of CaptureAuthorizers")
	})

	t.Run("rejects an invalid pool entry", func(t *testing.T) {
		_, err := NewAuthCaptureEvmSchemeWithError(multi(), AuthCaptureEvmSchemeConfig{CaptureAuthorizers: []string{poolAuthorizerA, ""}})
		require.ErrorContains(t, err, "CaptureAuthorizers contains")
	})

	t.Run("reports partial delegation as an error and the wrapper panics with the same message", func(t *testing.T) {
		config := AuthCaptureEvmSchemeConfig{ResolveCallerIdentity: func(context.Context, DelegatedSettleContext) (string, error) { return "", nil }}
		_, err := NewAuthCaptureEvmSchemeWithError(multi(), config)
		require.EqualError(t, err, "facilitator-delegated receiver authorization requires AuthorizerSigner")
		assert.PanicsWithValue(t, err.Error(), func() { NewAuthCaptureEvmScheme(multi(), config) })
	})
}

func TestGetExtraCaptureAuthorizerPool(t *testing.T) {
	pool := []string{poolAuthorizerA, poolAuthorizerB, poolAuthorizerC}
	signer := newMockFacSigner(pool...)
	advertised := func(scheme *AuthCaptureEvmScheme) string {
		value, _ := scheme.GetExtra(facNetwork)["captureAuthorizer"].(string)
		return value
	}

	t.Run("only returns pool members and eventually every one", func(t *testing.T) {
		scheme := NewAuthCaptureEvmScheme(signer, AuthCaptureEvmSchemeConfig{CaptureAuthorizers: pool})
		seen := map[string]bool{}
		for i := 0; i < 300; i++ {
			got := advertised(scheme)
			require.Contains(t, pool, got)
			seen[got] = true
		}
		assert.Len(t, seen, len(pool))
	})

	t.Run("honors the selector and passes the network and candidates", func(t *testing.T) {
		var gotNetwork x402.Network
		var gotCandidates []string
		scheme := NewAuthCaptureEvmScheme(signer, AuthCaptureEvmSchemeConfig{
			CaptureAuthorizers: pool,
			SelectCaptureAuthorizer: func(network x402.Network, candidates []string) string {
				gotNetwork, gotCandidates = network, candidates
				candidates[0] = "mutated"
				return strings.ToUpper(poolAuthorizerB)
			},
		})
		for i := 0; i < 20; i++ {
			assert.Equal(t, poolAuthorizerB, advertised(scheme))
		}
		assert.Equal(t, x402.Network(facNetwork), gotNetwork)
		assert.Len(t, gotCandidates, len(pool))
		assert.Equal(t, poolAuthorizerA, scheme.captureAuthorizers[0], "the selector cannot mutate the pool")
	})

	t.Run("falls back to a pool member when the selector answers outside the pool", func(t *testing.T) {
		scheme := NewAuthCaptureEvmScheme(signer, AuthCaptureEvmSchemeConfig{
			CaptureAuthorizers:      pool,
			SelectCaptureAuthorizer: func(x402.Network, []string) string { return "0x" + strings.Repeat("ee", 20) },
		})
		for i := 0; i < 50; i++ {
			assert.Contains(t, pool, advertised(scheme))
		}
	})

	t.Run("the shorthand advertises its single address", func(t *testing.T) {
		scheme := NewAuthCaptureEvmScheme(signer, AuthCaptureEvmSchemeConfig{CaptureAuthorizer: poolAuthorizerB})
		assert.Equal(t, poolAuthorizerB, advertised(scheme))
	})

	t.Run("a relay-only facilitator advertises none", func(t *testing.T) {
		scheme := NewAuthCaptureEvmScheme(signer, AuthCaptureEvmSchemeConfig{})
		assert.Nil(t, scheme.GetExtra(facNetwork))
	})
}

func TestLifecyclePendingKey(t *testing.T) {
	fx := newLifecycleFixture(t, nil)
	delegated := newDelegatedHarness(fx.signer(), fx.receiver, delegatedOpts{}).scheme
	selfSigned := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{})

	t.Run("a delegated payload is keyed independently of the authorizer signature", func(t *testing.T) {
		first := fx.buildCapture(t, captureOpts{})
		second := fx.buildCapture(t, captureOpts{})
		second["authorizerSignature"] = "0x" + strings.Repeat("11", 65)

		key := delegated.pendingKey(fx.payload(first), fx.requirements)
		require.NotEmpty(t, key)
		assert.Equal(t, key, delegated.pendingKey(fx.payload(second), fx.requirements))

		delete(second, "authorizerSignature")
		assert.Equal(t, key, delegated.pendingKey(fx.payload(second), fx.requirements), "an unsigned payload keys the same")
	})

	t.Run("a delegated key differs by type, amount and expected balances", func(t *testing.T) {
		keys := map[string]string{
			"full capture":    delegated.pendingKey(fx.payload(fx.buildCapture(t, captureOpts{})), fx.requirements),
			"partial capture": delegated.pendingKey(fx.payload(fx.buildCapture(t, captureOpts{amount: "600000"})), fx.requirements),
			"void":            delegated.pendingKey(fx.payload(fx.buildVoid(t)), fx.requirements),
			"refund":          delegated.pendingKey(fx.payload(fx.buildRefund(t, refundOpts{})), fx.requirements),
			"other refund":    delegated.pendingKey(fx.payload(fx.buildRefund(t, refundOpts{amount: "100000"})), fx.requirements),
			"stale refund":    delegated.pendingKey(fx.payload(fx.buildRefund(t, refundOpts{expectedRefundable: "5"})), fx.requirements),
		}
		unique := map[string]bool{}
		for name, key := range keys {
			require.NotEmpty(t, key, name)
			unique[key] = true
		}
		assert.Len(t, unique, len(keys))
	})

	t.Run("a delegated key includes the network and payment", func(t *testing.T) {
		key := delegated.pendingKey(fx.payload(fx.buildVoid(t)), fx.requirements)
		assert.True(t, strings.HasPrefix(key, facNetwork+"|"+strings.ToLower(fx.paymentHash)+"|void"), key)
	})

	t.Run("an unreadable delegated payload has no key", func(t *testing.T) {
		assert.Empty(t, delegated.pendingKey(fx.payload(map[string]interface{}{"type": "capture"}), fx.requirements))
	})

	t.Run("a server-signed payload keeps its authorizer signature as the key", func(t *testing.T) {
		wire := fx.buildCapture(t, captureOpts{})
		assert.Equal(t, wire["authorizerSignature"], selfSigned.pendingKey(fx.payload(wire), fx.requirements))
	})

	t.Run("a collect keeps the client signature", func(t *testing.T) {
		payload := fx.payload(map[string]interface{}{"signature": "0xabc"})
		assert.Equal(t, "0xabc", delegated.pendingKey(payload, fx.requirements))
		assert.Equal(t, "0xabc", selfSigned.pendingKey(payload, fx.requirements))
	})

	t.Run("a forged signature does not resume a server-signed settlement", func(t *testing.T) {
		signer := fx.signer()
		scheme := newScheme(signer, AuthCaptureEvmSchemeConfig{})
		wire := fx.buildCapture(t, captureOpts{})
		require.NoError(t, scheme.pendingStore.Set(context.Background(), scheme.pendingKey(fx.payload(wire), fx.requirements), signer.writeTx))

		forged := fx.buildCapture(t, captureOpts{})
		forged["authorizerSignature"] = "0x" + strings.Repeat("22", 65)
		_, err := scheme.Settle(context.Background(), fx.payload(forged), fx.requirements, nil)
		assertSettleReason(t, err, ErrAuthorizerSignature)
		_, stillPending, _ := scheme.pendingStore.Get(context.Background(), scheme.pendingKey(fx.payload(wire), fx.requirements))
		assert.True(t, stillPending)
	})

	t.Run("a delegated retry resumes the broadcast transaction", func(t *testing.T) {
		h := newDelegatedHarness(fx.signer(), fx.receiver, delegatedOpts{})
		h.bindRow(t, fx.paymentHash, delegatedCaller, fx.extra.RefundDeadline)
		payload := unsignedCapture(t, fx, captureOpts{}, false)
		require.NoError(t, h.scheme.pendingStore.Set(context.Background(), h.scheme.pendingKey(payload, fx.requirements), h.signer.writeTx))

		resp, err := h.scheme.Settle(context.Background(), payload, fx.requirements, nil)
		require.NoError(t, err)
		assert.True(t, resp.Success)
		assert.Empty(t, h.signer.writtenFunctions)
	})
}

// ctxRecordingStorage records the state of the context each cleanup call receives.
type ctxRecordingStorage struct {
	AuthCaptureDelegatedAuthStorage
	mu          sync.Mutex
	ctxErr      error
	hadDeadline bool
	called      bool
}

func (s *ctxRecordingStorage) record(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ctxErr = ctx.Err()
	_, s.hadDeadline = ctx.Deadline()
	s.called = true
}

func (s *ctxRecordingStorage) RevertBind(ctx context.Context, write AuthCaptureDelegatedAuthWrite) error {
	s.record(ctx)
	return s.AuthCaptureDelegatedAuthStorage.RevertBind(ctx, write)
}

func (s *ctxRecordingStorage) Delete(ctx context.Context, network x402.Network, paymentInfoHash string) error {
	s.record(ctx)
	return s.AuthCaptureDelegatedAuthStorage.Delete(ctx, network, paymentInfoHash)
}

func TestBindingCleanupSurvivesRequestCancellation(t *testing.T) {
	t.Run("RevertBind runs on a live bounded context after the request is cancelled", func(t *testing.T) {
		inner := NewInMemoryAuthCaptureDelegatedAuthStorage()
		storage := &ctxRecordingStorage{AuthCaptureDelegatedAuthStorage: inner}
		delegated := delegatedWith(storage, &recordedStorageErrors{})
		record := delegatedRecord(func(r *AuthCaptureDelegatedAuthRecord) { r.ExpiresAt = uint64(time.Now().Unix() + 3600) })

		ctx, cancel := context.WithCancel(context.Background())
		result := bindThenBroadcast(ctx, delegated, record, func() (string, bindDisposition) {
			cancel()
			return "done", bindRevert
		})
		require.True(t, result.OK)

		assert.True(t, storage.called)
		assert.NoError(t, storage.ctxErr, "the cleanup context must not inherit the cancellation")
		assert.True(t, storage.hadDeadline, "the cleanup context must be bounded")
		stored, err := inner.Get(context.Background(), record.Network, record.PaymentInfoHash)
		require.NoError(t, err)
		assert.Nil(t, stored, "the binding is gone")
	})

	t.Run("the terminal binding is deleted after the request is cancelled", func(t *testing.T) {
		fx := newLifecycleFixture(t, nil)
		inner := NewInMemoryAuthCaptureDelegatedAuthStorage()
		storage := &ctxRecordingStorage{AuthCaptureDelegatedAuthStorage: inner}
		delegated := delegatedWith(storage, &recordedStorageErrors{})
		network := x402.Network(fx.requirements.Network)
		_, err := inner.Bind(context.Background(), AuthCaptureDelegatedAuthRecord{
			Network: network, PaymentInfoHash: fx.paymentHash, CallerIdentity: "caller", ExpiresAt: fx.extra.RefundDeadline,
		})
		require.NoError(t, err)

		scheme := newScheme(fx.signer(), AuthCaptureEvmSchemeConfig{})
		lc := &lifecyclePreconditions{deployment: fx.deployment, extra: fx.extra, chainID: fx.chainID, paymentInfo: fx.paymentInfo, paymentInfoHash: fx.paymentHash}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		scheme.releaseTerminalBinding(ctx, delegated, lc, fx.requirements, fx.buildRefund(t, refundOpts{amount: fx.paymentInfo.MaxAmount}))

		assert.True(t, storage.called)
		assert.NoError(t, storage.ctxErr)
		assert.True(t, storage.hadDeadline)
		stored, err := inner.Get(context.Background(), network, fx.paymentHash)
		require.NoError(t, err)
		assert.Nil(t, stored)
	})
}
