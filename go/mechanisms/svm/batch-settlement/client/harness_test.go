package client

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testNetwork = svm.SolanaDevnetCAIP2
	testMint    = svm.USDCDevnetAddress
)

func newKey(t *testing.T) *PrivateKeySigner {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return &PrivateKeySigner{privateKey: key}
}

func boolPtr(value bool) *bool { return &value }

type memoryStorage struct {
	mu      sync.Mutex
	records map[string]BatchClientChannelRecord
	gets    []string
	sets    []string
}

func newMemoryStorage() *memoryStorage {
	return &memoryStorage{records: map[string]BatchClientChannelRecord{}}
}

func (s *memoryStorage) Get(key string) (*BatchClientChannelRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gets = append(s.gets, key)
	record, ok := s.records[key]
	if !ok {
		return nil, nil
	}
	copied := record
	return &copied, nil
}

func (s *memoryStorage) Set(key string, record BatchClientChannelRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sets = append(s.sets, key)
	s.records[key] = record
	return nil
}

func (s *memoryStorage) Delete(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.records, key)
	return nil
}

func (s *memoryStorage) only() BatchClientChannelRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range s.records {
		return record
	}
	return BatchClientChannelRecord{}
}

func (s *memoryStorage) got(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, got := range s.gets {
		if got == key {
			return true
		}
	}
	return false
}

func (s *memoryStorage) setCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sets)
}

func (s *memoryStorage) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.records)
}

func (s *memoryStorage) resetCalls() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gets = nil
	s.sets = nil
}

type rpcStub struct {
	mu                 sync.Mutex
	owner              solana.PublicKey
	programAccountsErr bool
}

func newRPC(t *testing.T) (*rpcStub, string) {
	t.Helper()
	stub := &rpcStub{owner: solana.TokenProgramID}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		stub.mu.Lock()
		owner := stub.owner
		programErr := stub.programAccountsErr
		stub.mu.Unlock()

		var result any
		var rpcErr any
		switch request.Method {
		case "getAccountInfo":
			result = map[string]any{
				"context": map[string]any{"slot": 1},
				"value": map[string]any{
					"data":       []any{base64.StdEncoding.EncodeToString(mintData()), "base64"},
					"executable": false,
					"lamports":   1,
					"owner":      owner.String(),
					"rentEpoch":  0,
				},
			}
		case "getProgramAccounts":
			if programErr {
				rpcErr = map[string]any{"code": -32000, "message": "rpc"}
			} else {
				result = []any{}
			}
		case "getSlot":
			result = 123
		case "getLatestBlockhash":
			result = map[string]any{
				"context": map[string]any{"slot": 123},
				"value": map[string]any{
					"blockhash":            solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress).String(),
					"lastValidBlockHeight": 200,
				},
			}
		default:
			t.Errorf("unexpected RPC method %s", request.Method)
		}
		response := map[string]any{"jsonrpc": "2.0", "id": request.ID}
		if rpcErr != nil {
			response["error"] = rpcErr
		} else {
			response["result"] = result
		}
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(response))
	}))
	t.Cleanup(server.Close)
	return stub, server.URL
}

func mintData() []byte {
	mint := token.Mint{Decimals: 6, IsInitialized: true}
	buf := new(bytes.Buffer)
	_ = bin.NewBinEncoder(buf).Encode(mint)
	if buf.Len() == 0 {
		raw := make([]byte, 82)
		raw[44] = 6
		raw[45] = 1
		return raw
	}
	return buf.Bytes()
}

type harness struct {
	payer              *PrivateKeySigner
	feePayer           solana.PublicKey
	receiverAuthorizer solana.PublicKey
	rpc                *rpcStub
	rpcURL             string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	stub, url := newRPC(t)
	return &harness{
		payer:              newKey(t),
		feePayer:           newKey(t).Address(),
		receiverAuthorizer: newKey(t).Address(),
		rpc:                stub,
		rpcURL:             url,
	}
}

func (h *harness) requirements(amount string, extra map[string]any) types.PaymentRequirements {
	merged := map[string]any{
		batchsettlement.ExtraFeePayer:           h.feePayer.String(),
		batchsettlement.ExtraReceiverAuthorizer: h.receiverAuthorizer.String(),
		batchsettlement.ExtraTokenProgram:       solana.TokenProgramID.String(),
		batchsettlement.ExtraWithdrawDelay:      900,
		batchsettlement.ExtraRecentBlockhash:    solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress).String(),
		batchsettlement.ExtraRecentSlot:         "123",
	}
	for key, value := range extra {
		merged[key] = value
	}
	if amount == "" {
		amount = "1000"
	}
	return types.PaymentRequirements{
		Scheme:            batchsettlement.Scheme,
		Network:           testNetwork,
		Asset:             testMint,
		Amount:            amount,
		PayTo:             svm.USDCMainnetAddress,
		MaxTimeoutSeconds: 300,
		Extra:             merged,
	}
}

func (h *harness) scheme(t *testing.T, config *BatchSvmClientConfig) *BatchSvmScheme {
	t.Helper()
	if config == nil {
		config = &BatchSvmClientConfig{}
	}
	config.RPCURL = h.rpcURL
	if config.DiscoverChannels == nil {
		config.DiscoverChannels = boolPtr(false)
	}
	scheme, err := NewBatchSvmScheme(h.payer, config)
	require.NoError(t, err)
	return scheme
}

func nestedString(t *testing.T, body map[string]any, object, field string) string {
	t.Helper()
	record, ok := body[object].(map[string]any)
	require.True(t, ok, "missing %s", object)
	text, ok := record[field].(string)
	require.True(t, ok, "missing %s.%s", object, field)
	return text
}

func settleSuccess(extra map[string]any) *x402.SettleResponse {
	return &x402.SettleResponse{Success: true, Transaction: "sig", Network: testNetwork, Extra: extra}
}

func respond(t *testing.T, scheme *BatchSvmScheme, requirements types.PaymentRequirements, payment types.PaymentPayload, settle *x402.SettleResponse, required *types.PaymentRequired) x402.PaymentResponseResult {
	t.Helper()
	result, err := scheme.OnPaymentResponse(context.Background(), x402.PaymentResponseContext{
		PaymentPayload:  payment,
		Requirements:    requirements,
		SettleResponse:  settle,
		PaymentRequired: required,
	})
	require.NoError(t, err)
	return result
}
