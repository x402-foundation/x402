package cardano

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Salvionied/apollo/v2/backend"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

// The provider reads a Blockfrost-compatible API at its base URL exactly as
// given, so an API served at its root works, and the client
// signer pays through it.
func TestBlockfrostProviderPaysThroughRootAPI(t *testing.T) {
	fake, bf := newFakeBlockfrost(t)
	provider, err := NewBlockfrostProvider(bf.baseURL, "pid", "cardano:preprod")
	require.NoError(t, err)
	w := testWallet(t)
	fake.set("GET /epochs/latest/parameters", 200, map[string]interface{}{"min_fee_a": 44, "min_fee_b": 155381, "coins_per_utxo_size": "4310", "max_tx_size": 16384,
		"max_val_size": "5000", "collateral_percent": 150, "max_collateral_inputs": 3, "protocol_major_ver": 10, "protocol_minor_ver": 0})
	fake.set("GET /addresses/"+w.Address().String()+"/utxos?page=1&count=100", 200, []map[string]interface{}{
		{"tx_hash": strings.Repeat("01", 32), "output_index": 0, "address": w.Address().String(), "amount": []map[string]string{amount("lovelace", "3000000")}},
		{"tx_hash": strings.Repeat("02", 32), "output_index": 1, "address": w.Address().String(), "amount": []map[string]string{
			amount("lovelace", "30000000"), amount(strings.ReplaceAll(x402cardano.USDMPreprodAsset, ".", ""), "50000")}},
		{"tx_hash": strings.Repeat("03", 32), "output_index": 0, "address": w.Address().String(), "amount": []map[string]string{amount("lovelace", "90000000")},
			"reference_script_hash": strings.Repeat("ab", 28)},
	})

	params, err := backend.ProtocolParamsContext(context.Background(), provider)
	require.NoError(t, err)
	assert.Equal(t, int64(4310), params.CoinsPerUtxoByteValue())
	assert.Equal(t, 16384, params.MaxTxSize)
	utxos, err := backend.UtxosContext(context.Background(), provider, w.Address())
	require.NoError(t, err)
	require.Len(t, utxos, 2, "the reference-script UTxO is left out")
	assert.Equal(t, uint8(0), provider.NetworkId())

	signer, err := NewClientSigner(ClientSignerConfig{Mnemonic: testMnemonic, Network: "cardano:preprod", Provider: provider})
	require.NoError(t, err)
	signer.now = func() time.Time { return time.UnixMilli(1760000000000) }
	result, err := signer.BuildAndSignPaymentTransaction(context.Background(), x402cardano.ClientSignInput{
		Network: "cardano:preprod", PayTo: payToAddress, Asset: x402cardano.USDMPreprodAsset, Amount: "10000", MaxTimeoutSeconds: 300,
	})
	require.NoError(t, err)
	decoded, err := x402cardano.DecodeTransaction(result.Transaction)
	require.NoError(t, err)
	assert.True(t, decoded.SignaturesValid)
	assert.EqualValues(t, 10000, decoded.Outputs[0].Assets[x402cardano.USDMPreprodAsset])
	assert.NotContains(t, decoded.Inputs, strings.Repeat("03", 32)+"#0")
	for _, request := range fake.requests {
		assert.NotContains(t, request, "/api/v0", "the base URL is used exactly as given")
	}
}
