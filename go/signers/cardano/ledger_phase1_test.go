package cardano

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	gcbor "github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
	cardanofacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/facilitator"
	"github.com/x402-foundation/x402/go/v2/types"
)

var ledgerParams = map[string]interface{}{
	"min_fee_a": 44, "min_fee_b": 155381, "coins_per_utxo_size": "4310", "max_tx_size": 16384,
	"max_val_size": "5000", "collateral_percent": 150, "max_collateral_inputs": 3,
	"protocol_major_ver": 10, "protocol_minor_ver": 0,
}

type ledgerFixture struct {
	fake   *fakeBlockfrost
	signer *FacilitatorSigner
	inputs []common.Utxo
	tx     string
	built  *BuiltTx
}

// newLedgerFixture builds a payment from two wallet UTxOs, one carrying
// tokens, and serves both inputs and the parameters from the fake Blockfrost.
func newLedgerFixture(t *testing.T, payment PaymentOutput, ttl time.Time) *ledgerFixture {
	t.Helper()
	fake, bf := newFakeBlockfrost(t)
	w := testWallet(t)
	inputs := []common.Utxo{
		utxoAt(t, w.Address(), 0x0a, 0, 3_000_000, nil),
		utxoAt(t, w.Address(), 0x0b, 1, 30_000_000, map[string]uint64{tokenUnit: 50_000}),
	}
	slot, err := x402cardano.PosixMsToSlot("cardano:preprod", ttl.UnixMilli())
	require.NoError(t, err)
	built, err := build(t, w, inputs, payment, slot)
	require.NoError(t, err)
	fx := &ledgerFixture{fake: fake, inputs: inputs, tx: base64.StdEncoding.EncodeToString(built.Bytes), built: built}
	fx.serveInput(0x0a, 0, "3000000", nil, nil)
	fx.serveInput(0x0b, 1, "30000000", []map[string]string{amount(strings.ReplaceAll(tokenUnit, ".", ""), "50000")}, nil)
	fake.set("GET /epochs/latest/parameters", 200, ledgerParams)
	fx.signer, err = NewFacilitatorSigner(FacilitatorSignerConfig{Network: "cardano:preprod", Provider: bf, LedgerPhase1Validation: true})
	require.NoError(t, err)
	return fx
}

func (fx *ledgerFixture) serveInput(hash byte, index int, coin string, assets []map[string]string, extra map[string]interface{}) {
	output := map[string]interface{}{
		"output_index": index, "address": testWalletAddress,
		"amount": append([]map[string]string{amount("lovelace", coin)}, assets...), "consumed_by_tx": nil,
	}
	for k, v := range extra {
		output[k] = v
	}
	txHash := strings.Repeat(hex.EncodeToString([]byte{hash}), 32)
	fx.fake.set("GET /txs/"+txHash+"/utxos", 200, map[string]interface{}{"outputs": []map[string]interface{}{output}})
	fx.fake.set("GET /txs/"+txHash, 200, map[string]interface{}{"block_height": 1, "valid_contract": true})
}

func (fx *ledgerFixture) validate() error {
	validator, ok := fx.signer.AsFacilitatorSigner().(x402cardano.Phase1Validator)
	if !ok {
		panic("ledger validation not exposed")
	}
	return validator.ValidatePhase1Transaction(context.Background(), fx.tx, "cardano:preprod")
}

var testWalletAddress = func() string {
	w, err := NewWallet(testMnemonic, "cardano:preprod", 0)
	if err != nil {
		panic(err)
	}
	return w.Address().String()
}()

func TestLedgerPhase1AcceptsPayments(t *testing.T) {
	datum, _ := hex.DecodeString("d8799f182aff")
	for name, payment := range map[string]PaymentOutput{
		"lovelace": {Address: payToAddress, Coin: 5_000_000},
		"token":    {Address: payToAddress, Assets: map[string]uint64{tokenUnit: 10_000}, RaiseToMinUtxo: true},
		"datum":    {Address: scriptAddr, Coin: 2_000_000, Datum: datum, RaiseToMinUtxo: true},
	} {
		t.Run(name, func(t *testing.T) {
			fx := newLedgerFixture(t, payment, time.Now().Add(2*time.Minute))
			require.Len(t, fx.built.Inputs, 2, "both fixture inputs are spent")
			assert.NoError(t, fx.validate())
		})
	}
}

func TestLedgerPhase1Rejects(t *testing.T) {
	payment := PaymentOutput{Address: payToAddress, Coin: 5_000_000}
	future := time.Now().Add(2 * time.Minute)
	cases := map[string]struct {
		ttl     time.Time
		mutate  func(fx *ledgerFixture)
		message string
	}{
		"value not conserved": {future, func(fx *ledgerFixture) { fx.serveInput(0x0a, 0, "3000001", nil, nil) }, "conserved"},
		"spent input": {future, func(fx *ledgerFixture) {
			fx.serveInput(0x0a, 0, "3000000", nil, map[string]interface{}{"consumed_by_tx": strings.Repeat("cc", 32)})
		}, "input"},
		"fee below minimum": {future, func(fx *ledgerFixture) {
			params := map[string]interface{}{}
			for k, v := range ledgerParams {
				params[k] = v
			}
			params["min_fee_b"] = 500000
			fx.fake.set("GET /epochs/latest/parameters", 200, params)
		}, "fee"},
		"expired": {time.Now().Add(-time.Minute), func(*ledgerFixture) {}, "validity"},
		"reference script input": {future, func(fx *ledgerFixture) {
			fx.serveInput(0x0a, 0, "3000000", nil, map[string]interface{}{"reference_script_hash": strings.Repeat("ab", 28)})
		}, "reference script"},
		"missing parameters": {future, func(fx *ledgerFixture) {
			fx.fake.set("GET /epochs/latest/parameters", 200, map[string]interface{}{"min_fee_a": 44, "min_fee_b": 155381, "coins_per_utxo_size": "4310", "max_tx_size": 16384})
		}, "max value size"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			fx := newLedgerFixture(t, payment, tc.ttl)
			tc.mutate(fx)
			err := fx.validate()
			require.Error(t, err)
			assert.Contains(t, strings.ToLower(err.Error()), tc.message)
		})
	}
}

// Verification runs the ledger rules through the facilitator's phase-1 hook.
func TestLedgerPhase1RunsInVerify(t *testing.T) {
	fx := newLedgerFixture(t, PaymentOutput{Address: payToAddress, Coin: 5_000_000}, time.Now().Add(2*time.Minute))
	scheme := cardanofacilitator.NewExactCardanoScheme(fx.signer.AsFacilitatorSigner(), nil)
	requirements := types.PaymentRequirements{
		Scheme: "exact", Network: "cardano:preprod", Asset: "lovelace", Amount: "5000000", PayTo: payToAddress,
		MaxTimeoutSeconds: 300, Extra: map[string]interface{}{"confirmationPolicy": map[string]interface{}{"l1Confirmations": float64(0)}},
	}
	payload := types.PaymentPayload{X402Version: 2, Accepted: requirements, Payload: x402cardano.ExactCardanoPayload{
		Transaction: fx.tx, Nonce: fx.built.Nonce,
	}.ToMap()}
	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid, resp.InvalidReason+" "+resp.InvalidMessage)

	// A reference-script input passes the built-in checks; only the ledger
	// validator refuses it.
	fx.serveInput(0x0a, 0, "3000000", nil, map[string]interface{}{"reference_script_hash": strings.Repeat("ab", 28)})
	resp, err = scheme.Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.False(t, resp.IsValid)
	assert.Equal(t, x402cardano.ErrTransactionPhase1Invalid, resp.InvalidReason)
}

// State the provider cannot supply is refused explicitly, not by a rule
// panicking for want of it.
func TestLedgerPhase1RefusesUnsuppliedState(t *testing.T) {
	fx := newLedgerFixture(t, PaymentOutput{Address: payToAddress, Coin: 5_000_000}, time.Now().Add(2*time.Minute))
	raw, err := base64.StdEncoding.DecodeString(fx.tx)
	require.NoError(t, err)
	var parts []gcbor.RawMessage
	_, err = gcbor.Decode(raw, &parts)
	require.NoError(t, err)
	var body map[uint64]gcbor.RawMessage
	_, err = gcbor.Decode(parts[0], &body)
	require.NoError(t, err)
	w := testWallet(t)
	stakeKeyHash := w.StakePubKeyHash()
	// A Conway stake registration certificate with its deposit.
	body[4], err = gcbor.Encode(gcbor.Tag{Number: 258, Content: []any{[]any{7, []any{0, stakeKeyHash.Bytes()}, 2_000_000}}})
	require.NoError(t, err)
	bodyBytes, err := gcbor.Encode(body)
	require.NoError(t, err)
	witness, err := w.SignTxBody(common.Blake2b256Hash(bodyBytes))
	require.NoError(t, err)
	ws, err := gcbor.Encode(map[uint64]any{0: gcbor.Tag{Number: 258, Content: []any{[]any{witness.Vkey, witness.Signature}}}})
	require.NoError(t, err)
	tx, err := gcbor.Encode([]any{gcbor.RawMessage(bodyBytes), gcbor.RawMessage(ws), true, nil})
	require.NoError(t, err)
	fx.tx = base64.StdEncoding.EncodeToString(tx)
	err = fx.validate()
	require.ErrorIs(t, err, ErrLedgerStateUnavailable)
	assert.Contains(t, err.Error(), "certificates")
}
