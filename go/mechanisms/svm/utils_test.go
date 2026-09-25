package svm

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetStablecoinAddress(t *testing.T) {
	tests := []struct {
		name    string
		symbol  string
		network string
		want    string
	}{
		{name: "USDC on mainnet", symbol: "USDC", network: SolanaMainnetCAIP2, want: USDCMainnetAddress},
		{name: "USDC on devnet", symbol: "USDC", network: SolanaDevnetCAIP2, want: USDCDevnetAddress},
		{name: "PYUSD on devnet", symbol: "PYUSD", network: SolanaDevnetCAIP2, want: PYUSDDevnetAddress},
		{name: "lowercase symbols resolve", symbol: "usdg", network: SolanaTestnetCAIP2, want: USDGTestnetAddress},
		{name: "V1 network names resolve", symbol: "USDC", network: SolanaDevnetV1, want: USDCDevnetAddress},
		{
			name:    "a mainnet-only stablecoin falls back to mainnet",
			symbol:  "USDT",
			network: SolanaDevnetCAIP2,
			want:    USDTMainnetAddress,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			address, err := GetStablecoinAddress(test.symbol, test.network)

			require.NoError(t, err)
			assert.Equal(t, test.want, address)
		})
	}
}

func TestGetStablecoinAddressRejectsUnknownInputs(t *testing.T) {
	_, err := GetStablecoinAddress("WIF", SolanaDevnetCAIP2)
	require.ErrorContains(t, err, "unsupported stablecoin: WIF")

	_, err = GetStablecoinAddress("USDC", "ethereum")
	require.Error(t, err, "a non-SVM network has no stablecoin mints")
}

func TestGetStablecoinSymbol(t *testing.T) {
	symbol, ok := GetStablecoinSymbol("PYUSD")
	assert.True(t, ok)
	assert.Equal(t, "PYUSD", symbol)

	symbol, ok = GetStablecoinSymbol(CASHMainnetAddress)
	assert.True(t, ok, "known mints resolve back to their symbol")
	assert.Equal(t, "CASH", symbol)

	_, ok = GetStablecoinSymbol("So11111111111111111111111111111111111111112")
	assert.False(t, ok, "unregistered mints have no symbol")
}

// The token program is sealed into the channel at open, so a Token-2022 mint
// advertised as SPL Token fails onchain.
func TestGetStablecoinTokenProgram(t *testing.T) {
	tests := []struct {
		name     string
		currency string
		want     string
	}{
		{name: "USDC symbol", currency: "USDC", want: TokenProgramAddress},
		{name: "USDC mint", currency: USDCDevnetAddress, want: TokenProgramAddress},
		{name: "USDT is SPL Token", currency: "USDT", want: TokenProgramAddress},
		{name: "USDG symbol", currency: "USDG", want: Token2022ProgramAddress},
		{name: "PYUSD mint", currency: PYUSDDevnetAddress, want: Token2022ProgramAddress},
		{name: "CASH mint", currency: CASHMainnetAddress, want: Token2022ProgramAddress},
		{name: "unregistered mints default to SPL Token", currency: "notamint", want: TokenProgramAddress},
		{name: "SOL is not a stablecoin", currency: "SOL", want: TokenProgramAddress},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, GetStablecoinTokenProgram(test.currency, SolanaDevnetCAIP2))
		})
	}
}

// A symbol added to one registry map but not the other must still resolve to a
// real program: callers parse this return value, and an empty string is not an
// address. TestStablecoinRegistryIsInternallyConsistent keeps the maps in step;
// this pins the behavior if one ever drifts.
func TestGetStablecoinTokenProgramFallsBackOnAnIncompleteRegistry(t *testing.T) {
	StablecoinMints["TESTUSD"] = map[string]string{networkKeyMainnet: USDCMainnetAddress}
	t.Cleanup(func() { delete(StablecoinMints, "TESTUSD") })

	assert.Equal(t, TokenProgramAddress, GetStablecoinTokenProgram("TESTUSD", SolanaDevnetCAIP2))
}

// Every registry mint shares one precision; GetAssetDecimals depends on it.
func TestStablecoinRegistryIsInternallyConsistent(t *testing.T) {
	for symbol, mints := range StablecoinMints {
		assert.Contains(t, mints, networkKeyMainnet, "%s needs a mainnet mint to fall back to", symbol)
		assert.Contains(t, StablecoinTokenPrograms, symbol, "%s needs a token program", symbol)

		for _, mint := range mints {
			assert.True(t, ValidateSolanaAddress(mint), "%s mint %s must be a valid address", symbol, mint)
		}
	}

	for symbol, program := range StablecoinTokenPrograms {
		assert.Contains(t, StablecoinMints, symbol, "%s has a token program but no mint", symbol)
		assert.Contains(t,
			[]string{TokenProgramAddress, Token2022ProgramAddress}, program,
			"%s must use a supported token program", symbol,
		)
	}
}

func TestIsAcceptedTransactionVersion(t *testing.T) {
	assert.True(t, IsAcceptedTransactionVersion(solana.MessageVersionLegacy), "legacy stays accepted for backward compatibility")
	assert.True(t, IsAcceptedTransactionVersion(solana.MessageVersionV0))
	// Anything the verifiers do not model is rejected, whatever its number.
	assert.False(t, IsAcceptedTransactionVersion(solana.MessageVersion(2)))
	assert.False(t, IsAcceptedTransactionVersion(solana.MessageVersion(-1)))
	assert.False(t, IsAcceptedTransactionVersion(solana.MessageVersion(127)))
}

func TestAdvertisedTransactionVersionsMarshalsToVersionZeroOnly(t *testing.T) {
	encoded, err := json.Marshal(map[string]interface{}{ExtraTransactionVersions: AdvertisedTransactionVersions})
	require.NoError(t, err)
	assert.JSONEq(t, `{"transactionVersions":[0]}`, string(encoded), "legacy is accepted but never advertised")
}

func TestResolveTransactionVersion(t *testing.T) {
	tests := []struct {
		name    string
		extra   map[string]interface{}
		wantErr bool
	}{
		{name: "nil extra selects v0", extra: nil},
		{name: "absent field selects v0", extra: map[string]interface{}{"feePayer": "x"}},
		{name: "malformed field is unsupported", extra: map[string]interface{}{ExtraTransactionVersions: "0"}, wantErr: true},
		{name: "JSON-decoded [0] selects v0", extra: map[string]interface{}{ExtraTransactionVersions: []interface{}{float64(0)}}},
		{name: "JSON-decoded [\"legacy\",0] selects v0", extra: map[string]interface{}{ExtraTransactionVersions: []interface{}{"legacy", float64(0)}}},
		{name: "JSON-decoded [1,0] selects v0", extra: map[string]interface{}{ExtraTransactionVersions: []interface{}{float64(1), float64(0)}}},
		{name: "in-process []int{0} selects v0", extra: map[string]interface{}{ExtraTransactionVersions: []int{0}}},
		{name: "in-process []interface{}{0} selects v0", extra: map[string]interface{}{ExtraTransactionVersions: []interface{}{0}}},
		{name: "advertised value selects v0", extra: map[string]interface{}{ExtraTransactionVersions: AdvertisedTransactionVersions}},
		{name: "[\"legacy\"] alone is unsupported: clients never build legacy", extra: map[string]interface{}{ExtraTransactionVersions: []interface{}{"legacy"}}, wantErr: true},
		{name: "[1] alone is unsupported", extra: map[string]interface{}{ExtraTransactionVersions: []interface{}{float64(1)}}, wantErr: true},
		{name: "[] is unsupported", extra: map[string]interface{}{ExtraTransactionVersions: []interface{}{}}, wantErr: true},
		{name: "in-process []int{1} is unsupported", extra: map[string]interface{}{ExtraTransactionVersions: []int{1}}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			version, err := ResolveTransactionVersion(test.extra)
			if test.wantErr {
				require.Error(t, err)
				assert.True(t, strings.HasPrefix(err.Error(), ErrUnsupportedTransactionVersion), err.Error())
				return
			}
			require.NoError(t, err)
			assert.Equal(t, solana.MessageVersionV0, version)
		})
	}
}

// solana-go 1.14 reads any first message byte >= 0x7f as a versioned prefix and
// stores `byte - 127` as the version without validating it, so a message tagged
// 0x81 decodes with version 2. The verifiers must refuse it rather than run
// their v0-shaped checks against it.
func TestDecodeTransactionSurfacesUnknownMessageVersions(t *testing.T) {
	payer := solana.NewWallet()
	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(solana.SystemProgramID)).
		SetFeePayer(payer.PublicKey()).
		AddInstruction(solana.NewInstruction(solana.MemoProgramID, solana.AccountMetaSlice{}, []byte("x"))).
		Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(payer.PublicKey()) {
			return &payer.PrivateKey
		}
		return nil
	})
	require.NoError(t, err)

	raw, err := tx.MarshalBinary()
	require.NoError(t, err)
	// Wire layout: compact signature count (1 byte here), signatures, message.
	versionOffset := 1 + 64*len(tx.Signatures)
	require.Equal(t, byte(0x80), raw[versionOffset], "v0 prefix expected before tampering")
	raw[versionOffset] = 0x81

	decoded, err := DecodeTransaction(base64.StdEncoding.EncodeToString(raw))
	require.NoError(t, err)
	assert.Equal(t, solana.MessageVersion(2), decoded.Message.GetVersion())
	assert.False(t, IsAcceptedTransactionVersion(decoded.Message.GetVersion()))
}
