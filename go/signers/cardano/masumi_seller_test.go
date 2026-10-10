package cardano

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano/exact/masumi"
)

// masumi_seller_vectors.json was produced by the TypeScript toMasumiSellerSigner.
func TestMasumiSellerSignerMatchesTypeScript(t *testing.T) {
	raw, err := os.ReadFile("testdata/masumi_seller_vectors.json")
	require.NoError(t, err)
	var vectors []struct {
		Mnemonic      string `json:"mnemonic"`
		Network       string `json:"network"`
		AccountIndex  uint32 `json:"accountIndex"`
		SellerAddress string `json:"sellerAddress"`
		Digest        string `json:"digest"`
		Key           string `json:"key"`
		Signature     string `json:"signature"`
	}
	require.NoError(t, json.Unmarshal(raw, &vectors))
	for _, v := range vectors {
		t.Run(v.Network, func(t *testing.T) {
			address, signer, err := NewMasumiSellerSigner(v.Mnemonic, v.Network, v.AccountIndex)
			require.NoError(t, err)
			assert.Equal(t, v.SellerAddress, address)
			auth, err := signer(context.Background(), address, v.Digest)
			require.NoError(t, err)
			assert.Equal(t, v.Key, auth.Key)
			assert.Equal(t, v.Signature, auth.Signature)
			assert.True(t, masumi.VerifySellerTermsSignature(auth.Key, auth.Signature, address, v.Digest))
		})
	}
	_, _, err = NewMasumiSellerSigner("bad", "cardano:preprod", 0)
	assert.Error(t, err)
}
