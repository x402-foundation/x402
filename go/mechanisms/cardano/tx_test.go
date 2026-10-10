package cardano

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// decode_vectors.json holds real signed mainnet transactions from the spec
// examples together with the TypeScript decoder's view of each.
type decodeVector struct {
	Transaction string `json:"transaction"`
	Decoded     struct {
		TxHash            string   `json:"txHash"`
		NetworkID         *int     `json:"networkId"`
		TTLSlot           string   `json:"ttlSlot"`
		ValidityStartSlot string   `json:"validityStartSlot"`
		Inputs            []string `json:"inputs"`
		Fee               string   `json:"fee"`
		SizeBytes         int      `json:"sizeBytes"`
		BalanceChanging   []string `json:"balanceChangingOperations"`
		Outputs           []struct {
			Address            string            `json:"address"`
			Coin               string            `json:"coin"`
			Assets             map[string]string `json:"assets"`
			Datum              string            `json:"datum"`
			SerializedSize     int               `json:"serializedSize"`
			HasReferenceScript bool              `json:"hasReferenceScript"`
		} `json:"outputs"`
		VkeyWitnessCount   int      `json:"vkeyWitnessCount"`
		VkeyHashes         []string `json:"vkeyHashes"`
		ScriptWitnessCount int      `json:"scriptWitnessCount"`
		RedeemerCount      int      `json:"redeemerCount"`
		SignaturesValid    bool     `json:"signaturesValid"`
		IsValid            bool     `json:"isValid"`
	} `json:"decoded"`
}

func loadDecodeVectors(t *testing.T) []decodeVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/decode_vectors.json")
	require.NoError(t, err)
	var vectors []decodeVector
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors)
	return vectors
}

func optionalSlot(s string) *uint64 {
	if s == "" {
		return nil
	}
	v, _ := strconv.ParseUint(s, 10, 64)
	return &v
}

func TestDecodeTransactionMatchesTypeScript(t *testing.T) {
	for _, vector := range loadDecodeVectors(t) {
		want := vector.Decoded
		t.Run(want.TxHash, func(t *testing.T) {
			got, err := DecodeTransaction(vector.Transaction)
			require.NoError(t, err)
			assert.Equal(t, want.TxHash, got.TxHash)
			assert.Equal(t, want.NetworkID, got.NetworkID)
			assert.Equal(t, optionalSlot(want.TTLSlot), got.TTLSlot)
			assert.Equal(t, optionalSlot(want.ValidityStartSlot), got.ValidityStartSlot)
			assert.Equal(t, want.Inputs, got.Inputs)
			assert.Equal(t, want.Fee, strconv.FormatUint(got.Fee, 10))
			assert.Equal(t, want.SizeBytes, got.SizeBytes)
			assert.ElementsMatch(t, want.BalanceChanging, got.BalanceChangingOperations)
			require.Len(t, got.Outputs, len(want.Outputs))
			for i, wantOut := range want.Outputs {
				gotOut := got.Outputs[i]
				assert.Equal(t, wantOut.Address, gotOut.Address)
				assert.Equal(t, wantOut.Coin, strconv.FormatUint(gotOut.Coin, 10))
				assets := map[string]string{}
				for unit, qty := range gotOut.Assets {
					assets[unit] = strconv.FormatUint(qty, 10)
				}
				assert.Equal(t, wantOut.Assets, assets)
				assert.Equal(t, wantOut.Datum, gotOut.Datum)
				assert.Equal(t, wantOut.SerializedSize, gotOut.SerializedSize)
				assert.Equal(t, wantOut.HasReferenceScript, gotOut.HasReferenceScript)
			}
			assert.Equal(t, want.VkeyWitnessCount, got.VkeyWitnessCount)
			assert.Equal(t, want.VkeyHashes, got.VkeyHashes)
			assert.Equal(t, want.ScriptWitnessCount, got.ScriptWitnessCount)
			assert.Equal(t, want.RedeemerCount, got.RedeemerCount)
			assert.Equal(t, want.SignaturesValid, got.SignaturesValid)
			assert.Equal(t, want.IsValid, got.IsValid)
		})
	}
}

func TestDecodeTransactionKeepsOriginalBytes(t *testing.T) {
	vector := loadDecodeVectors(t)[0]
	got, err := DecodeTransaction(vector.Transaction)
	require.NoError(t, err)
	assert.Equal(t, vector.Transaction, base64.StdEncoding.EncodeToString(got.Bytes))
}

func TestDecodeTransactionDetectsTamperedSignature(t *testing.T) {
	vector := loadDecodeVectors(t)[0]
	raw, err := base64.StdEncoding.DecodeString(vector.Transaction)
	require.NoError(t, err)
	raw[len(raw)-3] ^= 0x01 // last signature byte, before is_valid and aux data
	got, err := DecodeTransactionCBOR(raw)
	require.NoError(t, err)
	assert.False(t, got.SignaturesValid)
}

func TestDecodeTransactionBytesRejectsNonCanonicalBase64(t *testing.T) {
	_, err := DecodeTransactionBytes("hKQ")
	assert.Error(t, err)
	_, err = DecodeTransactionBytes("")
	assert.Error(t, err)
}

func TestDecodeTransactionRejectsGarbage(t *testing.T) {
	_, err := DecodeTransactionCBOR([]byte{0x00, 0x00, 0x08, 0x01})
	assert.Error(t, err)
	_, err = DecodeTransactionCBOR([]byte{0x83, 0x01, 0x02, 0x03})
	assert.Error(t, err)
}

func TestContainerLength(t *testing.T) {
	cases := map[string]struct {
		raw  []byte
		want int
	}{
		"empty array":       {[]byte{0x80}, 0},
		"array":             {[]byte{0x82, 0x01, 0x02}, 2},
		"small map":         {[]byte{0xa2, 0x01, 0x02, 0x03, 0x04}, 2},
		"indefinite map":    {[]byte{0xbf, 0x01, 0x02, 0x03, 0x04, 0xff}, 2},
		"empty indef map":   {[]byte{0xbf, 0xff}, 0},
		"map with 1-byte n": {append([]byte{0xb8, 0x18}, mapPairs(24)...), 24},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := containerLength(tc.raw)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
	_, err := containerLength([]byte{0x01})
	assert.Error(t, err)
}

func mapPairs(n int) []byte {
	var out []byte
	for i := 0; i < n; i++ {
		out = append(out, byte(i), 0x00)
	}
	return out
}
