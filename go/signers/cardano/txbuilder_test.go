package cardano

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const (
	testMnemonic = "test walk nut penalty hip pave soap entry language right filter choice"
	payToAddress = "addr_test1qpdp327fu3hpm8ljwkvjy7lfqj80x469rukv8q83jegrxumkegy93sy8slex9xny7z7cj3hgdx0ly3elexy4pgd2m4hqflxyfj"
	scriptAddr   = "addr_test1wp8l7eylksmjas7ypzm0q35dwnjdxxvsfn0z0lflqzgs55stpd682"
	tokenUnit    = x402cardano.USDMPreprodAsset
)

var testParams = ProtocolParameters{MinFeeA: 44, MinFeeB: 155381, CoinsPerUtxoByte: 4310, MaxTxSize: 16384}

func testWallet(t *testing.T) *Wallet {
	t.Helper()
	w, err := NewWalletFromMnemonic(testMnemonic, "cardano:preprod", 0)
	require.NoError(t, err)
	return w
}

func utxo(hash byte, index uint32, coin uint64, assets map[string]uint64) Utxo {
	return Utxo{TxHash: strings.Repeat(hex.EncodeToString([]byte{hash}), 32), Index: index, Coin: coin, Assets: assets}
}

func signWith(w *Wallet) TxSigner {
	return func(hash []byte) ([]byte, []byte) { return w.PaymentPublicKey(), w.SignTxBody(hash) }
}

// assertBalanced checks the ledger rules the facilitator also checks.
func assertBalanced(t *testing.T, built *BuiltTx, inputs []Utxo) *x402cardano.DecodedTransaction {
	t.Helper()
	decoded, err := x402cardano.DecodeTransactionCBOR(built.Bytes)
	require.NoError(t, err)
	assert.Equal(t, built.TxHash, decoded.TxHash)
	assert.True(t, decoded.SignaturesValid)
	assert.Equal(t, 1, decoded.VkeyWitnessCount)
	assert.True(t, decoded.IsValid)
	assert.Empty(t, decoded.BalanceChangingOperations)
	byRef := map[string]Utxo{}
	for _, u := range inputs {
		byRef[u.Ref()] = u
	}
	var inCoin uint64
	inAssets := map[string]uint64{}
	for _, ref := range decoded.Inputs {
		u, ok := byRef[ref]
		require.True(t, ok, "unexpected input %s", ref)
		inCoin += u.Coin
		for k, v := range u.Assets {
			inAssets[k] += v
		}
	}
	outCoin := decoded.Fee
	outAssets := map[string]uint64{}
	for _, o := range decoded.Outputs {
		outCoin += o.Coin
		for k, v := range o.Assets {
			outAssets[k] += v
		}
		assert.GreaterOrEqual(t, o.Coin, x402cardano.MinUtxoLovelace(o.SerializedSize, testParams.CoinsPerUtxoByte))
	}
	assert.Equal(t, inCoin, outCoin, "lovelace is conserved")
	assert.Equal(t, inAssets, outAssets, "assets are conserved")
	assert.GreaterOrEqual(t, decoded.Fee, testParams.MinFeeB+testParams.MinFeeA*uint64(decoded.SizeBytes))
	assert.Contains(t, decoded.Inputs, built.Nonce)
	return decoded
}

func TestBuildLovelacePayment(t *testing.T) {
	w := testWallet(t)
	inputs := []Utxo{utxo(1, 0, 3_000_000, nil), utxo(2, 1, 50_000_000, nil)}
	built, err := BuildPaymentTx(PaymentTx{
		Utxos: inputs, ChangeAddress: w.Address(), TTLSlot: 1234,
		Payment: PaymentOutput{Address: payToAddress, Coin: 5_000_000},
		Params:  testParams,
	}, signWith(w))
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.Equal(t, inputs[0].Ref(), built.Nonce, "the first UTxO is the nonce")
	assert.Equal(t, payToAddress, decoded.Outputs[0].Address)
	assert.EqualValues(t, 5_000_000, decoded.Outputs[0].Coin)
	assert.Equal(t, w.Address(), decoded.Outputs[1].Address)
	require.NotNil(t, decoded.TTLSlot)
	assert.EqualValues(t, 1234, *decoded.TTLSlot)
}

func TestBuildTokenPaymentRaisesMinUtxoAndReturnsTokens(t *testing.T) {
	w := testWallet(t)
	inputs := []Utxo{
		utxo(1, 0, 2_000_000, nil),
		utxo(2, 0, 10_000_000, nil),
		utxo(3, 0, 1_500_000, map[string]uint64{tokenUnit: 70_000, "aa" + strings.Repeat("00", 27) + ".01": 5}),
	}
	built, err := BuildPaymentTx(PaymentTx{
		Utxos: inputs, ChangeAddress: w.Address(), TTLSlot: 99,
		Payment: PaymentOutput{Address: payToAddress, Assets: map[string]uint64{tokenUnit: 10_000}, RaiseToMinUtxo: true},
		Params:  testParams,
	}, signWith(w))
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.EqualValues(t, 10_000, decoded.Outputs[0].Assets[tokenUnit])
	assert.EqualValues(t, 60_000, decoded.Outputs[1].Assets[tokenUnit])
	assert.EqualValues(t, 5, decoded.Outputs[1].Assets["aa"+strings.Repeat("00", 27)+".01"])
}

func TestBuildScriptPaymentWithInlineDatum(t *testing.T) {
	w := testWallet(t)
	datum, _ := hex.DecodeString("d8799f182aff")
	inputs := []Utxo{utxo(1, 0, 20_000_000, nil)}
	built, err := BuildPaymentTx(PaymentTx{
		Utxos: inputs, ChangeAddress: w.Address(), TTLSlot: 1,
		Payment: PaymentOutput{Address: scriptAddr, Coin: 500_000, Datum: datum, RaiseToMinUtxo: true},
		Params:  testParams,
	}, signWith(w))
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.Equal(t, "d8799f182aff", decoded.Outputs[0].Datum)
	assert.Greater(t, decoded.Outputs[0].Coin, uint64(500_000), "raised to the min-UTxO of the datum output")
}

// A wallet whose last UTxO covers payment and fee but not a change output
// still pays: the remainder becomes fee instead of an undersized output.
func TestBuildPaymentFoldsSmallChangeIntoFee(t *testing.T) {
	w := testWallet(t)
	inputs := []Utxo{utxo(1, 0, 5_500_000, nil)}
	built, err := BuildPaymentTx(PaymentTx{
		Utxos: inputs, ChangeAddress: w.Address(), TTLSlot: 1234,
		Payment: PaymentOutput{Address: payToAddress, Coin: 5_000_000},
		Params:  testParams,
	}, signWith(w))
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	require.Len(t, decoded.Outputs, 1)
	assert.EqualValues(t, 500_000, decoded.Fee)

	_, err = BuildPaymentTx(PaymentTx{
		Utxos: []Utxo{utxo(1, 0, 5_500_000, map[string]uint64{tokenUnit: 1})}, ChangeAddress: w.Address(),
		Payment: PaymentOutput{Address: payToAddress, Coin: 5_000_000}, Params: testParams,
	}, signWith(w))
	assert.ErrorContains(t, err, "insufficient funds", "returned tokens still need a funded change output")
}

func TestBuildPaymentErrors(t *testing.T) {
	w := testWallet(t)
	_, err := BuildPaymentTx(PaymentTx{Utxos: nil, ChangeAddress: w.Address(), Payment: PaymentOutput{Address: payToAddress, Coin: 2_000_000}, Params: testParams}, signWith(w))
	assert.ErrorContains(t, err, "no UTxOs")
	_, err = BuildPaymentTx(PaymentTx{Utxos: []Utxo{utxo(1, 0, 3_000_000, nil)}, ChangeAddress: w.Address(), Payment: PaymentOutput{Address: payToAddress, Coin: 5_000_000}, Params: testParams}, signWith(w))
	assert.ErrorContains(t, err, "insufficient funds")
	_, err = BuildPaymentTx(PaymentTx{Utxos: []Utxo{utxo(1, 0, 30_000_000, nil)}, ChangeAddress: w.Address(), Payment: PaymentOutput{Address: payToAddress, Coin: 100}, Params: testParams}, signWith(w))
	assert.ErrorContains(t, err, "below the min-UTxO")
	_, err = BuildPaymentTx(PaymentTx{Utxos: []Utxo{utxo(1, 0, 30_000_000, nil)}, ChangeAddress: w.Address(), Payment: PaymentOutput{Address: payToAddress, Assets: map[string]uint64{tokenUnit: 1}, RaiseToMinUtxo: true}, Params: testParams}, signWith(w))
	assert.ErrorContains(t, err, "insufficient funds")
	_, err = BuildPaymentTx(PaymentTx{Utxos: []Utxo{utxo(1, 0, 30_000_000, nil)}, ChangeAddress: w.Address(), Payment: PaymentOutput{Address: "addr_test1bogus", Coin: 2_000_000}, Params: testParams}, signWith(w))
	assert.Error(t, err)
}

// evolution_roundtrip_txs.json holds transactions this builder produced that
// Evolution (TypeScript) decodes and re-encodes byte-identically. The TS
// facilitator re-encodes before submitting, so any drift would change the
// transaction id there.
func TestBuildMatchesEvolutionEncoding(t *testing.T) {
	raw, err := os.ReadFile("testdata/evolution_roundtrip_txs.json")
	require.NoError(t, err)
	var golden map[string]string
	require.NoError(t, json.Unmarshal(raw, &golden))
	w := testWallet(t)
	datum, _ := hex.DecodeString("d8799f182aff")
	payee := "addr_test1qpdp327fu3hpm8ljwkvjy7lfqj80x469rukv8q83jegrxumkegy93sy8slex9xny7z7cj3hgdx0ly3elexy4pgd2m4hqflxyfj"
	for name, payment := range map[string]PaymentOutput{
		"lovelace": {Address: payee, Coin: 5_000_000},
		"token":    {Address: payee, Assets: map[string]uint64{tokenUnit: 10000}, RaiseToMinUtxo: true},
		"script":   {Address: scriptAddr, Coin: 2_000_000, Datum: datum, RaiseToMinUtxo: true},
	} {
		t.Run(name, func(t *testing.T) {
			built, err := BuildPaymentTx(PaymentTx{
				Utxos:         []Utxo{utxo(1, 0, 3_000_000, nil), utxo(2, 0, 30_000_000, map[string]uint64{tokenUnit: 50000})},
				ChangeAddress: w.Address(),
				Payment:       payment,
				TTLSlot:       100000000,
				Params:        ProtocolParameters{MinFeeA: 44, MinFeeB: 155381, CoinsPerUtxoByte: 4310},
			}, signWith(w))
			require.NoError(t, err)
			assert.Equal(t, golden[name], base64.StdEncoding.EncodeToString(built.Bytes))
			assert.Equal(t, golden[name+"_hash"], built.TxHash)
		})
	}
}

func TestBuildPaymentSkipsReferenceScriptInputs(t *testing.T) {
	w := testWallet(t)
	refScript := utxo(2, 0, 100_000_000, nil)
	refScript.HasReferenceScript = true
	inputs := []Utxo{utxo(1, 0, 2_000_000, nil), refScript, utxo(3, 0, 10_000_000, nil)}
	built, err := BuildPaymentTx(PaymentTx{
		Utxos: inputs, ChangeAddress: w.Address(), TTLSlot: 1,
		Payment: PaymentOutput{Address: payToAddress, Coin: 5_000_000}, Params: testParams,
	}, signWith(w))
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.NotContains(t, decoded.Inputs, refScript.Ref())
}
