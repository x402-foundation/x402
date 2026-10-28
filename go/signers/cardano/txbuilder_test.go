package cardano

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend"
	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/blinklabs-io/gouroboros/ledger/mary"
	"github.com/blinklabs-io/gouroboros/ledger/shelley"
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

var testParams = backend.ProtocolParameters{MinFeeCoefficient: 44, MinFeeConstant: 155381, CoinsPerUtxoByte: "4310", MaxTxSize: 16384}

func testWallet(t *testing.T) *apollo.BursaWallet {
	t.Helper()
	w, err := NewWallet(testMnemonic, "cardano:preprod", 0)
	require.NoError(t, err)
	return w
}

func utxoAt(t *testing.T, address common.Address, hash byte, index uint32, coin uint64, assets map[string]uint64) common.Utxo {
	t.Helper()
	in, err := shelley.NewShelleyTransactionInput(strings.Repeat(hex.EncodeToString([]byte{hash}), 32), int(index))
	require.NoError(t, err)
	value := mary.MaryTransactionOutputValue{Amount: coin}
	if len(assets) > 0 {
		data := map[common.Blake2b224]map[cbor.ByteString]*big.Int{}
		for unit, qty := range assets {
			policy, name, err := x402cardano.ParseAssetUnit(unit)
			require.NoError(t, err)
			pb, _ := hex.DecodeString(policy)
			nb, _ := hex.DecodeString(name)
			id := common.NewBlake2b224(pb)
			if data[id] == nil {
				data[id] = map[cbor.ByteString]*big.Int{}
			}
			data[id][cbor.NewByteString(nb)] = new(big.Int).SetUint64(qty)
		}
		multi := common.NewMultiAsset[common.MultiAssetTypeOutput](data)
		value.Assets = &multi
	}
	return common.Utxo{Id: in, Output: &babbage.BabbageTransactionOutput{OutputAddress: address, OutputAmount: value}}
}

func build(t *testing.T, w *apollo.BursaWallet, utxos []common.Utxo, payment PaymentOutput, ttl uint64) (*BuiltTx, error) {
	t.Helper()
	return BuildPaymentTx(context.Background(), PaymentTx{
		Nonce: utxos[0], Utxos: utxos[1:], Wallet: w, Payment: payment, TTLSlot: ttl, Params: testParams,
	})
}

// assertBalanced checks the ledger rules the facilitator also checks.
func assertBalanced(t *testing.T, built *BuiltTx, inputs []common.Utxo) *x402cardano.DecodedTransaction {
	t.Helper()
	decoded, err := x402cardano.DecodeTransactionCBOR(built.Bytes)
	require.NoError(t, err)
	assert.Equal(t, built.TxHash, decoded.TxHash)
	assert.True(t, decoded.SignaturesValid)
	assert.Equal(t, 1, decoded.VkeyWitnessCount)
	assert.True(t, decoded.IsValid)
	assert.Empty(t, decoded.BalanceChangingOperations)
	byRef := map[string]common.Utxo{}
	for _, u := range inputs {
		byRef[utxoRef(u)] = u
	}
	var inCoin uint64
	inAssets := map[string]uint64{}
	for _, ref := range decoded.Inputs {
		u, ok := byRef[ref]
		require.True(t, ok, "unexpected input %s", ref)
		inCoin += u.Output.Amount().Uint64()
		if assets := u.Output.Assets(); assets != nil {
			for _, policy := range assets.Policies() {
				for _, name := range assets.Assets(policy) {
					inAssets[policy.String()+"."+hex.EncodeToString(name)] += assets.Asset(policy, name).Uint64()
				}
			}
		}
	}
	outCoin := decoded.Fee
	outAssets := map[string]uint64{}
	for _, o := range decoded.Outputs {
		outCoin += o.Coin
		for k, v := range o.Assets {
			outAssets[k] += v
		}
		assert.GreaterOrEqual(t, o.Coin, x402cardano.MinUtxoLovelace(o.SerializedSize, 4310))
	}
	assert.Equal(t, inCoin, outCoin, "lovelace is conserved")
	assert.Equal(t, inAssets, outAssets, "assets are conserved")
	assert.GreaterOrEqual(t, decoded.Fee, uint64(155381+44*decoded.SizeBytes))
	assert.Contains(t, decoded.Inputs, built.Nonce)
	assert.Equal(t, decoded.Inputs, built.Inputs)
	return decoded
}

func TestBuildLovelacePayment(t *testing.T) {
	w := testWallet(t)
	inputs := []common.Utxo{utxoAt(t, w.Address(), 1, 0, 3_000_000, nil), utxoAt(t, w.Address(), 2, 1, 50_000_000, nil)}
	built, err := build(t, w, inputs, PaymentOutput{Address: payToAddress, Coin: 5_000_000}, 1234)
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.Equal(t, utxoRef(inputs[0]), built.Nonce, "the first UTxO is the nonce")
	assert.Equal(t, payToAddress, decoded.Outputs[0].Address)
	assert.EqualValues(t, 5_000_000, decoded.Outputs[0].Coin)
	assert.Equal(t, w.Address().String(), decoded.Outputs[1].Address)
	require.NotNil(t, decoded.TTLSlot)
	assert.EqualValues(t, 1234, *decoded.TTLSlot)
}

func TestBuildTokenPaymentRaisesMinUtxoAndReturnsTokens(t *testing.T) {
	w := testWallet(t)
	other := "aa" + strings.Repeat("00", 27) + ".01"
	inputs := []common.Utxo{
		utxoAt(t, w.Address(), 1, 0, 2_000_000, nil),
		utxoAt(t, w.Address(), 2, 0, 10_000_000, nil),
		utxoAt(t, w.Address(), 3, 0, 1_500_000, map[string]uint64{tokenUnit: 70_000, other: 5}),
	}
	built, err := build(t, w, inputs, PaymentOutput{Address: payToAddress, Assets: map[string]uint64{tokenUnit: 10_000}, RaiseToMinUtxo: true}, 99)
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.EqualValues(t, 10_000, decoded.Outputs[0].Assets[tokenUnit])
	assert.Len(t, decoded.Outputs[0].Assets, 1, "only the requested token is paid")
	var change uint64
	for _, o := range decoded.Outputs[1:] {
		change += o.Assets[tokenUnit]
	}
	assert.EqualValues(t, 60_000, change)
}

func TestBuildScriptPaymentWithInlineDatum(t *testing.T) {
	w := testWallet(t)
	datum, _ := hex.DecodeString("d8799f182aff")
	inputs := []common.Utxo{utxoAt(t, w.Address(), 1, 0, 20_000_000, nil)}
	built, err := build(t, w, inputs, PaymentOutput{Address: scriptAddr, Coin: 500_000, Datum: datum, RaiseToMinUtxo: true}, 1)
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.Equal(t, "d8799f182aff", decoded.Outputs[0].Datum)
	assert.Greater(t, decoded.Outputs[0].Coin, uint64(500_000), "raised to the min-UTxO of the datum output")
}

func TestBuildPaymentErrors(t *testing.T) {
	w := testWallet(t)
	_, err := BuildPaymentTx(context.Background(), PaymentTx{Wallet: w, Payment: PaymentOutput{Address: payToAddress, Coin: 2_000_000}, Params: testParams})
	assert.ErrorContains(t, err, "no UTxOs")
	_, err = build(t, w, []common.Utxo{utxoAt(t, w.Address(), 1, 0, 3_000_000, nil)}, PaymentOutput{Address: payToAddress, Coin: 5_000_000}, 1)
	assert.Error(t, err, "insufficient funds")
	_, err = build(t, w, []common.Utxo{utxoAt(t, w.Address(), 1, 0, 30_000_000, nil)}, PaymentOutput{Address: payToAddress, Coin: 100}, 1)
	assert.ErrorContains(t, err, "below the min-UTxO")
	_, err = build(t, w, []common.Utxo{utxoAt(t, w.Address(), 1, 0, 30_000_000, nil)}, PaymentOutput{Address: payToAddress, Assets: map[string]uint64{tokenUnit: 1}, RaiseToMinUtxo: true}, 1)
	assert.Error(t, err, "the wallet holds none of the token")
	_, err = build(t, w, []common.Utxo{utxoAt(t, w.Address(), 1, 0, 30_000_000, nil)}, PaymentOutput{Address: "addr_test1bogus", Coin: 2_000_000}, 1)
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
	got := map[string]string{}
	for name, payment := range map[string]PaymentOutput{
		"lovelace": {Address: payToAddress, Coin: 5_000_000},
		"token":    {Address: payToAddress, Assets: map[string]uint64{tokenUnit: 10000}, RaiseToMinUtxo: true},
		"script":   {Address: scriptAddr, Coin: 2_000_000, Datum: datum, RaiseToMinUtxo: true},
	} {
		inputs := []common.Utxo{utxoAt(t, w.Address(), 1, 0, 3_000_000, nil), utxoAt(t, w.Address(), 2, 0, 30_000_000, map[string]uint64{tokenUnit: 50000})}
		built, err := build(t, w, inputs, payment, 100000000)
		require.NoError(t, err, name)
		got[name] = base64.StdEncoding.EncodeToString(built.Bytes)
		got[name+"_hash"] = built.TxHash
	}
	if os.Getenv("UPDATE_GOLDEN") != "" {
		out, _ := json.MarshalIndent(got, "", "  ")
		require.NoError(t, os.WriteFile("testdata/evolution_roundtrip_txs.json", append(out, '\n'), 0o644))
	}
	assert.Equal(t, golden, got)
}

// Change below min-UTxO is spent on another input rather than burned as fee;
// only a wallet with nothing else to spend folds it into the fee.
func TestBuildPaymentKeepsSmallChange(t *testing.T) {
	w := testWallet(t)
	nonce := utxoAt(t, w.Address(), 1, 0, 5_500_000, nil)
	inputs := []common.Utxo{nonce, utxoAt(t, w.Address(), 2, 0, 20_000_000, nil)}
	built, err := build(t, w, inputs, PaymentOutput{Address: payToAddress, Coin: 5_000_000}, 1)
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.Len(t, decoded.Inputs, 2)
	assert.Less(t, decoded.Fee, uint64(155381+44*decoded.SizeBytes)+100_000, "change is kept, not paid as fee")

	built, err = build(t, w, inputs[:1], PaymentOutput{Address: payToAddress, Coin: 5_000_000}, 1)
	require.NoError(t, err)
	decoded = assertBalanced(t, built, inputs[:1])
	require.Len(t, decoded.Outputs, 1)
	assert.EqualValues(t, 500_000, decoded.Fee)
}

// Apollo raises a payment below 1 ADA to its own min-UTxO, measured in the
// map encoding; the builder holds the payment to the exact amount and returns
// the excess as change.
func TestBuildPaymentKeepsExactSubAdaAmount(t *testing.T) {
	w := testWallet(t)
	inputs := []common.Utxo{utxoAt(t, w.Address(), 1, 0, 10_000_000, nil)}
	built, err := build(t, w, inputs, PaymentOutput{Address: payToAddress, Coin: 975_000}, 1)
	require.NoError(t, err)
	decoded := assertBalanced(t, built, inputs)
	assert.EqualValues(t, 975_000, decoded.Outputs[0].Coin)
}
