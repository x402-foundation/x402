package facilitator

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

type ed25519Signer struct {
	key solana.PrivateKey
}

func (s ed25519Signer) Address() solana.PublicKey { return s.key.PublicKey() }

func (s ed25519Signer) SignMessage(_ context.Context, message []byte) ([]byte, error) {
	signature, err := s.key.Sign(message)
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(signature))
	copy(out, signature[:])
	return out, nil
}

// activityRecordingStorage wraps channel storage for tests that observe activity writes.
type activityRecordingStorage struct {
	inner           *paymentchannels.InMemoryPaymentChannelStorage
	activityErr     error
	activityCalls   atomic.Int32
	activityRecords []paymentchannels.PaymentChannelRecord
}

func newActivityRecordingStorage() *activityRecordingStorage {
	return &activityRecordingStorage{inner: paymentchannels.NewInMemoryPaymentChannelStorage()}
}

func (s *activityRecordingStorage) RecordOpen(ctx context.Context, record paymentchannels.PaymentChannelRecord) (paymentchannels.PaymentChannelOpenWrite, error) {
	return s.inner.RecordOpen(ctx, record)
}

func (s *activityRecordingStorage) RevertOpen(ctx context.Context, write paymentchannels.PaymentChannelOpenWrite) error {
	return s.inner.RevertOpen(ctx, write)
}

func (s *activityRecordingStorage) RecordActivity(ctx context.Context, records ...paymentchannels.PaymentChannelRecord) error {
	if s.activityErr != nil {
		return s.activityErr
	}
	s.activityCalls.Add(1)
	s.activityRecords = append(s.activityRecords, records...)
	return s.inner.RecordActivity(ctx, records...)
}

func (s *activityRecordingStorage) Get(ctx context.Context, network, channelID string) (*paymentchannels.PaymentChannelRecord, error) {
	return s.inner.Get(ctx, network, channelID)
}

func (s *activityRecordingStorage) List(ctx context.Context, network string) ([]paymentchannels.PaymentChannelRecord, error) {
	return s.inner.List(ctx, network)
}

func (s *activityRecordingStorage) Delete(ctx context.Context, network, channelID string) error {
	return s.inner.Delete(ctx, network, channelID)
}

func mustKey(t *testing.T) solana.PrivateKey {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return key
}

func asMap(t *testing.T, value any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	var out map[string]any
	require.NoError(t, json.Unmarshal(raw, &out))
	return out
}

type accountCall struct {
	account solana.PublicKey
	opts    *rpc.GetAccountInfoOpts
}

// scriptedSigner is a facilitator signer whose chain calls are scripted in memory.
type scriptedSigner struct {
	mu sync.Mutex

	keys       []solana.PrivateKey
	sent       []*solana.Transaction
	accounts   []accountCall
	confirmErr error
	sendErr    error
	blockhash  solana.Hash

	// holdSend, when set, runs inside SendTransaction before it returns.
	holdSend func()
}

func newScriptedSigner(t *testing.T, count int) *scriptedSigner {
	t.Helper()
	signer := &scriptedSigner{blockhash: solana.MustHashFromBase58("11111111111111111111111111111111")}
	for i := 0; i < count; i++ {
		signer.keys = append(signer.keys, mustKey(t))
	}
	return signer
}

func (s *scriptedSigner) feePayer() solana.PublicKey { return s.keys[0].PublicKey() }

func (s *scriptedSigner) GetAddresses(_ context.Context, _ string) []solana.PublicKey {
	out := make([]solana.PublicKey, len(s.keys))
	for i, key := range s.keys {
		out[i] = key.PublicKey()
	}
	return out
}

func (s *scriptedSigner) SignTransaction(_ context.Context, tx *solana.Transaction, feePayer solana.PublicKey, _ string) error {
	for i := range s.keys {
		if !s.keys[i].PublicKey().Equals(feePayer) {
			continue
		}
		_, err := tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
			if key.Equals(feePayer) {
				return &s.keys[i]
			}
			return nil
		})
		return err
	}
	return errors.New("no signer for fee payer " + feePayer.String())
}

func (s *scriptedSigner) SimulateTransaction(context.Context, *solana.Transaction, string, *svm.FacilitatorSimulateTransactionOptions) error {
	return nil
}

func (s *scriptedSigner) SendTransaction(_ context.Context, tx *solana.Transaction, _ string) (solana.Signature, error) {
	if s.holdSend != nil {
		s.holdSend()
	}
	if s.sendErr != nil {
		return solana.Signature{}, s.sendErr
	}
	s.mu.Lock()
	s.sent = append(s.sent, tx)
	s.mu.Unlock()
	if len(tx.Signatures) == 0 {
		return solana.Signature{}, errors.New("transaction has no signature")
	}
	return tx.Signatures[0], nil
}

func (s *scriptedSigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	return s.confirmErr
}

func (s *scriptedSigner) GetAccountInfo(
	_ context.Context,
	account solana.PublicKey,
	_ string,
	opts *rpc.GetAccountInfoOpts,
) (*rpc.GetAccountInfoResult, error) {
	s.mu.Lock()
	s.accounts = append(s.accounts, accountCall{account: account, opts: opts})
	s.mu.Unlock()
	return &rpc.GetAccountInfoResult{}, nil
}

func (s *scriptedSigner) accountCalls() []accountCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]accountCall(nil), s.accounts...)
}

func (s *scriptedSigner) sentTransactions() []*solana.Transaction {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*solana.Transaction(nil), s.sent...)
}

func (s *scriptedSigner) GetLatestBlockhash(context.Context, string) (solana.Hash, uint64, error) {
	return s.blockhash, 1, nil
}

func (s *scriptedSigner) GetSlot(context.Context, string, rpc.CommitmentType) (uint64, error) {
	return 1, nil
}

type confirmCall struct {
	signature solana.Signature
	opts      *svm.FacilitatorConfirmOptions
}

// confirmingSigner records confirmation options and reports a slot.
type confirmingSigner struct {
	*scriptedSigner
	mu    sync.Mutex
	calls []confirmCall
	slot  uint64
}

func (s *confirmingSigner) ConfirmTransactionWithOptions(
	_ context.Context,
	signature solana.Signature,
	_ string,
	opts *svm.FacilitatorConfirmOptions,
) (*svm.FacilitatorConfirmationStatus, error) {
	s.mu.Lock()
	s.calls = append(s.calls, confirmCall{signature: signature, opts: opts})
	s.mu.Unlock()
	return &svm.FacilitatorConfirmationStatus{Slot: s.slot}, nil
}

func (s *confirmingSigner) confirmCalls() []confirmCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]confirmCall(nil), s.calls...)
}

// capabilitySigner adds blockhash and confirmed-transaction reads.
type capabilitySigner struct {
	*scriptedSigner
	blockhashValid func(context.Context, solana.Hash, string) (bool, error)
	blockhashCalls []solana.Hash
	confirmed      func(context.Context, solana.Signature, string) (*svm.FacilitatorConfirmedTransaction, error)
	confirmedCalls int
	mu             sync.Mutex
}

func (s *capabilitySigner) IsBlockhashValid(ctx context.Context, blockhash solana.Hash, network string) (bool, error) {
	s.mu.Lock()
	s.blockhashCalls = append(s.blockhashCalls, blockhash)
	s.mu.Unlock()
	if s.blockhashValid == nil {
		return false, nil
	}
	return s.blockhashValid(ctx, blockhash, network)
}

func (s *capabilitySigner) GetConfirmedTransaction(ctx context.Context, signature solana.Signature, network string) (*svm.FacilitatorConfirmedTransaction, error) {
	s.mu.Lock()
	s.confirmedCalls++
	s.mu.Unlock()
	if s.confirmed == nil {
		return nil, nil
	}
	return s.confirmed(ctx, signature, network)
}

type channelAccount struct {
	Status           generated.ChannelStatus
	Salt             uint64
	Deposit          uint64
	Settled          uint64
	Payout           uint64
	ClosureStartedAt int64
	GracePeriod      uint32
	Payer            solana.PublicKey
	Payee            solana.PublicKey
	AuthorizedSigner solana.PublicKey
	Mint             solana.PublicKey
	RentPayer        solana.PublicKey
	OpenSlot         uint64
	Splits           []paymentchannels.Split
}

func (c channelAccount) encode(t *testing.T) []byte {
	t.Helper()
	data := make([]byte, paymentchannels.ChannelAccountSize)
	data[0] = uint8(generated.AccountDiscriminator_Channel)
	data[3] = byte(c.Status)
	binary.LittleEndian.PutUint64(data[4:12], c.Salt)
	binary.LittleEndian.PutUint64(data[12:20], c.Deposit)
	binary.LittleEndian.PutUint64(data[20:28], c.Settled)
	binary.LittleEndian.PutUint64(data[28:36], c.Payout)
	binary.LittleEndian.PutUint64(data[36:44], uint64(c.ClosureStartedAt))
	binary.LittleEndian.PutUint32(data[52:56], c.GracePeriod)
	hash, err := paymentchannels.GetChannelDistributionHash(c.Splits)
	require.NoError(t, err)
	copy(data[56:88], hash[:])
	copy(data[88:120], c.Payer.Bytes())
	copy(data[120:152], c.Payee.Bytes())
	copy(data[152:184], c.AuthorizedSigner.Bytes())
	copy(data[184:216], c.Mint.Bytes())
	copy(data[216:248], c.RentPayer.Bytes())
	binary.LittleEndian.PutUint64(data[248:256], c.OpenSlot)
	return data
}

// stubRPC is an in-process JSON-RPC endpoint backed by a mutable account map.
type stubRPC struct {
	mu sync.Mutex

	url                  string
	accounts             map[string][]byte
	reads                map[string]int
	slot                 uint64
	methods              []string
	failProgramAccounts  int
	programAccountErrors int
}

func newStubRPC(t *testing.T) *stubRPC {
	t.Helper()
	stub := &stubRPC{
		accounts: map[string][]byte{},
		reads:    map[string]int{},
		slot:     100 + paymentchannels.OpenSlotWindow + 1,
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
			Params []any  `json:"params"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))
		if response, ok := stub.rpcError(request.Method); ok {
			w.Header().Set("Content-Type", "application/json")
			require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"error":   response,
			}))
			return
		}
		result, err := stub.handle(request.Method, request.Params)
		require.NoError(t, err)
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  result,
		}))
	}))
	t.Cleanup(server.Close)
	stub.url = server.URL
	return stub
}

func (s *stubRPC) rpcError(method string) (map[string]any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.methods = append(s.methods, method)
	if method == "getProgramAccounts" && s.failProgramAccounts > 0 {
		s.failProgramAccounts--
		s.programAccountErrors++
		return map[string]any{"code": -32000, "message": "getProgramAccounts failed"}, true
	}
	return nil, false
}

func (s *stubRPC) handle(method string, params []any) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch method {
	case "getSlot":
		return s.slot, nil
	case "getLatestBlockhash":
		return map[string]any{
			"context": map[string]any{"slot": s.slot},
			"value": map[string]any{
				"blockhash":            solana.Hash(solana.SysVarRentPubkey).String(),
				"lastValidBlockHeight": s.slot + 150,
			},
		}, nil
	case "getAccountInfo":
		address, _ := params[0].(string)
		data, ok := s.accounts[address]
		if ok {
			if remaining, scheduled := s.reads[address]; scheduled {
				if remaining <= 0 {
					delete(s.accounts, address)
					delete(s.reads, address)
					ok = false
				} else {
					s.reads[address] = remaining - 1
				}
			}
		}
		if !ok {
			return map[string]any{"context": map[string]any{"slot": s.slot}, "value": nil}, nil
		}
		return map[string]any{
			"context": map[string]any{"slot": s.slot},
			"value": map[string]any{
				"data":       []any{base64.StdEncoding.EncodeToString(data), "base64"},
				"executable": false,
				"lamports":   2_000_000,
				"owner":      paymentchannels.ProgramID.String(),
				"rentEpoch":  0,
				"space":      len(data),
			},
		}, nil
	case "getProgramAccounts":
		var opts rpc.GetProgramAccountsOpts
		if len(params) > 1 {
			raw, err := json.Marshal(params[1])
			if err == nil {
				_ = json.Unmarshal(raw, &opts)
			}
		}
		results := make([]map[string]any, 0)
		for address, data := range s.accounts {
			if !accountMatches(data, opts.Filters) {
				continue
			}
			results = append(results, map[string]any{
				"pubkey": address,
				"account": map[string]any{
					"data":       []any{base64.StdEncoding.EncodeToString(data), "base64"},
					"executable": false,
					"lamports":   2_000_000,
					"owner":      paymentchannels.ProgramID.String(),
					"rentEpoch":  0,
					"space":      len(data),
				},
			})
		}
		return results, nil
	case "simulateTransaction":
		return map[string]any{
			"context": map[string]any{"slot": s.slot},
			"value":   map[string]any{"err": nil, "logs": []string{}, "unitsConsumed": 1000},
		}, nil
	case "sendTransaction":
		return solana.Signature{}.String(), nil
	default:
		return nil, errors.New("unexpected RPC method " + method)
	}
}

func accountMatches(data []byte, filters []rpc.RPCFilter) bool {
	for _, filter := range filters {
		if filter.DataSize != 0 && uint64(len(data)) != filter.DataSize {
			return false
		}
		if filter.Memcmp == nil {
			continue
		}
		want := []byte(filter.Memcmp.Bytes)
		offset := filter.Memcmp.Offset
		if offset+uint64(len(want)) > uint64(len(data)) || string(data[offset:offset+uint64(len(want))]) != string(want) {
			return false
		}
	}
	return true
}

func (s *stubRPC) setAccount(address string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts[address] = append([]byte(nil), data...)
}

func (s *stubRPC) deleteAccount(address string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.accounts, address)
}

func (s *stubRPC) deleteAccountAfter(address string, reads int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads[address] = reads
}

func (s *stubRPC) methodCount(method string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, seen := range s.methods {
		if seen == method {
			count++
		}
	}
	return count
}

// rpcSigner forwards account and slot reads to stubRPC and signs with its keys.
type rpcSigner struct {
	*scriptedSigner
	stub *stubRPC
	rpc  *rpc.Client
}

func newRPCSigner(t *testing.T, count int) (*rpcSigner, *stubRPC) {
	t.Helper()
	stub := newStubRPC(t)
	signer := &rpcSigner{scriptedSigner: newScriptedSigner(t, count), stub: stub, rpc: rpc.New(stub.url)}
	return signer, stub
}

func (s *rpcSigner) GetAccountInfo(ctx context.Context, account solana.PublicKey, network string, opts *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
	s.scriptedSigner.GetAccountInfo(ctx, account, network, opts)
	return s.rpc.GetAccountInfoWithOpts(ctx, account, opts)
}

func (s *rpcSigner) GetLatestBlockhash(ctx context.Context, _ string) (solana.Hash, uint64, error) {
	latest, err := s.rpc.GetLatestBlockhash(ctx, rpc.CommitmentConfirmed)
	if err != nil {
		return solana.Hash{}, 0, err
	}
	return latest.Value.Blockhash, latest.Value.LastValidBlockHeight, nil
}

func (s *rpcSigner) GetSlot(ctx context.Context, _ string, commitment rpc.CommitmentType) (uint64, error) {
	return s.rpc.GetSlot(ctx, commitment)
}

func (s *rpcSigner) GetProgramAccounts(ctx context.Context, _ string, program solana.PublicKey, opts *rpc.GetProgramAccountsOpts) (rpc.GetProgramAccountsResult, error) {
	return s.rpc.GetProgramAccountsWithOpts(ctx, program, opts)
}

func (s *rpcSigner) SimulateTransaction(ctx context.Context, tx *solana.Transaction, _ string, opts *svm.FacilitatorSimulateTransactionOptions) error {
	result, err := s.rpc.SimulateTransactionWithOpts(ctx, tx, svm.SimulationRPCOpts(opts))
	if err != nil {
		return err
	}
	if result != nil && result.Value != nil && result.Value.Err != nil {
		return errors.New("simulation failed")
	}
	return nil
}
