package svm

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func memoTestInstruction() solana.Instruction {
	return solana.NewInstruction(solana.MustPublicKeyFromBase58(MemoProgramAddress), solana.AccountMetaSlice{}, []byte("x"))
}

func encodeForTest(t *testing.T, tx *solana.Transaction) string {
	t.Helper()
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	raw, err := tx.MarshalBinary()
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(raw)
}

func TestBuildClientTransaction(t *testing.T) {
	feePayer := solana.NewWallet().PublicKey()
	blockhash := solana.Hash(solana.SystemProgramID)

	v0, err := BuildClientTransaction(solana.MessageVersionV0, feePayer, blockhash, []solana.Instruction{memoTestInstruction()}, 20_000, 1)
	require.NoError(t, err)
	assert.Equal(t, solana.MessageVersionV0, v0.Message.GetVersion())
	require.Len(t, v0.Message.Instructions, 3, "SetComputeUnitLimit + SetComputeUnitPrice + memo")
	assert.True(t, v0.Message.TransactionConfig.IsEmpty())

	v0NoBudget, err := BuildClientTransaction(solana.MessageVersionV0, feePayer, blockhash, []solana.Instruction{memoTestInstruction()}, 0, 0)
	require.NoError(t, err)
	require.Len(t, v0NoBudget.Message.Instructions, 1, "zero values omit both ComputeBudget instructions")

	v1, err := BuildClientTransaction(solana.MessageVersionV1, feePayer, blockhash, []solana.Instruction{memoTestInstruction()}, 20_000, 1)
	require.NoError(t, err)
	assert.Equal(t, solana.MessageVersionV1, v1.Message.GetVersion())
	require.Len(t, v1.Message.Instructions, 1, "no ComputeBudget instructions in v1")
	config := v1.Message.TransactionConfig
	require.NotNil(t, config.ComputeUnitLimit)
	assert.Equal(t, uint32(20_000), *config.ComputeUnitLimit)
	require.NotNil(t, config.LoadedAccountsDataSizeLimit)
	assert.Equal(t, DefaultLoadedAccountsDataSizeLimit, *config.LoadedAccountsDataSizeLimit)
	require.NotNil(t, config.PriorityFee)
	assert.Equal(t, uint64(1), *config.PriorityFee)
	// 50 microlamports/CU at 20,000 CU is exactly the 1-lamport fee.
	assert.Equal(t, TransactionV1ConfigOK, ValidateTransactionV1Config(&v1.Message, 20_000, 50))
	assert.Equal(t, TransactionV1PriorityFeeTooHigh, ValidateTransactionV1Config(&v1.Message, 20_000, 49))

	noFee, err := BuildClientTransaction(solana.MessageVersionV1, feePayer, blockhash, []solana.Instruction{memoTestInstruction()}, 20_000, 0)
	require.NoError(t, err)
	assert.Nil(t, noFee.Message.TransactionConfig.PriorityFee)

	_, err = BuildClientTransaction(solana.MessageVersionV1, feePayer, blockhash, []solana.Instruction{memoTestInstruction()}, 0, 1)
	require.ErrorContains(t, err, "computeUnitLimit")

	_, err = BuildClientTransaction(solana.MessageVersionLegacy, feePayer, blockhash, []solana.Instruction{memoTestInstruction()}, 20_000, 1)
	require.ErrorContains(t, err, ErrUnsupportedTransactionVersion, "clients never build legacy")
}

func TestPriorityFeeLamports(t *testing.T) {
	for _, test := range []struct {
		units uint32
		price uint64
		want  uint64
	}{
		{units: 20_000, price: 1, want: 1},
		{units: 200_000, price: 5_000_000, want: 1_000_000},
		{units: 1_000_000, price: 1, want: 1},
		{units: 1_000_001, price: 1, want: 2},
		{units: 0, price: 5_000_000, want: 0},
	} {
		fee, err := PriorityFeeLamports(test.units, test.price)
		require.NoError(t, err)
		assert.Equal(t, test.want, fee, "%d CU at %d microlamports", test.units, test.price)
	}
	_, err := PriorityFeeLamports(math.MaxUint32, math.MaxUint64)
	require.Error(t, err)
}

func TestValidateTransactionV1Config(t *testing.T) {
	base := solana.TransactionConfig{}.WithComputeUnitLimit(20_000).WithLoadedAccountsDataSizeLimit(1)
	message := func(config solana.TransactionConfig) *solana.Message {
		return &solana.Message{TransactionConfig: config}
	}
	for _, test := range []struct {
		name   string
		config solana.TransactionConfig
		want   TransactionV1ConfigViolation
	}{
		{name: "no priority fee", config: base, want: TransactionV1ConfigOK},
		{name: "fee at the cap", config: base.WithPriorityFee(100_000), want: TransactionV1ConfigOK},
		{name: "fee one over the cap", config: base.WithPriorityFee(100_001), want: TransactionV1PriorityFeeTooHigh},
		{name: "fee near u64 max cannot wrap", config: base.WithPriorityFee(math.MaxUint64), want: TransactionV1PriorityFeeTooHigh},
		{name: "heap size", config: base.WithHeapSize(32 * 1024), want: TransactionV1HeapSize},
		{name: "no compute unit limit", config: solana.TransactionConfig{}.WithLoadedAccountsDataSizeLimit(1), want: TransactionV1ComputeUnitLimitMissing},
		{name: "compute unit limit over the cap", config: base.WithComputeUnitLimit(20_001), want: TransactionV1ComputeUnitLimitTooHigh},
		{name: "no loaded data limit", config: solana.TransactionConfig{}.WithComputeUnitLimit(1), want: TransactionV1LoadedAccountsDataSizeLimitMissing},
	} {
		t.Run(test.name, func(t *testing.T) {
			// 5,000,000 microlamports/CU at 20,000 CU caps the fee at 100,000 lamports.
			assert.Equal(t, test.want, ValidateTransactionV1Config(message(test.config), 20_000, 5_000_000))
		})
	}

	// Both sides near u64 max must not overflow either: at 1,000,000 CU the
	// inequality is exactly priorityFee <= cap.
	huge := base.WithComputeUnitLimit(1_000_000).WithPriorityFee(math.MaxUint64)
	assert.Equal(t, TransactionV1ConfigOK, ValidateTransactionV1Config(message(huge), 1_000_000, math.MaxUint64))
	assert.Equal(t, TransactionV1PriorityFeeTooHigh, ValidateTransactionV1Config(message(huge), 1_000_000, math.MaxUint64-1))
}

func TestValidateTransactionV1ConfigRejectsComputeBudgetInstructions(t *testing.T) {
	feePayer := solana.NewWallet().PublicKey()
	v0, err := BuildClientTransaction(solana.MessageVersionV0, feePayer, solana.Hash{}, []solana.Instruction{memoTestInstruction()}, 20_000, 1)
	require.NoError(t, err)
	_, err = v0.Message.SetVersion(solana.MessageVersionV1)
	require.NoError(t, err)
	v0.Message.TransactionConfig = solana.TransactionConfig{}.WithComputeUnitLimit(20_000).WithLoadedAccountsDataSizeLimit(1)
	assert.Equal(t, TransactionV1ComputeBudgetInstruction, ValidateTransactionV1Config(&v0.Message, 20_000, 5_000_000))
}

func TestPeekWireTransactionVersion(t *testing.T) {
	feePayer := solana.NewWallet().PublicKey()
	build := func(version solana.MessageVersion) string {
		t.Helper()
		tx, err := solana.NewTransactionBuilder().
			AddInstruction(memoTestInstruction()).
			SetRecentBlockHash(solana.Hash{}).
			SetFeePayer(feePayer).
			Build()
		require.NoError(t, err)
		if version == solana.MessageVersionV1 {
			tx, err = BuildClientTransaction(solana.MessageVersionV1, feePayer, solana.Hash{}, []solana.Instruction{memoTestInstruction()}, 1, 0)
			require.NoError(t, err)
		} else {
			_, err = tx.Message.SetVersion(version)
			require.NoError(t, err)
		}
		return encodeForTest(t, tx)
	}

	for _, test := range []struct {
		version solana.MessageVersion
		want    int
	}{
		{version: solana.MessageVersionLegacy, want: -1},
		{version: solana.MessageVersionV0, want: 0},
		{version: solana.MessageVersionV1, want: 1},
	} {
		wire := build(test.version)
		version, ok := PeekWireTransactionVersion(wire)
		require.True(t, ok)
		assert.Equal(t, test.want, version)
		assert.True(t, IsAcceptedWireTransactionVersion(version))
	}

	raw, err := base64.StdEncoding.DecodeString(build(solana.MessageVersionV1))
	require.NoError(t, err)
	raw[0] = 0x82
	version, ok := PeekWireTransactionVersion(base64.StdEncoding.EncodeToString(raw))
	require.True(t, ok)
	assert.Equal(t, 2, version)
	assert.False(t, IsAcceptedWireTransactionVersion(version))

	_, ok = PeekWireTransactionVersion("")
	assert.False(t, ok)
	_, ok = PeekWireTransactionVersion("not base64!")
	assert.False(t, ok)
	_, ok = PeekWireTransactionVersion(base64.StdEncoding.EncodeToString([]byte{1, 2, 3}))
	assert.False(t, ok, "a signature count that runs past the end is inconclusive")
}

func TestMaxTransactionSize(t *testing.T) {
	assert.Equal(t, 1232, MaxTransactionSize(solana.MessageVersionLegacy))
	assert.Equal(t, 1232, MaxTransactionSize(solana.MessageVersionV0))
	assert.Equal(t, 4096, MaxTransactionSize(solana.MessageVersionV1))
}

func TestAcceptedTransactionVersionSets(t *testing.T) {
	// Legacy (-1) is policed as version 0.
	assert.True(t, IsAcceptedWireTransactionVersionIn(-1, []int{0}))
	assert.False(t, IsAcceptedWireTransactionVersionIn(-1, []int{1}))
	assert.False(t, IsAcceptedWireTransactionVersionIn(1, []int{0}))
	assert.True(t, IsAcceptedWireTransactionVersionIn(1, nil))
	assert.False(t, IsAcceptedWireTransactionVersionIn(2, []int{0, 1, 2}))
	assert.True(t, IsAcceptedTransactionVersionIn(solana.MessageVersionLegacy, []int{0}))
	assert.False(t, IsAcceptedTransactionVersionIn(solana.MessageVersionV1, []int{0}))

	normalized, err := NormalizeAcceptedTransactionVersions(nil)
	assert.NoError(t, err)
	assert.Equal(t, []int{0, 1}, normalized)
	normalized, err = NormalizeAcceptedTransactionVersions([]int{1, 0, 1})
	assert.NoError(t, err)
	assert.Equal(t, []int{0, 1}, normalized)
	for _, invalid := range [][]int{{}, {2}, {0, -1}} {
		_, err := NormalizeAcceptedTransactionVersions(invalid)
		assert.Error(t, err)
	}
}

func TestUptoOpenSlotAcceptsTheSpecNumberForm(t *testing.T) {
	base := map[string]interface{}{
		"from": "a", "maxAmount": "1", "deposit": "1", "channelId": "c",
		"authorizedSigner": "s", "openTransaction": "t", "nonce": "1",
		"expiresAt": float64(2), "validAfter": float64(1),
	}
	with := func(slot interface{}) map[string]interface{} {
		out := map[string]interface{}{"openSlot": slot}
		for key, value := range base {
			out[key] = value
		}
		return out
	}
	for _, slot := range []interface{}{"341000000", float64(341000000), int64(341000000), json.Number("341000000")} {
		assert.True(t, IsUptoSvmPayload(with(slot)), "%T", slot)
		payload, err := UptoPayloadFromMap(with(slot))
		assert.NoError(t, err)
		assert.Equal(t, "341000000", payload.OpenSlot)
	}
	for _, slot := range []interface{}{float64(-1), 1.5, float64(1 << 54), nil, ""} {
		assert.False(t, IsUptoSvmPayload(with(slot)), "%v", slot)
	}
}
