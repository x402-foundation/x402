package cardano

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// fakeBlockfrost serves canned Blockfrost responses keyed by "METHOD path".
type fakeBlockfrost struct {
	mu        sync.Mutex
	responses map[string]fakeResponse
	requests  []string
	bodies    map[string][]byte
}

type fakeResponse struct {
	status int
	body   interface{}
}

func newFakeBlockfrost(t *testing.T) (*fakeBlockfrost, *Blockfrost) {
	t.Helper()
	fake := &fakeBlockfrost{responses: map[string]fakeResponse{}, bodies: map[string][]byte{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		key := r.Method + " " + r.URL.RequestURI()
		fake.requests = append(fake.requests, key)
		body, _ := io.ReadAll(r.Body)
		fake.bodies[key] = body
		if r.Header.Get("project_id") != "pid" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		resp, ok := fake.responses[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(resp.status)
		_ = json.NewEncoder(w).Encode(resp.body)
	}))
	t.Cleanup(server.Close)
	return fake, NewBlockfrost(server.URL+"/", "pid", time.Second)
}

func (f *fakeBlockfrost) set(key string, status int, body interface{}) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responses[key] = fakeResponse{status: status, body: body}
}

func amount(unit, qty string) map[string]string {
	return map[string]string{"unit": unit, "quantity": qty}
}

func TestBlockfrostUtxosAt(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	page := []map[string]interface{}{{
		"tx_hash": strings.Repeat("AB", 32), "output_index": 1, "address": "addr_test1x",
		"amount":       []map[string]string{amount("lovelace", "5000000"), amount(x402cardano.USDMPreprodPolicyID+x402cardano.USDMAssetNameHexPreprod, "7")},
		"inline_datum": "d87980",
	}}
	fake.set("GET /addresses/addr_test1x/utxos?page=1&count=100", 200, page)
	utxos, err := bf.UtxosAt(context.Background(), "addr_test1x")
	require.NoError(t, err)
	require.Len(t, utxos, 1)
	assert.Equal(t, strings.Repeat("ab", 32), utxos[0].TxHash)
	assert.EqualValues(t, 5000000, utxos[0].Coin)
	assert.EqualValues(t, 7, utxos[0].Assets[x402cardano.USDMPreprodAsset])
	assert.True(t, utxos[0].HasDatum)

	empty, err := bf.UtxosAt(context.Background(), "addr_test1unknown")
	require.NoError(t, err)
	assert.Empty(t, empty, "404 means no UTxOs")

	fake.set("GET /addresses/addr_test1bad/utxos?page=1&count=100", 500, map[string]string{"error": "boom"})
	_, err = bf.UtxosAt(context.Background(), "addr_test1bad")
	var apiErr *APIError
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, 500, apiErr.StatusCode)
}

func TestBlockfrostPagination(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	full := make([]map[string]interface{}, 100)
	for i := range full {
		full[i] = map[string]interface{}{"tx_hash": strings.Repeat("01", 32), "output_index": i, "address": "a", "amount": []map[string]string{amount("lovelace", "1")}}
	}
	fake.set("GET /addresses/a/utxos?page=1&count=100", 200, full)
	fake.set("GET /addresses/a/utxos?page=2&count=100", 200, full[:3])
	utxos, err := bf.UtxosAt(context.Background(), "a")
	require.NoError(t, err)
	assert.Len(t, utxos, 103)
}

func TestBlockfrostProtocolParameters(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	fake.set("GET /epochs/latest/parameters", 200, map[string]interface{}{
		"min_fee_a": 44, "min_fee_b": 155381, "coins_per_utxo_size": "4310", "max_tx_size": 16384,
	})
	params, err := bf.ProtocolParameters(context.Background())
	require.NoError(t, err)
	assert.Equal(t, ProtocolParameters{MinFeeA: 44, MinFeeB: 155381, CoinsPerUtxoByte: 4310, MaxTxSize: 16384}, *params)
	fake.set("GET /epochs/latest/parameters", 200, map[string]interface{}{"min_fee_a": 44, "min_fee_b": 1, "coins_per_utxo_size": "x", "max_tx_size": 1})
	_, err = bf.ProtocolParameters(context.Background())
	assert.Error(t, err)
}

func TestBlockfrostSubmitSendsRawBytes(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	fake.set("POST /tx/submit", 200, strings.Repeat("CD", 32))
	hash, err := bf.Submit(context.Background(), []byte{0x84, 0x01})
	require.NoError(t, err)
	assert.Equal(t, strings.Repeat("cd", 32), hash)
	assert.Equal(t, []byte{0x84, 0x01}, fake.bodies["POST /tx/submit"])

	fake.set("POST /tx/submit", 400, map[string]string{"message": "BadInputsUTxO"})
	_, err = bf.Submit(context.Background(), []byte{0x84})
	assert.ErrorContains(t, err, "BadInputsUTxO")
}

func TestBlockfrostEvidence(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	hash := strings.Repeat("aa", 32)
	ev, err := bf.Evidence(context.Background(), hash)
	require.NoError(t, err)
	assert.Equal(t, x402cardano.EvidenceUnknown, ev.Status)

	fake.set("GET /txs/"+hash, 200, map[string]interface{}{"block_height": 100, "valid_contract": true})
	fake.set("GET /blocks/latest", 200, map[string]interface{}{"height": 103})
	ev, err = bf.Evidence(context.Background(), hash)
	require.NoError(t, err)
	assert.Equal(t, x402cardano.SettlementEvidence{Status: x402cardano.EvidenceConfirmed, Confirmations: 3}, *ev)

	fake.set("GET /txs/"+hash, 200, map[string]interface{}{"block_height": 100, "valid_contract": false})
	ev, err = bf.Evidence(context.Background(), hash)
	require.NoError(t, err)
	assert.Equal(t, x402cardano.EvidenceUnknown, ev.Status, "phase-2 invalid pays nothing")
}

// A degraded response is a lookup failure, never confirmation evidence.
func TestBlockfrostEvidenceRejectsIncompleteResponses(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	hash := strings.Repeat("aa", 32)
	fake.set("GET /blocks/latest", 200, map[string]interface{}{"height": 103})
	for name, tx := range map[string]map[string]interface{}{
		"no fields":         {},
		"no block height":   {"valid_contract": true},
		"no valid contract": {"block_height": 100},
	} {
		fake.set("GET /txs/"+hash, 200, tx)
		_, err := bf.Evidence(context.Background(), hash)
		assert.Error(t, err, name)
	}
	fake.set("GET /txs/"+hash, 200, map[string]interface{}{"block_height": 100, "valid_contract": true})
	for name, tip := range map[string]map[string]interface{}{"no tip height": {}, "tip behind": {"height": 99}} {
		fake.set("GET /blocks/latest", 200, tip)
		_, err := bf.Evidence(context.Background(), hash)
		assert.Error(t, err, name)
	}
}

func TestBlockfrostEvaluate(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	fake.set("POST /utils/txs/evaluate/utxos", 200, map[string]interface{}{"result": map[string]interface{}{"EvaluationResult": map[string]interface{}{}}})
	require.NoError(t, bf.Evaluate(context.Background(), []byte{0x84}))
	assert.Contains(t, string(fake.bodies["POST /utils/txs/evaluate/utxos"]), `"cbor":"84"`)
	fake.set("POST /utils/txs/evaluate/utxos", 200, map[string]interface{}{"result": map[string]interface{}{"EvaluationFailure": map[string]interface{}{"x": 1}}})
	assert.ErrorContains(t, bf.Evaluate(context.Background(), []byte{0x84}), "evaluation failed")
	fake.set("POST /utils/txs/evaluate/utxos", 200, map[string]interface{}{"type": "jsonwsp/fault", "fault": map[string]interface{}{"string": "nope"}})
	assert.ErrorContains(t, bf.Evaluate(context.Background(), []byte{0x84}), "nope")
	fake.set("POST /utils/txs/evaluate/utxos", 200, map[string]interface{}{})
	assert.ErrorContains(t, bf.Evaluate(context.Background(), []byte{0x84}), "no result")
}

func TestDefaultBlockfrostURL(t *testing.T) {
	url, err := DefaultBlockfrostURL("cip34:0-1")
	require.NoError(t, err)
	assert.Contains(t, url, "preprod")
	_, err = DefaultBlockfrostURL("eip155:1")
	assert.Error(t, err)
}

func TestFacilitatorSignerGetUtxo(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	w := testWallet(t)
	signer, err := NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf, Addresses: []string{w.Address()}})
	require.NoError(t, err)
	assert.Equal(t, []string{w.Address()}, signer.GetAddresses())
	_, err = NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:mainnet", Provider: bf, Addresses: []string{w.Address()}})
	assert.Error(t, err, "a preprod address is refused on mainnet")
	_, err = NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf, Addresses: []string{"addr_test1bogus"}})
	assert.Error(t, err)
	hash := strings.Repeat("aa", 32)
	ref := hash + "#0"
	ctx := context.Background()

	snapshot, err := signer.GetUtxo(ctx, ref, "cardano:preprod")
	require.NoError(t, err)
	assert.False(t, snapshot.Exists)

	fake.set("GET /txs/"+hash+"/utxos", 200, map[string]interface{}{"outputs": []map[string]interface{}{{
		"output_index": 0, "address": w.Address(), "amount": []map[string]string{amount("lovelace", "9")}, "consumed_by_tx": nil,
	}}})
	snapshot, err = signer.GetUtxo(ctx, ref, "cip34:0-1")
	require.NoError(t, err)
	assert.True(t, snapshot.Exists)
	assert.NotContains(t, strings.Join(fake.requests, ","), "/addresses/", "null consumed_by_tx means unspent; no address scan")
	require.NotNil(t, snapshot.Coin)
	assert.EqualValues(t, 9, *snapshot.Coin)
	cred, _ := x402cardano.PaymentCredential(w.Address())
	assert.Equal(t, cred.HashHex(), snapshot.PaymentKeyHash)

	fake.set("GET /txs/"+hash+"/utxos", 200, map[string]interface{}{"outputs": []map[string]interface{}{{
		"output_index": 0, "address": w.Address(), "amount": []map[string]string{amount("lovelace", "9")}, "consumed_by_tx": strings.Repeat("bb", 32),
	}}})
	snapshot, err = signer.GetUtxo(ctx, ref, "cardano:preprod")
	require.NoError(t, err)
	assert.False(t, snapshot.Exists, "spent outputs do not exist")
	assert.Equal(t, w.Address(), snapshot.Address, "the owner is still reported")

	fake.set("GET /txs/"+hash+"/utxos", 200, map[string]interface{}{"outputs": []map[string]interface{}{{
		"output_index": 0, "address": w.Address(), "amount": []map[string]string{amount("lovelace", "9")},
	}}})
	fake.set("GET /addresses/"+w.Address()+"/utxos?page=1&count=100", 200, []map[string]interface{}{{
		"tx_hash": hash, "output_index": 0, "address": w.Address(), "amount": []map[string]string{amount("lovelace", "9")},
	}})
	snapshot, err = signer.GetUtxo(ctx, ref, "cardano:preprod")
	require.NoError(t, err)
	assert.True(t, snapshot.Exists, "falls back to the owner's unspent set")

	_, err = signer.GetUtxo(ctx, ref, "cardano:mainnet")
	assert.Error(t, err)
	_, err = signer.GetUtxo(ctx, "bad", "cardano:preprod")
	assert.Error(t, err)
}

func TestFacilitatorSignerReads(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	signer, err := NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf})
	require.NoError(t, err)
	assert.Empty(t, signer.GetAddresses())
	ctx := context.Background()

	signer.now = func() time.Time { return time.UnixMilli(1655769600000 + 20_500) }
	slot, err := signer.GetCurrentSlot(ctx, "cardano:preprod")
	require.NoError(t, err)
	assert.EqualValues(t, 86420, slot)

	fake.set("GET /epochs/latest/parameters", 200, map[string]interface{}{"min_fee_a": 44, "min_fee_b": 155381, "coins_per_utxo_size": "4310", "max_tx_size": 16384})
	params, err := signer.GetProtocolParameters(ctx, "cardano:preprod")
	require.NoError(t, err)
	assert.Equal(t, x402cardano.ProtocolParameters{CoinsPerUtxoByte: 4310, MinFeeCoefficient: 44, MinFeeConstant: 155381}, *params)
	_, err = signer.GetProtocolParameters(ctx, "cardano:preprod")
	require.NoError(t, err)
	count := 0
	for _, r := range fake.requests {
		if strings.Contains(r, "parameters") {
			count++
		}
	}
	assert.Equal(t, 1, count, "parameters are cached")

	vector := loadSpecTx(t)
	fake.set("POST /tx/submit", 200, vector.hash)
	result, err := signer.SubmitTransaction(ctx, vector.tx, "cardano:preprod")
	require.NoError(t, err)
	assert.Equal(t, x402cardano.EvidenceMempool, result.Status)
	require.NoError(t, signer.EvaluateTransaction(ctx, vector.tx, "cardano:preprod"), "no redeemers, nothing to evaluate")
	assert.NotContains(t, strings.Join(fake.requests, ","), "evaluate")

	_, err = NewFacilitatorSigner(FacilitatorSignerConfig{Network: "solana:x", Provider: bf})
	assert.Error(t, err)
	_, err = NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod"})
	assert.Error(t, err)
}

func TestFacilitatorSignerPhase1Wrapper(t *testing.T) {
	_, bf := newFakeBlockfrost(t)
	called := false
	signer, err := NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf,
		ValidatePhase1: func(context.Context, string, string) error { called = true; return nil }})
	require.NoError(t, err)
	validator, ok := signer.AsFacilitatorSigner().(x402cardano.Phase1Validator)
	require.True(t, ok)
	require.NoError(t, validator.ValidatePhase1Transaction(context.Background(), "x", "cardano:preprod"))
	assert.True(t, called)
	plain, _ := NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf})
	_, ok = plain.AsFacilitatorSigner().(x402cardano.Phase1Validator)
	assert.False(t, ok)
}

type specTx struct{ tx, hash string }

func loadSpecTx(t *testing.T) specTx {
	t.Helper()
	raw, err := os.ReadFile("../../mechanisms/cardano/testdata/decode_vectors.json")
	require.NoError(t, err)
	var vectors []struct {
		Transaction string `json:"transaction"`
		Decoded     struct {
			TxHash string `json:"txHash"`
		} `json:"decoded"`
	}
	require.NoError(t, json.Unmarshal(raw, &vectors))
	return specTx{tx: vectors[0].Transaction, hash: vectors[0].Decoded.TxHash}
}
