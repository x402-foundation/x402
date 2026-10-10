package cardano

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

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
			wallet, err := NewWalletFromMnemonic(v.Mnemonic, v.Network, v.AccountIndex)
			require.NoError(t, err)
			assert.Equal(t, v.Address, wallet.Address())
			assert.Equal(t, v.PaymentPublicKey, hex.EncodeToString(wallet.PaymentPublicKey()))
			message, _ := hex.DecodeString(v.Message)
			signature := wallet.SignTxBody(message)
			assert.Equal(t, v.Signature, hex.EncodeToString(signature))
			assert.True(t, ed25519.Verify(wallet.PaymentPublicKey(), message, signature))
		})
	}
}

func TestWalletNormalizesMnemonic(t *testing.T) {
	a, err := NewWalletFromMnemonic("test walk nut penalty hip pave soap entry language right filter choice", "cardano:preprod", 0)
	require.NoError(t, err)
	b, err := NewWalletFromMnemonic("  Test  WALK nut penalty hip pave soap entry language right filter\tchoice ", "cip34:0-1", 0)
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
			_, err := NewWalletFromMnemonic(mnemonic, "cardano:preprod", 0)
			assert.Error(t, err)
		})
	}
	_, err := NewWalletFromMnemonic("test walk nut penalty hip pave soap entry language right filter choice", "solana:mainnet", 0)
	assert.Error(t, err)
	_, err = NewWalletFromMnemonic("test walk nut penalty hip pave soap entry language right filter choice", "cardano:preprod", hardened)
	assert.Error(t, err)
}

// The embedded wordlist is the canonical BIP-0039 English list.
func TestBIP39Wordlist(t *testing.T) {
	sum := sha256.Sum256([]byte(bip39English))
	assert.Equal(t, "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda", hex.EncodeToString(sum[:]))
	assert.Len(t, strings.Fields(bip39English), 2048)
	assert.Len(t, bip39Index, 2048, "words are unique")
}
