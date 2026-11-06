package cardano

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/blinklabs-io/gouroboros/ledger/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// wallet_vectors.json was produced with Evolution, the derivation behind the
// TypeScript reference signer.
type walletVector struct {
	Mnemonic         string `json:"mnemonic"`
	Network          string `json:"network"`
	AccountIndex     uint32 `json:"accountIndex"`
	Address          string `json:"address"`
	PaymentPublicKey string `json:"paymentPublicKey"`
	Message          string `json:"message"`
	Signature        string `json:"signature"`
}

func TestWalletMatchesTypeScript(t *testing.T) {
	raw, err := os.ReadFile("testdata/wallet_vectors.json")
	require.NoError(t, err)
	var vectors []walletVector
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors)
	for _, v := range vectors {
		t.Run(v.Network+"/"+v.Address[:20], func(t *testing.T) {
			wallet, err := NewWallet(v.Mnemonic, v.Network, v.AccountIndex)
			require.NoError(t, err)
			assert.Equal(t, v.Address, wallet.Address().String())
			message, _ := hex.DecodeString(v.Message)
			require.Len(t, message, 32)
			witness, err := wallet.SignTxBody(common.NewBlake2b256(message))
			require.NoError(t, err)
			assert.Equal(t, v.PaymentPublicKey, hex.EncodeToString(witness.Vkey))
			assert.Equal(t, v.Signature, hex.EncodeToString(witness.Signature))
			assert.True(t, ed25519.Verify(witness.Vkey, message, witness.Signature))
		})
	}
}

func TestWalletNormalizesMnemonic(t *testing.T) {
	a, err := NewWallet("test walk nut penalty hip pave soap entry language right filter choice", "cardano:preprod", 0)
	require.NoError(t, err)
	b, err := NewWallet("  Test  WALK nut penalty hip pave soap entry language right filter\tchoice ", "cip34:0-1", 0)
	require.NoError(t, err)
	assert.Equal(t, a.Address(), b.Address())
}

func TestWalletRejectsInvalidMnemonics(t *testing.T) {
	cases := map[string]string{
		"bad checksum": "test walk nut penalty hip pave soap entry language right filter filter",
		"unknown word": "test walk nut penalty hip pave soap entry language right filter xyzzy",
		"wrong length": "test walk nut penalty hip pave soap entry language right filter",
		"empty":        "",
		"too long":     strings.Repeat("zoo ", 27),
	}
	for name, mnemonic := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := NewWallet(mnemonic, "cardano:preprod", 0)
			assert.Error(t, err)
		})
	}
	_, err := NewWallet("test walk nut penalty hip pave soap entry language right filter choice", "solana:mainnet", 0)
	assert.Error(t, err)
	_, err = NewWallet("test walk nut penalty hip pave soap entry language right filter choice", "cardano:preprod", hardened)
	assert.Error(t, err)
}
