package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// statusDoubleSigner confirms through the real SVM confirmation wait against
// a local JSON-RPC status double. SendTransaction never calls the RPC.
type statusDoubleSigner struct {
	addresses []solana.PublicKey
	signature solana.Signature
	client    *rpc.Client
	sendCalls int
}

func (s *statusDoubleSigner) GetAddresses(context.Context, string) []solana.PublicKey {
	return s.addresses
}
func (s *statusDoubleSigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return nil
}
func (s *statusDoubleSigner) SimulateTransaction(context.Context, *solana.Transaction, string, *svm.FacilitatorSimulateTransactionOptions) error {
	return nil
}
func (s *statusDoubleSigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	s.sendCalls++
	return s.signature, nil
}
func (s *statusDoubleSigner) ConfirmTransaction(ctx context.Context, signature solana.Signature, _ string) error {
	return svm.ConfirmSignature(ctx, s.client, signature, svm.ConfirmPolicy{
		MaxAttempts: 1,
		Sleep:       func(time.Duration) {},
	})
}

type statusScript struct {
	mu      sync.Mutex
	methods []string
	result  string
	fail    bool
}

func (s *statusScript) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		require.NoError(t, json.Unmarshal(raw, &req))
		s.mu.Lock()
		s.methods = append(s.methods, req.Method)
		fail := s.fail
		result := s.result
		s.mu.Unlock()
		if req.Method == "sendTransaction" {
			t.Errorf("status double received sendTransaction")
		}
		if fail {
			hj, ok := w.(http.Hijacker)
			require.True(t, ok)
			conn, _, err := hj.Hijack()
			require.NoError(t, err)
			_ = conn.Close()
			return
		}
		if req.Method == "getTransaction" {
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"error":{"code":-32600,"message":"not used"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"result":` + result + `}`))
	})
}

func (s *statusScript) set(result string) {
	s.mu.Lock()
	s.result = result
	s.fail = false
	s.mu.Unlock()
}

func statusResult(level string, failed bool) string {
	errField := "null"
	statusField := `{"Ok":null}`
	if failed {
		errField = `{"InstructionError":[2,{"Custom":4}]}`
		statusField = `{"Err":{"InstructionError":[2,{"Custom":4}]}}`
	}
	return `{"context":{"slot":4},"value":[{"slot":4,"confirmations":null,"err":` + errField + `,"status":` + statusField + `,"confirmationStatus":"` + level + `"}]}`
}

func newStatusScheme(t *testing.T, server *httptest.Server, facilitator solana.PublicKey, sig solana.Signature) (*ExactSvmScheme, *statusDoubleSigner) {
	t.Helper()
	signer := &statusDoubleSigner{
		addresses: []solana.PublicKey{facilitator},
		signature: sig,
		client:    rpc.New(server.URL),
	}
	return NewExactSvmScheme(signer), signer
}

func settleError(t *testing.T, err error) *x402.SettleError {
	t.Helper()
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	return se
}

func TestExactSvmScheme_ConfirmedAndFinalizedFailuresAreTerminal(t *testing.T) {
	for _, level := range []string{"confirmed", "finalized"} {
		t.Run(level, func(t *testing.T) {
			payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
			sig := solana.SignatureFromBytes(append([]byte{level[0]}, make([]byte, 63)...))
			script := &statusScript{}
			script.set(statusResult(level, true))
			server := httptest.NewServer(script.handler(t))
			defer server.Close()
			scheme, signer := newStatusScheme(t, server, facilitatorAddr, sig)
			txKey := messageHashForPayload(t, payload)

			_, err := scheme.Settle(context.Background(), payload, requirements, nil)
			se := settleError(t, err)
			assert.Equal(t, ErrTransactionFailed, se.ErrorReason)
			assert.Equal(t, sig.String(), se.Transaction)
			assert.Contains(t, se.ErrorMessage, "transaction failed on-chain: map[InstructionError:[2 map[Custom:4]]]")
			assert.NotEqual(t, ErrSettlementPending, se.ErrorReason)
			assert.Equal(t, 1, signer.sendCalls)

			_, stored, _ := scheme.pendingStore.Get(context.Background(), txKey)
			assert.False(t, stored, "a confirmed execution failure must not stay pending")
			_, held := scheme.settlementCache.Entries()[txKey]
			assert.True(t, held, "the first broadcast stays owned")

			_, err = scheme.Settle(context.Background(), payload, requirements, nil)
			se = settleError(t, err)
			assert.Equal(t, ErrDuplicateSettlement, se.ErrorReason)
			assert.Equal(t, 1, signer.sendCalls, "terminal failure must not broadcast again")
		})
	}
}

func TestExactSvmScheme_UncertainStatusStaysPendingWithoutSecondBroadcast(t *testing.T) {
	cases := []struct {
		name    string
		result  string
		fail    bool
		wantMsg string
	}{
		{name: "timeout", result: `{"context":{"slot":1},"value":[null]}`, wantMsg: "timed out"},
		{name: "malformed", result: `{"context":{"slot":1},"value":"nope"}`, wantMsg: "unavailable"},
		{name: "transport", fail: true, wantMsg: "unavailable"},
		{name: "processed error is not terminal", result: statusResult("processed", true), wantMsg: "timed out"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
			sig := solana.SignatureFromBytes(append([]byte{7}, make([]byte, 63)...))
			script := &statusScript{result: tc.result, fail: tc.fail}
			server := httptest.NewServer(script.handler(t))
			defer server.Close()
			scheme, signer := newStatusScheme(t, server, facilitatorAddr, sig)
			txKey := messageHashForPayload(t, payload)

			_, err := scheme.Settle(context.Background(), payload, requirements, nil)
			se := settleError(t, err)
			assert.Equal(t, ErrSettlementPending, se.ErrorReason)
			assert.Equal(t, sig.String(), se.Transaction)
			assert.Contains(t, se.ErrorMessage, tc.wantMsg)
			assert.Equal(t, 1, signer.sendCalls)
			stored, ok, _ := scheme.pendingStore.Get(context.Background(), txKey)
			require.True(t, ok)
			assert.Equal(t, sig.String(), stored)

			_, err = scheme.Settle(context.Background(), payload, requirements, nil)
			se = settleError(t, err)
			assert.Equal(t, ErrSettlementPending, se.ErrorReason)
			assert.Equal(t, sig.String(), se.Transaction)
			assert.Equal(t, 1, signer.sendCalls, "pending reconciliation must not broadcast again")
		})
	}
}

func TestExactSvmScheme_ConfirmedAndFinalizedSuccess(t *testing.T) {
	for _, level := range []string{"confirmed", "finalized"} {
		t.Run(level, func(t *testing.T) {
			payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
			sig := solana.SignatureFromBytes(append([]byte{level[0] + 1}, make([]byte, 63)...))
			script := &statusScript{}
			script.set(statusResult(level, false))
			server := httptest.NewServer(script.handler(t))
			defer server.Close()
			scheme, signer := newStatusScheme(t, server, facilitatorAddr, sig)
			txKey := messageHashForPayload(t, payload)

			resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
			require.NoError(t, err)
			assert.True(t, resp.Success)
			assert.Equal(t, sig.String(), resp.Transaction)
			assert.Equal(t, 1, signer.sendCalls)
			_, stored, _ := scheme.pendingStore.Get(context.Background(), txKey)
			assert.False(t, stored)
		})
	}
}

func TestExactSvmScheme_RestartReconcilesTerminalFailureWithoutPendingOrBroadcast(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	sig := solana.SignatureFromBytes(append([]byte{4}, make([]byte, 63)...))
	script := &statusScript{}
	script.set(`{"context":{"slot":1},"value":[null]}`)
	server := httptest.NewServer(script.handler(t))
	defer server.Close()

	store := x402.NewInMemoryPendingSettlementStore()
	firstSigner := &statusDoubleSigner{
		addresses: []solana.PublicKey{facilitatorAddr},
		signature: sig,
		client:    rpc.New(server.URL),
	}
	first := NewExactSvmScheme(firstSigner)
	first.SetPendingSettlementStore(store)
	txKey := messageHashForPayload(t, payload)

	_, err := first.Settle(context.Background(), payload, requirements, nil)
	se := settleError(t, err)
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	assert.Equal(t, 1, firstSigner.sendCalls)
	stored, ok, _ := store.Get(context.Background(), txKey)
	require.True(t, ok)
	assert.Equal(t, sig.String(), stored)

	script.set(statusResult("confirmed", true))
	restartSigner := &statusDoubleSigner{
		addresses: []solana.PublicKey{facilitatorAddr},
		signature: solana.SignatureFromBytes(append([]byte{5}, make([]byte, 63)...)),
		client:    rpc.New(server.URL),
	}
	restarted := NewExactSvmScheme(restartSigner)
	restarted.SetPendingSettlementStore(store)

	_, err = restarted.Settle(context.Background(), payload, requirements, nil)
	se = settleError(t, err)
	assert.Equal(t, ErrTransactionFailed, se.ErrorReason)
	assert.Equal(t, sig.String(), se.Transaction)
	assert.Contains(t, se.ErrorMessage, "InstructionError")
	assert.Equal(t, 0, restartSigner.sendCalls, "restart reconciliation must not broadcast")
	_, storedOK, _ := store.Get(context.Background(), txKey)
	assert.False(t, storedOK, "restart must not turn a terminal chain error back into pending")

	_, err = restarted.Settle(context.Background(), payload, requirements, nil)
	se = settleError(t, err)
	assert.Equal(t, ErrDuplicateSettlement, se.ErrorReason)
	assert.Equal(t, 0, restartSigner.sendCalls)
}

func TestExactSvmScheme_LaterPayloadKeepsItsOwnReceipt(t *testing.T) {
	firstPayload, firstReq, firstFee := buildValidExactSvmFixture(t)
	laterPayload, laterReq, laterFee := buildValidExactSvmFixture(t)
	firstSig := solana.SignatureFromBytes(append([]byte{11}, make([]byte, 63)...))
	laterSig := solana.SignatureFromBytes(append([]byte{12}, make([]byte, 63)...))
	script := &statusScript{}
	script.set(statusResult("confirmed", true))
	server := httptest.NewServer(script.handler(t))
	defer server.Close()

	signer := &statusDoubleSigner{
		addresses: []solana.PublicKey{firstFee, laterFee},
		signature: firstSig,
		client:    rpc.New(server.URL),
	}
	scheme := NewExactSvmScheme(signer)

	_, err := scheme.Settle(context.Background(), firstPayload, firstReq, nil)
	se := settleError(t, err)
	assert.Equal(t, ErrTransactionFailed, se.ErrorReason)
	assert.Equal(t, firstSig.String(), se.Transaction)

	script.set(statusResult("finalized", false))
	signer.signature = laterSig
	resp, err := scheme.Settle(context.Background(), laterPayload, laterReq, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, laterSig.String(), resp.Transaction)
	assert.NotEqual(t, firstSig.String(), resp.Transaction)
	assert.Equal(t, 2, signer.sendCalls, "the later payload is one new broadcast, not a retry of the first")
}

func TestExactSvmScheme_PlainChainTextStaysPending(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	sig := solana.SignatureFromBytes(append([]byte{13}, make([]byte, 63)...))
	signer := &mockExactSvmSigner{
		addresses:     []solana.PublicKey{facilitatorAddr},
		sendSignature: sig,
		confirmErr:    errors.New("transaction failed on-chain: map[InstructionError:[2 map[Custom:4]]]"),
	}
	scheme := NewExactSvmScheme(signer)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	se := settleError(t, err)
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	assert.Equal(t, sig.String(), se.Transaction)
	assert.Equal(t, 1, signer.sendCalls)
}

// Compile-time check that the status double satisfies the facilitator signer.
var _ svm.FacilitatorSvmSigner = (*statusDoubleSigner)(nil)
