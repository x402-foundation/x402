package facilitator_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
	casperFacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/facilitator"

	caspertypes "github.com/make-software/casper-go-sdk/v2/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testNetwork     = casper.CasperTestnetCAIP2
	testAsset       = "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788"
	testPayTo       = "00aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788"
	testFrom        = "00386de2f21fdda3d8d8c7fa99384a6a35d7dfbf37c0d71475cd2d9329175410fd"
	testPublicKey   = "01aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788"
	facilitatorAddr = testFrom
)

type mockFacilitatorSigner struct {
	rpcURL              string
	addresses           []string
	publicKeyHex        string
	verifyResult        bool
	verifyErr           error
	putDeployResult     string
	putDeployErr        error
	putCalls            atomic.Int32
	waitErr             error
	waitFn              func(ctx context.Context) error
	speculativeRpcURL   string
	capturedTransaction *caspertypes.TransactionV1
	capturedDeploy      *caspertypes.Deploy
}

func (m *mockFacilitatorSigner) GetNetworkConfig(_ context.Context, _ string) (casper.NetworkConfig, error) {
	return casper.NetworkConfig{
		ChainName: casper.ChainNameFromNetwork(testNetwork),
		RPCURL:    m.rpcURL,
	}, nil
}

func (m *mockFacilitatorSigner) GetAddresses(_ context.Context, _ string) []string {
	return m.addresses
}

func (m *mockFacilitatorSigner) GetPublicKeyHex(_ context.Context, _ string) (string, error) {
	return m.publicKeyHex, nil
}

func (m *mockFacilitatorSigner) VerifyEIP712Signature(_ [32]byte, _ [65]byte, _ string) (bool, error) {
	return m.verifyResult, m.verifyErr
}

func (m *mockFacilitatorSigner) SignTransaction(tx *caspertypes.TransactionV1, _ string) error {
	m.capturedTransaction = tx
	return nil
}
func (m *mockFacilitatorSigner) SignDeploy(deploy *caspertypes.Deploy, _ string) error {
	m.capturedDeploy = deploy
	return nil
}
func (m *mockFacilitatorSigner) GetSpeculativeRpcUrl(_ string) string {
	return m.speculativeRpcURL
}
func (m *mockFacilitatorSigner) PutTransaction(_ context.Context, _ string, _ caspertypes.TransactionV1) (string, error) {
	m.putCalls.Add(1)
	return m.putDeployResult, m.putDeployErr
}
func (m *mockFacilitatorSigner) WaitForTransaction(ctx context.Context, _ string, _ string) error {
	if m.waitFn != nil {
		return m.waitFn(ctx)
	}
	return m.waitErr
}

func defaultSigner(t *testing.T) *mockFacilitatorSigner {
	t.Helper()
	fixture := newPreflightFixture(t)
	return &mockFacilitatorSigner{
		rpcURL:          fixture.url,
		addresses:       []string{facilitatorAddr},
		publicKeyHex:    testPublicKey,
		verifyResult:    true,
		putDeployResult: strings.Repeat("ab", 32),
	}
}

func buildValidPayload(t *testing.T) (types.PaymentPayload, types.PaymentRequirements) {
	t.Helper()

	now := time.Now().Unix()
	payloadObj := &casper.ExactCasperPayload{
		Signature: "01" + strings.Repeat("ab", 64),
		PublicKey: testPublicKey,
		Authorization: casper.ExactCasperAuthorization{
			From:        testFrom,
			To:          testPayTo,
			Value:       "1000000",
			ValidAfter:  fmt.Sprintf("%d", now-60),
			ValidBefore: fmt.Sprintf("%d", now+300),
			Nonce:       "aabbccddeeff0011223344556677889900aabbccddeeff001122334455667788",
		},
	}

	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     payloadObj.ToMap(),
		Accepted: types.PaymentRequirements{
			Scheme:  "exact",
			Network: testNetwork,
		},
	}

	req := types.PaymentRequirements{
		Scheme:  "exact",
		Network: testNetwork,
		Asset:   testAsset,
		Amount:  "1000000",
		PayTo:   testPayTo,
		Extra: map[string]interface{}{
			"name":    "TestToken",
			"version": "1",
		},
	}

	return payload, req
}

func TestGetExtra_ReturnsNoExtra(t *testing.T) {
	scheme := casperFacilitator.NewExactCasperScheme(defaultSigner(t), nil)

	assert.Nil(t, scheme.GetExtra(x402.Network(testNetwork)))
}

func TestGetSigners_ReturnsSignerAddresses(t *testing.T) {
	scheme := casperFacilitator.NewExactCasperScheme(defaultSigner(t), nil)

	assert.Equal(t, []string{facilitatorAddr}, scheme.GetSigners(x402.Network(testNetwork)))
}

func TestVerify_HappyPath(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	resp, err := scheme.Verify(context.Background(), payload, req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, testFrom, resp.Payer)
}

func TestVerify_WrongScheme(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	payload.Accepted.Scheme = "upto"

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	assert.ErrorContains(t, err, casperFacilitator.ErrUnsupportedScheme)
}

func TestVerify_NetworkMismatch(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	payload.Accepted.Network = casper.CasperMainnetCAIP2

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	assert.ErrorContains(t, err, casperFacilitator.ErrNetworkMismatch)
}

func TestVerify_PayToMismatch(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	req.PayTo = "00" + strings.Repeat("bb", 32)

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	assert.ErrorContains(t, err, casperFacilitator.ErrPayToMismatch)
}

func TestVerify_AmountMismatch(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	req.Amount = "9999999"

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	assert.ErrorContains(t, err, casperFacilitator.ErrAmountMismatch)
}

func TestVerify_Expired(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	auth := payload.Payload["authorization"].(map[string]interface{})
	auth["validBefore"] = fmt.Sprintf("%d", time.Now().Unix()-1)

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	assert.ErrorContains(t, err, casperFacilitator.ErrPayloadExpired)
}

func TestVerify_NotYetValid(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	now := time.Now().Unix()
	auth := payload.Payload["authorization"].(map[string]interface{})
	auth["validAfter"] = fmt.Sprintf("%d", now+9999)
	auth["validBefore"] = fmt.Sprintf("%d", now+10000)

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	assert.ErrorContains(t, err, casperFacilitator.ErrNotYetValid)
}

// startOfNextSecond sleeps to just past a second boundary so a test can read
// time.Now().Unix() and have Verify observe the same second.
func startOfNextSecond() int64 {
	time.Sleep(time.Until(time.Now().Truncate(time.Second).Add(time.Second + 10*time.Millisecond)))
	return time.Now().Unix()
}

func TestVerify_StrictTimeBounds(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	t.Run("validAfter equal to now is not yet valid", func(t *testing.T) {
		payload, req := buildValidPayload(t)
		auth := payload.Payload["authorization"].(map[string]interface{})
		now := startOfNextSecond()
		auth["validAfter"] = fmt.Sprintf("%d", now)

		_, err := scheme.Verify(context.Background(), payload, req, nil)
		assert.ErrorContains(t, err, casperFacilitator.ErrNotYetValid)
		assert.ErrorContains(t, err, fmt.Sprintf("validAfter=%d >= now=%d", now, now))
	})

	t.Run("validBefore equal to now is expired", func(t *testing.T) {
		payload, req := buildValidPayload(t)
		auth := payload.Payload["authorization"].(map[string]interface{})
		now := startOfNextSecond()
		auth["validBefore"] = fmt.Sprintf("%d", now)

		_, err := scheme.Verify(context.Background(), payload, req, nil)
		assert.ErrorContains(t, err, casperFacilitator.ErrPayloadExpired)
		assert.ErrorContains(t, err, fmt.Sprintf("validBefore=%d <= now=%d", now, now))
	})
}

func TestVerify_TimestampsMustBeUint64(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	for name, values := range map[string][2]string{
		"negative validAfter":     {"-1", ""},
		"signed validAfter":       {"+1", ""},
		"negative validBefore":    {"", "-1"},
		"overflowing validBefore": {"", "18446744073709551616"},
	} {
		t.Run(name, func(t *testing.T) {
			payload, req := buildValidPayload(t)
			auth := payload.Payload["authorization"].(map[string]interface{})
			if values[0] != "" {
				auth["validAfter"] = values[0]
			}
			if values[1] != "" {
				auth["validBefore"] = values[1]
			}

			_, err := scheme.Verify(context.Background(), payload, req, nil)
			assert.ErrorContains(t, err, casperFacilitator.ErrMalformedPayload)
		})
	}

	// The full U64 range is valid on chain, including values above MaxInt64.
	t.Run("max uint64 validBefore", func(t *testing.T) {
		payload, req := buildValidPayload(t)
		payload.Payload["authorization"].(map[string]interface{})["validBefore"] = "18446744073709551615"

		resp, err := scheme.Verify(context.Background(), payload, req, nil)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})
}

func TestVerify_SpeculativeRpcURL_RejectsNoEffects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"api_version":"2.0.0","block_hash":"` + strings.Repeat("11", 32) + `","execution_result":{"Version2":{"initiator":{"PublicKey":"` + testPublicKey + `"},"error_message":null,"limit":"0","consumed":"0","cost":"0","refund":"0","payment":null,"transfers":[],"size_estimate":0,"effects":[]}}}}`))
	}))
	defer server.Close()
	signer := defaultSigner(t)
	signer.speculativeRpcURL = server.URL
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	require.ErrorContains(t, err, casperFacilitator.ErrSpeculativeExecutionFailed)
	assert.ErrorContains(t, err, "returned no effects, so the transfer cannot be confirmed")
}

func TestSettle_HappyPath(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	resp, err := scheme.Settle(context.Background(), payload, req, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Regexp(t, `^[0-9a-fA-F]{64}$`, resp.Transaction)
	assert.Equal(t, testFrom, resp.Payer)
	assert.Equal(t, x402.Network(testNetwork), resp.Network)
}

func TestSettle_UsesValueArgumentByDefault(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	_, err := scheme.Settle(context.Background(), payload, req, nil)
	require.NoError(t, err)
	require.NotNil(t, signer.capturedTransaction)

	args := signer.capturedTransaction.Payload.Fields.NamedArgs.Args
	require.NotNil(t, args)
	_, err = args.Find("value")
	assert.NoError(t, err)
	_, err = args.Find("amount")
	assert.Error(t, err)
}

func TestSettle_UsesAmountArgumentForLegacyPackage(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, &casperFacilitator.ExactCasperSchemeConfig{
		LegacyPackagesWithAmountArg: []string{testAsset},
	})

	payload, req := buildValidPayload(t)
	_, err := scheme.Settle(context.Background(), payload, req, nil)
	require.NoError(t, err)
	require.NotNil(t, signer.capturedTransaction)

	args := signer.capturedTransaction.Payload.Fields.NamedArgs.Args
	require.NotNil(t, args)
	_, err = args.Find("amount")
	assert.NoError(t, err)
	_, err = args.Find("value")
	assert.Error(t, err)
}

func TestSettle_VerifyFails(t *testing.T) {
	signer := defaultSigner(t)
	signer.verifyResult = false

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	var settleErr *x402.SettleError
	require.ErrorAs(t, err, &settleErr)
	assert.Equal(t, casperFacilitator.ErrInvalidSignature, settleErr.ErrorReason)
	assert.Empty(t, settleErr.Transaction)
}

func TestSettle_PutDeployFails(t *testing.T) {
	signer := defaultSigner(t)
	signer.putDeployErr = fmt.Errorf("rpc timeout")

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	assert.ErrorContains(t, err, casperFacilitator.ErrPutDeployFailed)
}

func requireSettleError(t *testing.T, err error) *x402.SettleError {
	t.Helper()
	var settleErr *x402.SettleError
	require.ErrorAs(t, err, &settleErr)
	return settleErr
}

func TestSettle_WaitTimeoutReturnsSettlementPending(t *testing.T) {
	signer := defaultSigner(t)
	signer.waitErr = fmt.Errorf("transaction not confirmed: %w", context.DeadlineExceeded)

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	payload, req := buildValidPayload(t)

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	settleErr := requireSettleError(t, err)
	assert.Equal(t, x402.ErrSettlementPending, settleErr.ErrorReason)
	assert.Equal(t, testFrom, settleErr.Payer)
	require.NotNil(t, signer.capturedTransaction)
	txHash := signer.capturedTransaction.Hash.String()
	assert.Equal(t, txHash, settleErr.Transaction)
	assert.Equal(t, map[string]string{strings.ToLower(payload.Payload["signature"].(string)): txHash}, store.Entries())
}

func TestSettle_PendingRetryReconcilesWithoutRebroadcast(t *testing.T) {
	signer := defaultSigner(t)
	signer.waitErr = context.DeadlineExceeded

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	payload, req := buildValidPayload(t)

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	pending := requireSettleError(t, err)
	require.Equal(t, x402.ErrSettlementPending, pending.ErrorReason)

	// The transaction landed. A retry must reconcile without re-verifying, which
	// would now fail because the nonce is consumed.
	signer.waitErr = nil
	signer.verifyResult = false
	resp, err := scheme.Settle(context.Background(), payload, req, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, pending.Transaction, resp.Transaction)
	assert.Equal(t, testFrom, resp.Payer)
	assert.Equal(t, int32(1), signer.putCalls.Load())
	assert.Empty(t, store.Entries())
}

func TestSettle_PendingRetryStillUnconfirmedStaysPending(t *testing.T) {
	signer := defaultSigner(t)
	signer.waitErr = context.DeadlineExceeded

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	payload, req := buildValidPayload(t)

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	first := requireSettleError(t, err)
	_, err = scheme.Settle(context.Background(), payload, req, nil)
	second := requireSettleError(t, err)

	assert.Equal(t, x402.ErrSettlementPending, second.ErrorReason)
	assert.Equal(t, first.Transaction, second.Transaction)
	assert.Equal(t, int32(1), signer.putCalls.Load())
	assert.Len(t, store.Entries(), 1)
}

func TestSettle_ExecutionFailureIsTerminal(t *testing.T) {
	signer := defaultSigner(t)
	signer.waitErr = &casper.TransactionExecutionError{Message: "Out of gas error"}

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	store := x402.NewInMemoryPendingSettlementStore()
	scheme.SetPendingSettlementStore(store)
	payload, req := buildValidPayload(t)

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	settleErr := requireSettleError(t, err)
	assert.Equal(t, casperFacilitator.ErrTransactionFailed, settleErr.ErrorReason)
	assert.Equal(t, signer.capturedTransaction.Hash.String(), settleErr.Transaction)
	assert.Contains(t, settleErr.ErrorMessage, "Out of gas error")
	assert.Empty(t, store.Entries())

	// The broadcast transaction keeps the nonce locked, so no second one is sent.
	_, err = scheme.Settle(context.Background(), payload, req, nil)
	assert.Equal(t, casperFacilitator.ErrDuplicateSettlement, requireSettleError(t, err).ErrorReason)
	assert.Equal(t, int32(1), signer.putCalls.Load())
}

type failingPendingStore struct {
	x402.PendingSettlementStore
}

func (failingPendingStore) Set(context.Context, string, string) error {
	return fmt.Errorf("store unavailable")
}

func TestSettle_PendingStoreWriteFailureIsTerminal(t *testing.T) {
	signer := defaultSigner(t)
	signer.waitErr = context.DeadlineExceeded

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	scheme.SetPendingSettlementStore(failingPendingStore{x402.NewInMemoryPendingSettlementStore()})
	payload, req := buildValidPayload(t)

	_, err := scheme.Settle(context.Background(), payload, req, nil)
	settleErr := requireSettleError(t, err)
	assert.Equal(t, casperFacilitator.ErrTransactionFailed, settleErr.ErrorReason)
	assert.Equal(t, signer.capturedTransaction.Hash.String(), settleErr.Transaction)
	assert.Contains(t, settleErr.ErrorMessage, "failed to persist for retry")
}

func TestSettle_ConcurrentDuplicateRejected(t *testing.T) {
	signer := defaultSigner(t)
	waiting := make(chan struct{})
	release := make(chan struct{})
	signer.waitFn = func(context.Context) error {
		close(waiting)
		<-release
		return nil
	}

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	var wg sync.WaitGroup
	var firstResp *x402.SettleResponse
	var firstErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		firstResp, firstErr = scheme.Settle(context.Background(), payload, req, nil)
	}()
	<-waiting

	// Same nonce with a different signature is still the same on-chain authorization.
	duplicate, _ := buildValidPayload(t)
	duplicate.Payload["signature"] = "01" + strings.Repeat("cd", 64)
	_, err := scheme.Settle(context.Background(), duplicate, req, nil)
	settleErr := requireSettleError(t, err)
	assert.Equal(t, casperFacilitator.ErrDuplicateSettlement, settleErr.ErrorReason)
	assert.Equal(t, testFrom, settleErr.Payer)

	close(release)
	wg.Wait()
	require.NoError(t, firstErr)
	assert.True(t, firstResp.Success)
	assert.Equal(t, int32(1), signer.putCalls.Load())
}

func TestSettle_SharedSettlementCacheAcrossSchemes(t *testing.T) {
	cache := casper.NewSettlementCache()
	config := &casperFacilitator.ExactCasperSchemeConfig{SettlementCache: cache}
	first := casperFacilitator.NewExactCasperScheme(defaultSigner(t), config)
	second := casperFacilitator.NewExactCasperScheme(defaultSigner(t), config)
	payload, req := buildValidPayload(t)

	_, err := first.Settle(context.Background(), payload, req, nil)
	require.NoError(t, err)
	_, err = second.Settle(context.Background(), payload, req, nil)
	assert.Equal(t, casperFacilitator.ErrDuplicateSettlement, requireSettleError(t, err).ErrorReason)
}

func TestSettle_FailureBeforeBroadcastReleasesLock(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	signer.verifyResult = false
	_, err := scheme.Settle(context.Background(), payload, req, nil)
	assert.Equal(t, casperFacilitator.ErrInvalidSignature, requireSettleError(t, err).ErrorReason)

	signer.putDeployErr = fmt.Errorf("rpc unavailable")
	signer.verifyResult = true
	_, err = scheme.Settle(context.Background(), payload, req, nil)
	assert.Equal(t, casperFacilitator.ErrPutDeployFailed, requireSettleError(t, err).ErrorReason)

	signer.putDeployErr = nil
	resp, err := scheme.Settle(context.Background(), payload, req, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

func TestVerify_NoSpeculativeRpcURL_ChecksTargetedState(t *testing.T) {
	signer := defaultSigner(t)
	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)

	payload, req := buildValidPayload(t)
	resp, err := scheme.Verify(context.Background(), payload, req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Nil(t, signer.capturedDeploy, "no deploy should be signed when speculative RPC URL is unset")
}

func TestVerify_SpeculativeRpcURL_SignsDeployAndReportsEndpointError(t *testing.T) {
	signer := defaultSigner(t)
	signer.speculativeRpcURL = "http://127.0.0.1:1/rpc"

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	assert.Error(t, err)
	assert.ErrorContains(t, err, casperFacilitator.ErrSpeculativeExecutionFailed)
	require.NotNil(t, signer.capturedDeploy, "deploy must be built and passed to SignDeploy before speculative exec")
	assert.Equal(t, "transfer_with_authorization", signer.capturedDeploy.Session.StoredVersionedContractByHash.EntryPoint)
	assert.NotNil(t, signer.capturedDeploy.Session.StoredVersionedContractByHash.Args)
}

func TestVerify_SpeculativeRpcURL_AcceptsSuccessfulExecution(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"jsonrpc": "2.0",
			"id": "1",
			"result": {
				"api_version": "2.0.0",
				"execution_result": {
					"block_hash": "0000000000000000000000000000000000000000000000000000000000000000",
					"limit": "0",
					"consumed": "0",
					"transfers": [],
					"effects": [{"key":"hash-0000000000000000000000000000000000000000000000000000000000000000","kind":"Identity"}],
					"messages": [],
					"error": null
				}
			}
		}`))
	}))
	defer server.Close()

	signer := defaultSigner(t)
	signer.speculativeRpcURL = server.URL

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	resp, err := scheme.Verify(context.Background(), payload, req, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, testFrom, resp.Payer)
	require.NotNil(t, signer.capturedDeploy)
	assert.Equal(t, "casper-test", signer.capturedDeploy.Header.ChainName)
}

func TestVerify_SpeculativeRpcURL_RejectsExecutionError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"jsonrpc": "2.0",
			"id": "1",
			"result": {
				"api_version": "2.0.0",
				"execution_result": {
					"block_hash": "0000000000000000000000000000000000000000000000000000000000000000",
					"limit": "0",
					"consumed": "0",
					"transfers": [],
					"effects": [],
					"messages": [],
					"error": "InsufficientFunds"
				}
			}
		}`))
	}))
	defer server.Close()

	signer := defaultSigner(t)
	signer.speculativeRpcURL = server.URL

	scheme := casperFacilitator.NewExactCasperScheme(signer, nil)
	payload, req := buildValidPayload(t)

	_, err := scheme.Verify(context.Background(), payload, req, nil)
	require.Error(t, err)
	assert.ErrorContains(t, err, casperFacilitator.ErrSpeculativeExecutionFailed)
	assert.ErrorContains(t, err, "InsufficientFunds")
}
