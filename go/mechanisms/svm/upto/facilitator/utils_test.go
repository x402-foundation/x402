package facilitator

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	testNetwork = "solana-devnet"
	testSlot    = uint64(341_000_000)
)

// mockSigner is a facilitator signer over ephemeral keys that records every
// transaction it is asked to broadcast.
type mockSigner struct {
	mu sync.Mutex

	keys []solana.PrivateKey
	sent []*solana.Transaction
	rpc  *rpc.Client

	// sendErr, when set, fails every broadcast.
	sendErr error
	// failNextSends fails that many broadcasts before letting the rest through.
	failNextSends int
	// confirmErr, when set, fails every confirmation.
	confirmErr error
	// onSend runs on every successful broadcast, so tests can publish the
	// account state a landed transaction would have produced.
	onSend func(tx *solana.Transaction)
}

func newMockSigner(t *testing.T, count int) *mockSigner {
	t.Helper()
	signer := &mockSigner{}
	for i := 0; i < count; i++ {
		key, err := solana.NewRandomPrivateKey()
		require.NoError(t, err)
		signer.keys = append(signer.keys, key)
	}
	return signer
}

func (s *mockSigner) GetAddresses(_ context.Context, _ string) []solana.PublicKey {
	addresses := make([]solana.PublicKey, len(s.keys))
	for i, key := range s.keys {
		addresses[i] = key.PublicKey()
	}
	return addresses
}

func (s *mockSigner) SignTransaction(
	_ context.Context, tx *solana.Transaction, feePayer solana.PublicKey, _ string,
) error {
	for _, key := range s.keys {
		if !key.PublicKey().Equals(feePayer) {
			continue
		}
		message, err := tx.Message.MarshalBinary()
		if err != nil {
			return err
		}
		signature, err := key.Sign(message)
		if err != nil {
			return err
		}
		index, err := tx.GetAccountIndex(feePayer)
		if err != nil {
			return err
		}
		if len(tx.Signatures) <= int(index) {
			signatures := make([]solana.Signature, index+1)
			copy(signatures, tx.Signatures)
			tx.Signatures = signatures
		}
		tx.Signatures[index] = signature
		return nil
	}
	return errors.New("no signer for fee payer " + feePayer.String())
}

func (s *mockSigner) SimulateTransaction(_ context.Context, _ *solana.Transaction, _ string) error {
	return nil
}

func (s *mockSigner) SendTransaction(
	_ context.Context, tx *solana.Transaction, _ string,
) (solana.Signature, error) {
	if s.sendErr != nil {
		return solana.Signature{}, s.sendErr
	}
	s.mu.Lock()
	if s.failNextSends > 0 {
		s.failNextSends--
		s.mu.Unlock()
		return solana.Signature{}, errors.New("blockhash not found")
	}
	s.sent = append(s.sent, tx)
	onSend := s.onSend
	s.mu.Unlock()

	if onSend != nil {
		onSend(tx)
	}
	return tx.Signatures[0], nil
}

func (s *mockSigner) ConfirmTransaction(_ context.Context, _ solana.Signature, _ string) error {
	return s.confirmErr
}

func (s *mockSigner) attachRPC(client *rpc.Client) {
	s.rpc = client
}

func (s *mockSigner) GetAccountInfo(
	ctx context.Context,
	account solana.PublicKey,
	_ string,
	opts *rpc.GetAccountInfoOpts,
) (*rpc.GetAccountInfoResult, error) {
	if s.rpc == nil {
		return nil, errors.New("mock signer has no RPC client")
	}
	return s.rpc.GetAccountInfoWithOpts(ctx, account, opts)
}

func (s *mockSigner) GetLatestBlockhash(ctx context.Context, _ string) (solana.Hash, uint64, error) {
	if s.rpc == nil {
		return solana.Hash{}, 0, errors.New("mock signer has no RPC client")
	}
	latest, err := s.rpc.GetLatestBlockhash(ctx, upto.BlockhashCommitment)
	if err != nil {
		return solana.Hash{}, 0, err
	}
	return latest.Value.Blockhash, latest.Value.LastValidBlockHeight, nil
}

func (s *mockSigner) GetSlot(ctx context.Context, _ string, commitment rpc.CommitmentType) (uint64, error) {
	if s.rpc == nil {
		return 0, errors.New("mock signer has no RPC client")
	}
	return s.rpc.GetSlot(ctx, commitment)
}

func (s *mockSigner) SimulateTransactionWithOpts(
	ctx context.Context,
	tx *solana.Transaction,
	_ string,
	opts *rpc.SimulateTransactionOpts,
) error {
	if s.rpc == nil {
		return errors.New("mock signer has no RPC client")
	}
	result, err := s.rpc.SimulateTransactionWithOpts(ctx, tx, opts)
	if err != nil {
		return fmt.Errorf("settlement simulation failed: %w", err)
	}
	if result != nil && result.Value != nil && result.Value.Err != nil {
		return fmt.Errorf("settlement simulation failed: %v", result.Value.Err)
	}
	return nil
}

func (s *mockSigner) GetProgramAccounts(
	ctx context.Context,
	_ string,
	programID solana.PublicKey,
	opts *rpc.GetProgramAccountsOpts,
) (rpc.GetProgramAccountsResult, error) {
	if s.rpc == nil {
		return nil, errors.New("mock signer has no RPC client")
	}
	return s.rpc.GetProgramAccountsWithOpts(ctx, programID, opts)
}

func (s *mockSigner) sentTransactions() []*solana.Transaction {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*solana.Transaction(nil), s.sent...)
}

func (s *mockSigner) feePayer() solana.PublicKey {
	return s.keys[0].PublicKey()
}

// stubRPC is an in-process JSON-RPC endpoint backed by a mutable account map.
type stubRPC struct {
	mu sync.Mutex

	url      string
	accounts map[string][]byte
	// missingReads counts down transient missing-account responses before the
	// stored account becomes visible.
	missingReads map[string]int
	// reads counts down the remaining lookups before an account disappears,
	// so a test can model a channel closing mid-pass.
	reads map[string]int
	slot  uint64
	// simulationErr, when set, is returned as the simulation result error.
	simulationErr interface{}
	// simulateCalls counts simulateTransaction requests.
	simulateCalls int
	// lastSimulatedTx is the most recently simulated transaction, decoded so
	// tests can assert on its instruction shape (e.g. ComputeBudget
	// deduplication) rather than only on success or failure.
	lastSimulatedTx *solana.Transaction
	// commitments records the commitment sent with each RPC method.
	commitments map[string][]string
	// simulateEntered is closed the first time a simulation starts, and
	// simulateGate holds that simulation open until the test releases it.
	simulateEntered chan struct{}
	simulateGate    chan struct{}
}

func newStubRPC(t *testing.T) *stubRPC {
	t.Helper()
	stub := &stubRPC{
		accounts:     map[string][]byte{},
		missingReads: map[string]int{},
		reads:        map[string]int{},
		slot:         testSlot,
		commitments:  map[string][]string{},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     interface{}   `json:"id"`
			Method string        `json:"method"`
			Params []interface{} `json:"params"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&request))

		result, err := stub.handle(request.Method, request.Params)
		if err != nil {
			t.Errorf("stub rpc: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      request.ID,
			"result":  result,
		}))
	}))
	t.Cleanup(server.Close)

	stub.url = server.URL
	return stub
}

// commitmentOf reads the commitment from the options object in an RPC parameter
// list, wherever it sits: getSlot carries it first, getAccountInfo second.
func commitmentOf(params []interface{}) string {
	for _, param := range params {
		options, ok := param.(map[string]interface{})
		if !ok {
			continue
		}
		if commitment, ok := options["commitment"].(string); ok {
			return commitment
		}
	}
	return ""
}

func (s *stubRPC) handle(method string, params []interface{}) (interface{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.commitments[method] = append(s.commitments[method], commitmentOf(params))

	switch method {
	case "getSlot":
		return s.slot, nil

	case "getLatestBlockhash":
		return map[string]interface{}{
			"context": map[string]interface{}{"slot": s.slot},
			"value": map[string]interface{}{
				"blockhash":            solana.Hash(solana.SysVarRentPubkey).String(),
				"lastValidBlockHeight": s.slot + 150,
			},
		}, nil

	case "getAccountInfo":
		address, _ := params[0].(string)
		data, ok := s.accounts[address]
		if remaining := s.missingReads[address]; ok && remaining > 0 {
			s.missingReads[address] = remaining - 1
			ok = false
		}
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
			return map[string]interface{}{
				"context": map[string]interface{}{"slot": s.slot},
				"value":   nil,
			}, nil
		}
		return map[string]interface{}{
			"context": map[string]interface{}{"slot": s.slot},
			"value": map[string]interface{}{
				"data":       []interface{}{base64.StdEncoding.EncodeToString(data), "base64"},
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
			if raw, err := json.Marshal(params[1]); err == nil {
				_ = json.Unmarshal(raw, &opts)
			}
		}
		results := make([]map[string]interface{}, 0)
		for address, data := range s.accounts {
			if !matchesGetProgramAccountsFilters(data, opts.Filters) {
				continue
			}
			results = append(results, map[string]interface{}{
				"pubkey": address,
				"account": map[string]interface{}{
					"data":       []interface{}{base64.StdEncoding.EncodeToString(data), "base64"},
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
		s.simulateCalls++
		if raw, ok := params[0].(string); ok {
			if txData, err := base64.StdEncoding.DecodeString(raw); err == nil {
				if tx, err := solana.TransactionFromBytes(txData); err == nil {
					s.lastSimulatedTx = tx
				}
			}
		}
		if s.simulateGate != nil {
			gate, entered := s.simulateGate, s.simulateEntered
			s.simulateGate, s.simulateEntered = nil, nil
			// Released outside the lock so the blocked simulation does not
			// stall the concurrent request the test is driving.
			s.mu.Unlock()
			close(entered)
			<-gate
			s.mu.Lock()
		}
		return map[string]interface{}{
			"context": map[string]interface{}{"slot": s.slot},
			"value": map[string]interface{}{
				"err":           s.simulationErr,
				"logs":          []string{},
				"unitsConsumed": 1000,
			},
		}, nil

	default:
		return nil, errors.New("unexpected RPC method " + method)
	}
}

// matchesGetProgramAccountsFilters replicates the RPC provider's server-side
// filtering so the stub only returns accounts a real getProgramAccounts call
// with these filters would return.
func matchesGetProgramAccountsFilters(data []byte, filters []rpc.RPCFilter) bool {
	for _, filter := range filters {
		if filter.DataSize != 0 && uint64(len(data)) != filter.DataSize {
			return false
		}
		if filter.Memcmp != nil {
			want := []byte(filter.Memcmp.Bytes)
			offset := filter.Memcmp.Offset
			if offset+uint64(len(want)) > uint64(len(data)) {
				return false
			}
			if !bytes.Equal(data[offset:offset+uint64(len(want))], want) {
				return false
			}
		}
	}
	return true
}

func (s *stubRPC) setAccount(address string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts[address] = data
}

func (s *stubRPC) hideAccountForReads(address string, reads int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.missingReads[address] = reads
}

func (s *stubRPC) deleteAccount(address string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.accounts, address)
}

// deleteAccountAfter removes an account once it has been read `reads` times.
func (s *stubRPC) deleteAccountAfter(address string, reads int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads[address] = reads
}

// blockFirstSimulation holds the next simulation open until the returned
// release function is called, and reports when that simulation was entered.
func (s *stubRPC) blockFirstSimulation() (entered <-chan struct{}, release func()) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.simulateEntered = make(chan struct{})
	s.simulateGate = make(chan struct{})
	gate := s.simulateGate
	return s.simulateEntered, func() { close(gate) }
}

// failSimulation makes every subsequent simulation report a program error.
func (s *stubRPC) failSimulation(reason interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.simulationErr = reason
}

func (s *stubRPC) simulations() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.simulateCalls
}

// lastSimulatedTransaction returns the most recently simulated transaction.
func (s *stubRPC) lastSimulatedTransaction() *solana.Transaction {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSimulatedTx
}

// commitmentsFor returns the commitments sent with every call to an RPC method.
func (s *stubRPC) commitmentsFor(method string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commitments[method]...)
}

// channelAccount is the shape of an onchain channel used to build test accounts.
type channelAccount struct {
	Status           paymentchannels.ChannelStatus
	Salt             uint64
	Deposit          uint64
	Settled          uint64
	GracePeriod      uint32
	Payer            solana.PublicKey
	Payee            solana.PublicKey
	AuthorizedSigner solana.PublicKey
	Mint             solana.PublicKey
	RentPayer        solana.PublicKey
	OpenSlot         uint64
	Splits           []paymentchannels.Split
}

// encode serializes the account in the onchain 256-byte layout.
func (c channelAccount) encode(t *testing.T) []byte {
	t.Helper()

	data := make([]byte, paymentchannels.ChannelAccountSize)
	data[0] = paymentchannels.ChannelAccountDiscriminator
	data[3] = byte(c.Status)
	binary.LittleEndian.PutUint64(data[4:12], c.Salt)
	binary.LittleEndian.PutUint64(data[12:20], c.Deposit)
	binary.LittleEndian.PutUint64(data[20:28], c.Settled)
	binary.LittleEndian.PutUint32(data[52:56], c.GracePeriod)

	hash, err := paymentchannels.DistributionHash(c.Splits)
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

// paymentFixture is a matched challenge, payload, and open transaction that
// pass the facilitator's static acceptance policy.
type paymentFixture struct {
	payerKey     solana.PrivateKey
	authorizer   solana.PrivateKey
	feePayer     solana.PublicKey
	mint         solana.PublicKey
	payTo        solana.PublicKey
	channelID    solana.PublicKey
	salt         uint64
	deposit      uint64
	graceSeconds uint32
	expiresAt    int64

	requirements types.PaymentRequirements
	payload      types.PaymentPayload
}

func newPaymentFixture(t *testing.T, signer *mockSigner) *paymentFixture {
	t.Helper()
	authorizer, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return newPaymentFixtureWithAuthorizer(t, signer, authorizer)
}

func newPaymentFixtureWithAuthorizer(t *testing.T, signer *mockSigner, authorizer solana.PrivateKey) *paymentFixture {
	t.Helper()

	payerKey, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	payTo, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)

	fixture := &paymentFixture{
		payerKey:     payerKey,
		authorizer:   authorizer,
		feePayer:     signer.feePayer(),
		mint:         solana.MustPublicKeyFromBase58(svm.USDCDevnetAddress),
		payTo:        payTo.PublicKey(),
		salt:         42,
		deposit:      10_000,
		graceSeconds: 3600,
		expiresAt:    time.Now().Unix() + 600,
	}

	open, err := paymentchannels.BuildOpenTransaction(paymentchannels.BuildOpenArgs{
		Payer:            payerKey.PublicKey(),
		Payee:            fixture.feePayer,
		Mint:             fixture.mint,
		AuthorizedSigner: authorizer.PublicKey(),
		FeePayer:         fixture.feePayer,
		TokenProgram:     solana.TokenProgramID,
		Deposit:          fixture.deposit,
		Blockhash:        solana.Hash(solana.SysVarRentPubkey),
		OpenSlot:         testSlot,
		GracePeriod:      fixture.graceSeconds,
		Recipients:       fixture.splits(),
		Salt:             &fixture.salt,
	})
	require.NoError(t, err)

	message, err := open.Transaction.Message.MarshalBinary()
	require.NoError(t, err)
	signature, err := payerKey.Sign(message)
	require.NoError(t, err)
	index, err := open.Transaction.GetAccountIndex(payerKey.PublicKey())
	require.NoError(t, err)
	open.Transaction.Signatures = make([]solana.Signature, open.Transaction.Message.Header.NumRequiredSignatures)
	open.Transaction.Signatures[index] = signature

	encoded, err := svm.EncodeTransaction(open.Transaction)
	require.NoError(t, err)

	fixture.channelID = open.ChannelID
	fixture.requirements = types.PaymentRequirements{
		Scheme:            svm.SchemeUpto,
		Network:           testNetwork,
		Amount:            strconv.FormatUint(fixture.deposit, 10),
		Asset:             fixture.mint.String(),
		PayTo:             fixture.payTo.String(),
		MaxTimeoutSeconds: 600,
		Extra: map[string]interface{}{
			upto.ExtraFeePayer:           fixture.feePayer.String(),
			upto.ExtraReceiverAuthorizer: authorizer.PublicKey().String(),
			upto.ExtraWithdrawDelay:      float64(fixture.graceSeconds),
			upto.ExtraTokenProgram:       solana.TokenProgramID.String(),
			upto.ExtraRecentSlot:         strconv.FormatUint(testSlot, 10),
		},
	}
	fixture.payload = types.PaymentPayload{
		X402Version: 2,
		Accepted:    types.PaymentRequirements{Scheme: svm.SchemeUpto, Network: testNetwork},
		Payload: (&svm.UptoSvmPayload{
			From:             payerKey.PublicKey().String(),
			MaxAmount:        strconv.FormatUint(fixture.deposit, 10),
			ExpiresAt:        fixture.expiresAt,
			ValidAfter:       time.Now().Unix() - 1,
			Nonce:            strconv.FormatUint(fixture.salt, 10),
			OpenSlot:         strconv.FormatUint(testSlot, 10),
			ChannelId:        open.ChannelID.String(),
			Deposit:          strconv.FormatUint(fixture.deposit, 10),
			AuthorizedSigner: authorizer.PublicKey().String(),
			OpenTransaction:  encoded,
		}).ToMap(),
	}
	return fixture
}

func (f *paymentFixture) splits() []paymentchannels.Split {
	return []paymentchannels.Split{{Recipient: f.payTo.String(), BPS: paymentchannels.BasisPointsDenominator}}
}

// withPayload returns a copy of the payload with the given fields overridden.
func (f *paymentFixture) withPayload(overrides map[string]interface{}) types.PaymentPayload {
	payload := f.payload
	fields := make(map[string]interface{}, len(payload.Payload)+len(overrides))
	for key, value := range payload.Payload {
		fields[key] = value
	}
	for key, value := range overrides {
		fields[key] = value
	}
	payload.Payload = fields
	return payload
}

// withRequirements returns a copy of the requirements with extra overrides applied.
func (f *paymentFixture) withRequirements(mutate func(requirements *types.PaymentRequirements)) types.PaymentRequirements {
	requirements := f.requirements
	extra := make(map[string]interface{}, len(requirements.Extra))
	for key, value := range requirements.Extra {
		extra[key] = value
	}
	requirements.Extra = extra
	mutate(&requirements)
	return requirements
}

// openChannel is the confirmed channel account matching the fixture's open.
func (f *paymentFixture) openChannel() channelAccount {
	return channelAccount{
		Status:           paymentchannels.StatusOpen,
		Salt:             f.salt,
		Deposit:          f.deposit,
		GracePeriod:      f.graceSeconds,
		Payer:            f.payerKey.PublicKey(),
		Payee:            f.feePayer,
		AuthorizedSigner: f.authorizer.PublicKey(),
		Mint:             f.mint,
		RentPayer:        f.feePayer,
		OpenSlot:         testSlot,
		Splits:           f.splits(),
	}
}

func (f *paymentFixture) voucher(t *testing.T, amount uint64) string {
	t.Helper()
	message := paymentchannels.EncodeVoucherMessage(f.channelID, amount, f.expiresAt)
	signature, err := f.authorizer.Sign(message)
	require.NoError(t, err)
	return signature.String()
}

// voucherSignedBy signs a voucher over arbitrary bindings with an arbitrary
// key, so a test can tamper with one binding at a time.
func (f *paymentFixture) voucherSignedBy(
	t *testing.T, key solana.PrivateKey, channelID solana.PublicKey, amount uint64, expiresAt int64,
) string {
	t.Helper()
	signature, err := key.Sign(paymentchannels.EncodeVoucherMessage(channelID, amount, expiresAt))
	require.NoError(t, err)
	return signature.String()
}

func (f *paymentFixture) claimPayload(t *testing.T, amount uint64) types.PaymentPayload {
	t.Helper()
	return f.withPayload(map[string]interface{}{
		svm.UptoVoucherSignatureField: f.voucher(t, amount),
	})
}

func (f *paymentFixture) claimRequirements(amount uint64) types.PaymentRequirements {
	return f.withRequirements(func(requirements *types.PaymentRequirements) {
		requirements.Amount = strconv.FormatUint(amount, 10)
	})
}
