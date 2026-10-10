package script

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/cardano"
)

const minimalPlutusV3 = "4d01000033222220051200120011"

// script_vectors.json was produced with the TypeScript SDK (Evolution
// applyParamsToScript + ScriptHash), the reference for these hashes.
type scriptVector struct {
	Name       string               `json:"name"`
	Type       string               `json:"type"`
	Code       string               `json:"code"`
	Parameters map[string]Parameter `json:"parameters"`
	Address    string               `json:"address"`
	ScriptHash string               `json:"scriptHash"`
}

func loadVectors(t *testing.T) []scriptVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/script_vectors.json")
	require.NoError(t, err)
	var vectors []scriptVector
	require.NoError(t, json.Unmarshal(raw, &vectors))
	return vectors
}

func TestDeriveScriptHashMatchesTypeScript(t *testing.T) {
	for _, v := range loadVectors(t) {
		if v.Code == "" {
			continue
		}
		t.Run(v.Name, func(t *testing.T) {
			got, err := DeriveScriptHash(Extra{Script: &Descriptor{Type: v.Type, Code: v.Code}, Parameters: v.Parameters})
			require.NoError(t, err)
			assert.Equal(t, v.ScriptHash, got)
		})
	}
}

func TestAddressMatches(t *testing.T) {
	var address, hash string
	for _, v := range loadVectors(t) {
		if v.Address != "" {
			address, hash = v.Address, v.ScriptHash
		}
	}
	require.NotEmpty(t, address)

	assert.True(t, AddressMatches(Extra{Script: &Descriptor{Type: "plutusV3", Code: minimalPlutusV3}}, address))
	assert.True(t, AddressMatches(Extra{ScriptHash: hash}, address))
	assert.False(t, AddressMatches(Extra{ScriptHash: strings.Repeat("00", 28)}, address))
	assert.False(t, AddressMatches(Extra{}, address))
	assert.False(t, AddressMatches(Extra{
		Script:     &Descriptor{Type: "plutusV3", Code: minimalPlutusV3},
		Parameters: map[string]Parameter{"p1": {Type: "bigint", Value: "42"}},
	}, address), "applying a parameter changes the address")
	assert.False(t, AddressMatches(Extra{ScriptHash: hash}, "addr1vy3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs44r503"), "key payTo")
}

func TestDeriveScriptHashRejectsInvalidInput(t *testing.T) {
	code := &Descriptor{Type: "plutusV3", Code: minimalPlutusV3}
	tooMany := map[string]Parameter{}
	for i := 0; i <= cardano.MaxScriptParameters; i++ {
		tooMany[strings.Repeat("p", i+1)] = Parameter{Type: "integer", Value: "1"}
	}
	cases := map[string]Extra{
		"oversized code":      {Script: &Descriptor{Type: "plutusV3", Code: strings.Repeat("00", cardano.MaxScriptBytes+1)}},
		"odd hex":             {Script: &Descriptor{Type: "plutusV3", Code: "4d0"}},
		"unknown type":        {Script: &Descriptor{Type: "plutusV9", Code: minimalPlutusV3}},
		"too many parameters": {Script: code, Parameters: tooMany},
		"bad scriptHash":      {ScriptHash: "ABC"},
		"empty":               {},
		"fractional integer":  {Script: code, Parameters: map[string]Parameter{"p": {Type: "integer", Value: 1.5}}},
		"unsafe integer":      {Script: code, Parameters: map[string]Parameter{"p": {Type: "integer", Value: float64(1 << 54)}}},
		"leading zero":        {Script: code, Parameters: map[string]Parameter{"p": {Type: "integer", Value: "01"}}},
		"exponent":            {Script: code, Parameters: map[string]Parameter{"p": {Type: "integer", Value: "1e3"}}},
		"plus sign":           {Script: code, Parameters: map[string]Parameter{"p": {Type: "integer", Value: "+1"}}},
		"negative zero":       {Script: code, Parameters: map[string]Parameter{"p": {Type: "integer", Value: "-0"}}},
		"too many digits":     {Script: code, Parameters: map[string]Parameter{"p": {Type: "integer", Value: strings.Repeat("9", 129)}}},
		"uppercase bytes":     {Script: code, Parameters: map[string]Parameter{"p": {Type: "bytes", Value: "AB"}}},
		"bool as string":      {Script: code, Parameters: map[string]Parameter{"p": {Type: "boolean", Value: "true"}}},
		"unsupported list":    {Script: code, Parameters: map[string]Parameter{"p": {Type: "list", Value: []interface{}{}}}},
		"non-string string":   {Script: code, Parameters: map[string]Parameter{"p": {Type: "string", Value: 1.0}}},
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := DeriveScriptHash(extra)
			assert.Error(t, err)
		})
	}
}

func TestDeriveScriptHashAcceptsSafeFloatIntegers(t *testing.T) {
	fromString, err := DeriveScriptHash(Extra{Script: &Descriptor{Type: "plutusV3", Code: minimalPlutusV3}, Parameters: map[string]Parameter{"p": {Type: "bigint", Value: "42"}}})
	require.NoError(t, err)
	fromNumber, err := DeriveScriptHash(Extra{Script: &Descriptor{Type: "plutusV3", Code: minimalPlutusV3}, Parameters: map[string]Parameter{"p": {Type: "bigint", Value: float64(42)}}})
	require.NoError(t, err)
	assert.Equal(t, fromString, fromNumber)
}

func TestParseExtra(t *testing.T) {
	extra, err := ParseExtra(map[string]interface{}{
		"assetTransferMethod": "script",
		"script":              map[string]interface{}{"type": "plutusV3", "code": minimalPlutusV3},
		"parameters":          map[string]interface{}{"p": map[string]interface{}{"type": "integer", "value": float64(1)}},
		"datum":               "d8799f182aff",
	})
	require.NoError(t, err)
	assert.Equal(t, "plutusV3", extra.Script.Type)
	assert.Equal(t, float64(1), extra.Parameters["p"].Value)
	require.NotNil(t, extra.Datum)
	_, err = ParseExtra(map[string]interface{}{"script": "nope"})
	assert.Error(t, err)
}

func TestInlineDatum(t *testing.T) {
	got, err := InlineDatum(Extra{})
	require.NoError(t, err)
	assert.Nil(t, got)
	datum := "d8799f182aff"
	got, err = InlineDatum(Extra{Datum: &datum})
	require.NoError(t, err)
	assert.Equal(t, []byte{0xd8, 0x79, 0x9f, 0x18, 0x2a, 0xff}, got, "datum bytes are preserved exactly")
	for _, bad := range []string{"", "zz", "d87", strings.Repeat("00", cardano.MaxDatumBytes+1), "ff"} {
		_, err := InlineDatum(Extra{Datum: &bad})
		assert.Error(t, err, bad)
	}
}

// datum_vectors.json records how Evolution (TypeScript) re-encodes inline datums.
func TestCanonicalDatumMatchesEvolution(t *testing.T) {
	raw, err := os.ReadFile("testdata/datum_vectors.json")
	require.NoError(t, err)
	var vectors []struct {
		Input     string `json:"input"`
		Evolution string `json:"evolution"`
	}
	require.NoError(t, json.Unmarshal(raw, &vectors))
	for _, v := range vectors {
		input, _ := hex.DecodeString(v.Input)
		got, err := CanonicalDatum(input)
		require.NoError(t, err, v.Input)
		assert.Equal(t, v.Evolution, hex.EncodeToString(got), v.Input)
	}
	_, err = CanonicalDatum([]byte{0xff})
	assert.Error(t, err)
}

func TestJSKeyOrder(t *testing.T) {
	keys := []string{"b", "10", "a", "2", "01", "0"}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if jsKeyLess(keys[j], keys[i]) {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	assert.Equal(t, []string{"0", "2", "10", "01", "a", "b"}, keys)
}
