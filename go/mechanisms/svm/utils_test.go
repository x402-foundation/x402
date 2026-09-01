package svm

import (
	"encoding/base64"
	"math"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
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

func memoInstruction(data string) solana.Instruction {
	return solana.NewInstruction(
		solana.MustPublicKeyFromBase58(MemoProgramAddress),
		solana.AccountMetaSlice{},
		[]byte(data),
	)
}

func TestIsSupportedTransactionVersion(t *testing.T) {
	assert.True(t, IsSupportedTransactionVersion(solana.MessageVersionLegacy))
	assert.True(t, IsSupportedTransactionVersion(solana.MessageVersionV0))
	assert.True(t, IsSupportedTransactionVersion(solana.MessageVersionV1))
	assert.False(t, IsSupportedTransactionVersion(solana.MessageVersionV1+1))
	assert.False(t, IsSupportedTransactionVersion(solana.MessageVersion(127)))
}

// A transaction v1 message deserializes completely, inline compute budget config
// included, and carries no ComputeBudget instruction for an instruction scan to
// find. The config checks are the whole of the fee policy on such a message.
func TestDecodeTransactionAcceptsATransactionV1Message(t *testing.T) {
	tx, err := solana.NewTransaction(
		[]solana.Instruction{memoInstruction("v1")},
		solana.Hash{},
		solana.TransactionPayer(solana.NewWallet().PrivateKey.PublicKey()),
		solana.TransactionV1Config(solana.TransactionConfig{}.
			WithComputeUnitLimit(200_000).
			WithPriorityFee(1_000_000_000)),
	)
	require.NoError(t, err)
	wire, err := tx.MarshalBinary()
	require.NoError(t, err)

	decoded, err := DecodeTransaction(base64.StdEncoding.EncodeToString(wire))

	require.NoError(t, err)
	assert.Equal(t, solana.MessageVersionV1, decoded.Message.GetVersion())
	assert.True(t, IsSupportedTransactionVersion(decoded.Message.GetVersion()))
	assert.Equal(t, uint32(200_000), *decoded.Message.TransactionConfig.ComputeUnitLimit)
	assert.Equal(t, uint64(1_000_000_000), *decoded.Message.TransactionConfig.PriorityFee)
	assert.Nil(t, decoded.Message.TransactionConfig.LoadedAccountsDataSizeLimit)
	for _, instruction := range decoded.Message.Instructions {
		program, err := decoded.Message.Program(instruction.ProgramIDIndex)
		require.NoError(t, err)
		assert.False(t, program.Equals(solana.ComputeBudget),
			"a v1 transaction keeps its compute budget in the message config, out of reach of an instruction scan")
	}
}

func TestCheckV1TransactionConfig(t *testing.T) {
	// 5,000,000 micro-lamports per CU over 20,000 CUs is 100,000 lamports.
	const perCU = uint64(5_000_000)
	const cuLimit = uint32(20_000)
	valid := solana.TransactionConfig{}.
		WithComputeUnitLimit(cuLimit).
		WithLoadedAccountsDataSizeLimit(65_536)

	tests := []struct {
		name            string
		config          solana.TransactionConfig
		maxComputeUnits *uint32
		maxPerCU        uint64
		want            V1ConfigViolation
	}{
		{
			name:     "empty config is missing its compute unit limit",
			config:   solana.TransactionConfig{},
			maxPerCU: perCU,
			want:     V1ConfigComputeUnitLimitMissing,
		},
		{
			name:     "a priority fee alone is missing its compute unit limit",
			config:   solana.TransactionConfig{}.WithPriorityFee(1),
			maxPerCU: perCU,
			want:     V1ConfigComputeUnitLimitMissing,
		},
		{
			name:     "a zero compute unit limit is treated as missing",
			config:   solana.TransactionConfig{}.WithComputeUnitLimit(0),
			maxPerCU: perCU,
			want:     V1ConfigComputeUnitLimitMissing,
		},
		{
			name:            "a compute unit limit above the operator cap is rejected",
			config:          solana.TransactionConfig{}.WithComputeUnitLimit(cuLimit + 1),
			maxComputeUnits: pointerTo(cuLimit),
			maxPerCU:        perCU,
			want:            V1ConfigComputeUnitLimitTooHigh,
		},
		{
			name:            "a compute unit limit at the operator cap is accepted",
			config:          valid,
			maxComputeUnits: pointerTo(cuLimit),
			maxPerCU:        perCU,
		},
		{
			name:     "an absent loaded accounts data size limit is rejected",
			config:   solana.TransactionConfig{}.WithComputeUnitLimit(cuLimit),
			maxPerCU: perCU,
			want:     V1ConfigLoadedAccountsDataSizeLimitMissing,
		},
		{
			name: "a zero loaded accounts data size limit is treated as missing",
			config: solana.TransactionConfig{}.
				WithComputeUnitLimit(cuLimit).
				WithLoadedAccountsDataSizeLimit(0),
			maxPerCU: perCU,
			want:     V1ConfigLoadedAccountsDataSizeLimitMissing,
		},
		{
			name:     "a priority fee at exactly the normalized cap is accepted",
			config:   valid.WithPriorityFee(100_000),
			maxPerCU: perCU,
		},
		{
			name:     "a priority fee one lamport over the normalized cap is rejected",
			config:   valid.WithPriorityFee(100_001),
			maxPerCU: perCU,
			want:     V1ConfigPriorityFeeTooHigh,
		},
		{
			name:     "an absent priority fee is accepted even at a zero cap",
			config:   valid,
			maxPerCU: 0,
		},
		{
			name:     "a heap size is allowed and uncapped",
			config:   valid.WithHeapSize(256 * 1024),
			maxPerCU: perCU,
		},
		{
			name: "a loaded accounts data size limit is uncapped in magnitude",
			config: solana.TransactionConfig{}.
				WithComputeUnitLimit(cuLimit).
				WithLoadedAccountsDataSizeLimit(math.MaxUint32),
			maxPerCU: perCU,
		},
		{
			// 18_446_744_073_710 * 1e6 exceeds 2^64 by 448_384, so a 64-bit
			// product wraps to a value far below the 100,000 lamport ceiling and
			// would admit a fee of 18 million SOL.
			name:     "a priority fee whose normalization wraps 64 bits is rejected",
			config:   valid.WithPriorityFee(18_446_744_073_710),
			maxPerCU: perCU,
			want:     V1ConfigPriorityFeeTooHigh,
		},
		{
			name:     "the largest representable priority fee is rejected",
			config:   valid.WithPriorityFee(math.MaxUint64),
			maxPerCU: perCU,
			want:     V1ConfigPriorityFeeTooHigh,
		},
		{
			// The cap side is the product that exceeds 2^64 here; a fee below the
			// true 128-bit ceiling must not be rejected for it.
			name:     "a cap wide enough to overflow still admits a fee below it",
			config:   valid.WithPriorityFee(math.MaxUint64 / 1_000_000),
			maxPerCU: math.MaxUint64,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assert.Equal(t, test.want, CheckV1TransactionConfig(test.config, test.maxComputeUnits, test.maxPerCU))
		})
	}
}

// The payer lookup scans instructions for the transfer authority, so it must
// find one at index 0 of a v1 message just as it does at index 2 of a v0 one.
func TestGetTokenPayerFromTransactionOnATransactionV1Message(t *testing.T) {
	owner := solana.NewWallet().PrivateKey.PublicKey()
	mint := solana.NewWallet().PrivateKey.PublicKey()
	source, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	destination, _, err := solana.FindAssociatedTokenAddress(solana.NewWallet().PrivateKey.PublicKey(), mint)
	require.NoError(t, err)

	transferIx, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(1000).
		SetDecimals(6).
		SetSourceAccount(source).
		SetMintAccount(mint).
		SetDestinationAccount(destination).
		SetOwnerAccount(owner).
		ValidateAndBuild()
	require.NoError(t, err)

	tx, err := solana.NewTransaction(
		[]solana.Instruction{transferIx},
		solana.Hash{},
		solana.TransactionPayer(solana.NewWallet().PrivateKey.PublicKey()),
		solana.TransactionV1Config(solana.TransactionConfig{}.WithComputeUnitLimit(20_000)),
	)
	require.NoError(t, err)

	payer, err := GetTokenPayerFromTransaction(tx)

	require.NoError(t, err)
	assert.Equal(t, owner.String(), payer)
}

func pointerTo[T any](value T) *T {
	return &value
}

// A version beyond the ones solana-go implements fails to deserialize at all,
// so it is rejected before the allowlist is consulted. Both layers fail closed;
// neither is relied upon alone.
func TestDecodeTransactionRejectsAVersionBeyondV1(t *testing.T) {
	tx, err := solana.NewTransaction(
		[]solana.Instruction{memoInstruction("future")},
		solana.Hash{},
		solana.TransactionPayer(solana.NewWallet().PrivateKey.PublicKey()),
	)
	require.NoError(t, err)
	_, err = tx.Message.SetVersion(solana.MessageVersionV0)
	require.NoError(t, err)

	message, err := tx.Message.MarshalBinary()
	require.NoError(t, err)
	wire, err := tx.MarshalBinary()
	require.NoError(t, err)
	prefix := len(wire) - len(message)
	require.Equal(t, byte(0x80), wire[prefix], "expected a versioned message prefix byte at offset %d", prefix)
	wire[prefix] = 0x85

	_, err = DecodeTransaction(base64.StdEncoding.EncodeToString(wire))

	require.ErrorContains(t, err, "unsupported message version: 5")
}
