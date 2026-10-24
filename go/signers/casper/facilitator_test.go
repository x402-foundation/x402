package casper_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/make-software/casper-go-sdk/v2/types"
	"github.com/make-software/casper-go-sdk/v2/types/key"
	"github.com/make-software/casper-go-sdk/v2/types/keypair"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/v2/mechanisms/casper"
	casperSigners "github.com/x402-foundation/x402/go/v2/signers/casper"
)

func TestFacilitatorSigner_NativeChainName(t *testing.T) {
	for _, test := range []struct{ network, chainName string }{
		{casper.CasperMainnetCAIP2, "casper"},
		{casper.CasperTestnetCAIP2, "casper-test"},
		{"casper:custom-chain", "custom-chain"},
	} {
		t.Run(test.network, func(t *testing.T) {
			signer := casperSigners.NewFacilitatorSigner(casperSigners.FacilitatorSignerConfig{
				RpcURLs: map[string]string{test.network: "http://localhost/rpc"},
			})
			config, err := signer.GetNetworkConfig(context.Background(), test.network)
			require.NoError(t, err)
			assert.Equal(t, test.chainName, config.ChainName)
			assert.Equal(t, "http://localhost/rpc", config.RPCURL)
		})
	}
}

const (
	waitTestNetwork   = casper.CasperTestnetCAIP2
	waitTestBlockHash = "1111111111111111111111111111111111111111111111111111111111111111"
	waitTestPackage   = "2222222222222222222222222222222222222222222222222222222222222222"
)

// rpcReply is one scripted info_get_transaction reply. Exactly one of result,
// rpcErr or httpStatus is set.
type rpcReply struct {
	result     json.RawMessage
	rpcErr     string
	httpStatus int
}

// transactionRPC is a fake Casper node answering info_get_transaction with a
// scripted sequence of replies; the last reply repeats once the script runs out.
type transactionRPC struct {
	t       *testing.T
	txHash  string
	mu      sync.Mutex
	replies []rpcReply
	calls   int
}

func newTransactionRPC(t *testing.T, txHash string, replies ...rpcReply) (*transactionRPC, string) {
	t.Helper()
	f := &transactionRPC{t: t, txHash: txHash, replies: replies}
	server := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(server.Close)
	return f, server.URL
}

func (f *transactionRPC) serve(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			TransactionHash struct {
				Version1 string `json:"Version1"`
			} `json:"transaction_hash"`
		} `json:"params"`
	}
	if !assert.NoError(f.t, json.NewDecoder(r.Body).Decode(&request)) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	assert.Equal(f.t, "info_get_transaction", request.Method)
	assert.Equal(f.t, f.txHash, request.Params.TransactionHash.Version1)

	f.mu.Lock()
	reply := f.replies[min(f.calls, len(f.replies)-1)]
	f.calls++
	f.mu.Unlock()

	if reply.httpStatus != 0 {
		w.WriteHeader(reply.httpStatus)
		return
	}
	response := map[string]interface{}{"jsonrpc": "2.0", "id": request.ID}
	if reply.rpcErr != "" {
		response["error"] = map[string]interface{}{"code": -32000, "message": reply.rpcErr}
	} else {
		response["result"] = reply.result
	}
	w.Header().Set("Content-Type", "application/json")
	assert.NoError(f.t, json.NewEncoder(w).Encode(response))
}

func (f *transactionRPC) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// newWaitTestTransaction builds a signed TransactionV1 shaped like the
// facilitator's transfer_with_authorization settlement.
func newWaitTestTransaction(t *testing.T) *types.TransactionV1 {
	t.Helper()
	privateKey, err := keypair.GeneratePrivateKey(keypair.ED25519)
	require.NoError(t, err)
	publicKey := privateKey.PublicKey()
	packageHash, err := key.NewHash(waitTestPackage)
	require.NoError(t, err)
	entryPoint := "transfer_with_authorization"

	payload, err := types.NewTransactionV1Payload(
		types.InitiatorAddr{PublicKey: &publicKey},
		types.Timestamp(time.Now().UTC()),
		900000000000,
		"casper-test",
		types.PricingMode{Limited: &types.LimitedMode{GasPriceTolerance: 1, StandardPayment: true, PaymentAmount: 2500000000}},
		types.NewNamedArgs(&types.Args{}),
		types.TransactionTarget{
			Stored: &types.StoredTarget{
				ID: types.TransactionInvocationTarget{
					ByPackageHash: &types.ByPackageHashInvocationTarget{Addr: packageHash},
				},
				Runtime: types.NewVmCasperV1TransactionRuntime(),
			},
		},
		types.TransactionEntryPoint{Custom: &entryPoint},
		types.TransactionScheduling{Standard: &struct{}{}},
	)
	require.NoError(t, err)
	transaction, err := types.MakeTransactionV1(payload)
	require.NoError(t, err)
	require.NoError(t, transaction.Sign(privateKey))
	return transaction
}

// transactionResult renders an info_get_transaction result. executionInfo is
// the raw execution_info value ("null" while the transaction is unprocessed).
func transactionResult(t *testing.T, transaction *types.TransactionV1, executionInfo string) rpcReply {
	t.Helper()
	encoded, err := json.Marshal(transaction)
	require.NoError(t, err)
	return rpcReply{result: json.RawMessage(fmt.Sprintf(
		`{"api_version":"2.0.0","transaction":{"Version1":%s},"execution_info":%s}`, encoded, executionInfo))}
}

func pendingReply(t *testing.T, transaction *types.TransactionV1) rpcReply {
	return transactionResult(t, transaction, "null")
}

// processingReply is a transaction assigned to a block whose execution result
// has not been recorded yet.
func processingReply(t *testing.T, transaction *types.TransactionV1) rpcReply {
	return transactionResult(t, transaction, fmt.Sprintf(
		`{"block_hash":"%s","block_height":4753861,"execution_result":null}`, waitTestBlockHash))
}

func executedReply(t *testing.T, transaction *types.TransactionV1, errorMessage *string) rpcReply {
	t.Helper()
	initiator := transaction.Payload.InitiatorAddr.PublicKey.ToHex()
	errorJSON, err := json.Marshal(errorMessage)
	require.NoError(t, err)
	return transactionResult(t, transaction, fmt.Sprintf(
		`{"block_hash":"%s","block_height":4753862,"execution_result":{"Version2":{`+
			`"initiator":{"PublicKey":"%s"},"error_message":%s,"limit":"2500000000","consumed":"1000000000",`+
			`"cost":"2500000000","refund":"0","payment":[],"transfers":[],"size_estimate":348,"effects":[]}}}`,
		waitTestBlockHash, initiator, errorJSON))
}

func newWaitTestSigner(rpcURL string, timeout time.Duration) *casperSigners.FacilitatorSigner {
	return casperSigners.NewFacilitatorSigner(casperSigners.FacilitatorSignerConfig{
		RpcURLs:                 map[string]string{waitTestNetwork: rpcURL},
		TransactionWaitTimeout:  timeout,
		TransactionPollInterval: 5 * time.Millisecond,
	})
}

func TestFacilitatorSigner_WaitForTransaction_PendingThenSuccess(t *testing.T) {
	transaction := newWaitTestTransaction(t)
	txHash := transaction.Hash.ToHex()
	fake, url := newTransactionRPC(t, txHash,
		pendingReply(t, transaction),
		processingReply(t, transaction),
		executedReply(t, transaction, nil),
	)

	err := newWaitTestSigner(url, 5*time.Second).WaitForTransaction(context.Background(), waitTestNetwork, txHash)
	require.NoError(t, err)
	assert.Equal(t, 3, fake.callCount(), "must keep polling until an execution result is recorded")
}

func TestFacilitatorSigner_WaitForTransaction_ExecutionFailure(t *testing.T) {
	transaction := newWaitTestTransaction(t)
	txHash := transaction.Hash.ToHex()
	message := "User error: 64658"
	fake, url := newTransactionRPC(t, txHash,
		pendingReply(t, transaction),
		executedReply(t, transaction, &message),
	)

	err := newWaitTestSigner(url, 5*time.Second).WaitForTransaction(context.Background(), waitTestNetwork, txHash)
	var execErr *casper.TransactionExecutionError
	require.ErrorAs(t, err, &execErr)
	assert.Equal(t, message, execErr.Message)
	assert.Equal(t, 2, fake.callCount())
}

func TestFacilitatorSigner_WaitForTransaction_TransientRPCErrors(t *testing.T) {
	transaction := newWaitTestTransaction(t)
	txHash := transaction.Hash.ToHex()
	fake, url := newTransactionRPC(t, txHash,
		rpcReply{httpStatus: http.StatusBadGateway},
		rpcReply{rpcErr: "No such transaction"},
		pendingReply(t, transaction),
		executedReply(t, transaction, nil),
	)

	err := newWaitTestSigner(url, 5*time.Second).WaitForTransaction(context.Background(), waitTestNetwork, txHash)
	require.NoError(t, err)
	assert.Equal(t, 4, fake.callCount())
}

func TestFacilitatorSigner_WaitForTransaction_Timeout(t *testing.T) {
	transaction := newWaitTestTransaction(t)
	txHash := transaction.Hash.ToHex()
	fake, url := newTransactionRPC(t, txHash, processingReply(t, transaction))

	start := time.Now()
	err := newWaitTestSigner(url, 50*time.Millisecond).WaitForTransaction(context.Background(), waitTestNetwork, txHash)
	require.Error(t, err)
	assert.Less(t, time.Since(start), 2*time.Second, "wait must be bounded by the configured timeout")
	assert.ErrorIs(t, err, context.DeadlineExceeded)
	var execErr *casper.TransactionExecutionError
	assert.False(t, errors.As(err, &execErr), "an unconfirmed transaction is pending, not failed")
	assert.Contains(t, err.Error(), txHash)
	assert.NotContains(t, err.Error(), "last RPC error")
	assert.Greater(t, fake.callCount(), 1)
}

func TestFacilitatorSigner_WaitForTransaction_TimeoutReportsLastRPCError(t *testing.T) {
	transaction := newWaitTestTransaction(t)
	txHash := transaction.Hash.ToHex()
	_, url := newTransactionRPC(t, txHash, rpcReply{rpcErr: "node is syncing"})

	err := newWaitTestSigner(url, 50*time.Millisecond).WaitForTransaction(context.Background(), waitTestNetwork, txHash)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
	var execErr *casper.TransactionExecutionError
	assert.False(t, errors.As(err, &execErr), "RPC failures must not be reported as execution failures")
	assert.Contains(t, err.Error(), "last RPC error")
	assert.Contains(t, err.Error(), "node is syncing")
}

func TestFacilitatorSigner_WaitForTransaction_ContextCancelled(t *testing.T) {
	transaction := newWaitTestTransaction(t)
	txHash := transaction.Hash.ToHex()
	fake, url := newTransactionRPC(t, txHash, pendingReply(t, transaction))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- newWaitTestSigner(url, time.Minute).WaitForTransaction(ctx, waitTestNetwork, txHash)
	}()
	require.Eventually(t, func() bool { return fake.callCount() >= 2 }, 2*time.Second, time.Millisecond)
	cancel()

	select {
	case err := <-done:
		require.Error(t, err)
		assert.ErrorIs(t, err, context.Canceled)
		var execErr *casper.TransactionExecutionError
		assert.False(t, errors.As(err, &execErr))
	case <-time.After(2 * time.Second):
		t.Fatal("WaitForTransaction did not return after context cancellation")
	}
}
