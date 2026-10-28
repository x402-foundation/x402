package cardano

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	apollo "github.com/Salvionied/apollo/v2"
	"github.com/Salvionied/apollo/v2/backend"
	"github.com/Salvionied/apollo/v2/backend/fixed"
	"github.com/blinklabs-io/gouroboros/ledger/babbage"
	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402cardano "github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

func newTestClientSigner(t *testing.T) *ClientSigner {
	t.Helper()
	w := testWallet(t)
	signer, err := NewClientSigner(ClientSignerConfig{Mnemonic: testMnemonic, Network: "cardano:preprod", Provider: chainWith(t, w.Address(),
		utxoAt(t, w.Address(), 1, 0, 3_000_000, nil),
		utxoAt(t, w.Address(), 2, 4, 40_000_000, map[string]uint64{x402cardano.USDMPreprodAsset: 500000}),
	)})
	require.NoError(t, err)
	signer.now = func() time.Time { return time.UnixMilli(1760000000000) }
	return signer
}

func chainWith(t *testing.T, address common.Address, utxos ...common.Utxo) *fixed.FixedChainContext {
	t.Helper()
	chain := fixed.NewFixedChainContext(testParams, backend.GenesisParameters{}, 0)
	for _, u := range utxos {
		chain.AddUtxo(address, u)
	}
	return chain
}

// With ReserveInputs, concurrent payments from one wallet use disjoint
// inputs; once every UTxO is held the signer says so until the TTL passes.
func TestClientSignerReservesInputs(t *testing.T) {
	signer := newTestClientSigner(t)
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
	signer := newTestClientSigner(t)
	w := signer.wallet
	withRef := utxoAt(t, w.Address(), 1, 0, 60_000_000, nil)
	ref, err := apollo.NewScriptRef(common.PlutusV3Script([]byte{0x01}))
	require.NoError(t, err)
	withRef.Output.(*babbage.BabbageTransactionOutput).TxOutScriptRef = ref
	signer.provider = chainWith(t, w.Address(), withRef, utxoAt(t, w.Address(), 2, 4, 40_000_000, nil))
	result, err := signer.BuildAndSignPaymentTransaction(context.Background(), x402cardano.ClientSignInput{
		Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300,
	})
	require.NoError(t, err)
	assert.Equal(t, strings.Repeat("02", 32)+"#4", result.Nonce)
	decoded, err := x402cardano.DecodeTransaction(result.Transaction)
	require.NoError(t, err)
	assert.NotContains(t, decoded.Inputs, strings.Repeat("01", 32)+"#0")

	signer.provider = chainWith(t, w.Address(), withRef)
	_, err = signer.BuildAndSignPaymentTransaction(context.Background(), x402cardano.ClientSignInput{
		Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: 300,
	})
	assert.ErrorContains(t, err, "no UTxOs available")
}

func TestClientSignerBuildsPayments(t *testing.T) {
	signer := newTestClientSigner(t)
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
	signer := newTestClientSigner(t)
	ctx := context.Background()
	_, err := signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:mainnet", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000"})
	assert.ErrorContains(t, err, "configured for")
	_, err = signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "99999999999999999999999"})
	assert.ErrorContains(t, err, "invalid Cardano amount")
	bad := "zz"
	_, err = signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: scriptAddr, Asset: "lovelace", Amount: "2000000",
		Extra: map[string]interface{}{"assetTransferMethod": "script", "datum": bad}})
	assert.Error(t, err)

	signer.provider = chainWith(t, signer.wallet.Address())
	_, err = signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000"})
	assert.ErrorContains(t, err, "no UTxOs")

	_, err = NewClientSigner(ClientSignerConfig{Mnemonic: testMnemonic, Network: "cardano:preprod"})
	assert.Error(t, err)
}

func TestClientSignerRefusesUnspendableOrUnboundedPayments(t *testing.T) {
	signer := newTestClientSigner(t)
	ctx := context.Background()
	v1 := x402cardano.ClientSignInput{Network: "cardano:preprod", PayTo: scriptAddr, Asset: "lovelace", Amount: "2000000", MaxTimeoutSeconds: 300,
		Extra: map[string]interface{}{"assetTransferMethod": "script", "datum": "d8799f182aff",
			"script": map[string]interface{}{"type": "plutusV1", "code": "4d01000033222220051200120011"}}}
	_, err := signer.BuildAndSignPaymentTransaction(ctx, v1)
	assert.ErrorContains(t, err, "Plutus V1")

	for _, timeout := range []int{0, -1, MaxPaymentTimeoutSeconds + 1} {
		_, err = signer.BuildAndSignPaymentTransaction(ctx, x402cardano.ClientSignInput{
			Network: "cardano:preprod", PayTo: payToAddress, Asset: "lovelace", Amount: "5000000", MaxTimeoutSeconds: timeout})
		assert.ErrorContains(t, err, "maxTimeoutSeconds", timeout)
	}
}
