package cardano

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

func newTestClientSigner(t *testing.T) (*ClientSigner, *fakeBlockfrost) {
	t.Helper()
	fake, bf := newFakeBlockfrost(t)
	signer, err := NewClientSigner(ClientSignerConfig{Mnemonic: testMnemonic, Network: "cardano:preprod", Provider: bf})
	require.NoError(t, err)
	signer.now = func() time.Time { return time.UnixMilli(1760000000000) }
	fake.set("GET /epochs/latest/parameters", 200, map[string]interface{}{"min_fee_a": 44, "min_fee_b": 155381, "coins_per_utxo_size": "4310", "max_tx_size": 16384})
	fake.set("GET /addresses/"+signer.Address()+"/utxos?page=1&count=100", 200, []map[string]interface{}{
		{"tx_hash": strings.Repeat("01", 32), "output_index": 0, "address": signer.Address(), "amount": []map[string]string{amount("lovelace", "3000000")}},
		{"tx_hash": strings.Repeat("02", 32), "output_index": 4, "address": signer.Address(), "amount": []map[string]string{
			amount("lovelace", "40000000"), amount(x402cardano.USDMPreprodPolicyID+x402cardano.USDMAssetNameHexPreprod, "500000"),
		}},
	})
	return signer, fake
}

// With ReserveInputs, concurrent payments from one wallet use disjoint
// inputs; once every UTxO is held the signer says so until the TTL passes.
func TestClientSignerReservesInputs(t *testing.T) {
	signer, _ := newTestClientSigner(t)
	signer.reserve = true
	now := time.UnixMilli(1760000000000)
	var clock sync.Mutex
	signer.now = func() time.Time { clock.Lock(); defer clock.Unlock(); return now }
	input := x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "1000000", MaxTimeoutSeconds: 300}

	results := make([]*x402cardano.ClientSignResult, 2)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := signer.BuildAndSignPaymentTransaction(context.Background(), input)
			assert.NoError(t, err)
			results[i] = result
		}()
	}
	wg.Wait()
	spent := map[string]bool{}
	for _, result := range results {
		require.NotNil(t, result)
		decoded, err := x402cardano.DecodeTransaction(result.Transaction)
		require.NoError(t, err)
		for _, in := range decoded.Inputs {
			assert.False(t, spent[in], "input %s is spent by both payments", in)
			spent[in] = true
		}
	}

	_, err := signer.BuildAndSignPaymentTransaction(context.Background(), input)
	assert.ErrorIs(t, err, ErrUtxosReserved)

	// A stale snapshot missing a reserved UTxO must not release it.
	signer.mu.Lock()
	signer.unreserved(nil)
	held := len(signer.reserved)
	signer.mu.Unlock()
	assert.Positive(t, held, "absence from a snapshot proves nothing")
	_, err = signer.BuildAndSignPaymentTransaction(context.Background(), input)
	assert.ErrorIs(t, err, ErrUtxosReserved)
	clock.Lock()
	now = now.Add(301 * time.Second)
	clock.Unlock()
	_, err = signer.BuildAndSignPaymentTransaction(context.Background(), input)
	assert.NoError(t, err, "expired payments release their inputs")
}

// A wallet UTxO carrying a reference script is never spent, not even as the
// nonce: its reference-script fee is not computed, so the node would reject it.
func TestClientSignerSkipsReferenceScriptNonce(t *testing.T) {
	signer, fake := newTestClientSigner(t)
	refScript := strings.Repeat("ab", 28)
	fake.set("GET /addresses/"+signer.Address()+"/utxos?page=1&count=100", 200, []map[string]interface{}{
		{"tx_hash": strings.Repeat("01", 32), "output_index": 0, "address": signer.Address(), "amount": []map[string]string{amount("lovelace", "60000000")}, "reference_script_hash": refScript},
		{"tx_hash": strings.Repeat("02", 32), "output_index": 4, "address": signer.Address(), "amount": []map[string]string{amount("lovelace", "40000000")}},
	})
	result, err := signer.BuildAndSignPaymentTransaction(context.Background(), x402cardano.ClientSignInput{
		Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300,
	})
	require.NoError(t, err)
	assert.Equal(t, strings.Repeat("02", 32)+"#4", result.Nonce)
	decoded, err := x402cardano.DecodeTransaction(result.Transaction)
	require.NoError(t, err)
	assert.NotContains(t, decoded.Inputs, strings.Repeat("01", 32)+"#0")

	fake.set("GET /addresses/"+signer.Address()+"/utxos?page=1&count=100", 200, []map[string]interface{}{
		{"tx_hash": strings.Repeat("01", 32), "output_index": 0, "address": signer.Address(), "amount": []map[string]string{amount("lovelace", "60000000")}, "reference_script_hash": refScript},
	})
	_, err = signer.BuildAndSignPaymentTransaction(context.Background(), x402cardano.ClientSignInput{
		Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300,
	})
	assert.ErrorContains(t, err, "no UTxOs available")
}

func TestClientSignerBuildsPayments(t *testing.T) {
	signer, _ := newTestClientSigner(t)
	ctx := context.Background()
	cases := map[string]x402cardano.ClientSignInput{
		"lovelace": {Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300},
		"token":    {Network: "cip34:0-1", PayTo: payToAddress, Asset: x402cardano.USDMPreprodAsset, Amount: "10000", MaxTimeoutSeconds: 300},
		"script": {Network: "cardano:preprod", PayTo: scriptAddr, Asset: "lovelace", Amount: "2000000", MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{"assetTransferMethod": "script", "datum": "d8799f182aff"}},
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			result, err := signer.BuildAndSignPaymentTransaction(ctx, input)
			require.NoError(t, err)
			assert.Equal(t, strings.Repeat("01", 32)+"#0", result.Nonce, "the first wallet UTxO is the nonce")
			decoded, err := x402cardano.DecodeTransaction(result.Transaction)
			require.NoError(t, err)
			assert.True(t, decoded.SignaturesValid)
			assert.Contains(t, decoded.Inputs, result.Nonce)
			assert.Equal(t, input.PayTo, decoded.Outputs[0].Address)
			require.NotNil(t, decoded.TTLSlot)
			ttlMs, _ := x402cardano.SlotToPosixMs("cardano:preprod", *decoded.TTLSlot)
			assert.LessOrEqual(t, ttlMs, int64(1760000000000+300_000), "TTL stays within maxTimeoutSeconds")
			if name == "script" {
				assert.Equal(t, "d8799f182aff", decoded.Outputs[0].Datum)
			}
			if name == "token" {
				assert.EqualValues(t, 10000, decoded.Outputs[0].Assets[x402cardano.USDMPreprodAsset])
			}
		})
	}
}

func TestClientSignerRejects(t *testing.T) {
	signer, fake := newTestClientSigner(t)
	ctx := context.Background()
	_, err := signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:mainnet", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000"})
	assert.ErrorContains(t, err, "configured for")
	_, err = signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "99999999999999999999999"})
	assert.ErrorContains(t, err, "invalid Cardano amount")
	bad := "zz"
	_, err = signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: scriptAddr, Asset: "lovelace", Amount: "2000000",
		Extra: map[string]interface{}{"assetTransferMethod": "script", "datum": bad}})
	assert.Error(t, err)

	fake.set("GET /addresses/"+signer.Address()+"/utxos?page=1&count=100", 200, []map[string]interface{}{})
	_, err = signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000"})
	assert.ErrorContains(t, err, "no UTxOs")

	_, err = NewClientSigner(ClientSignerConfig{Mnemonic: testMnemonic, Network: "cardano:preprod"})
	assert.Error(t, err)
}
