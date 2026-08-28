package svm

import (
	"testing"

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
