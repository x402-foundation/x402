package facilitator

import (
	"context"
	"encoding/base64"
	"errors"
	"math"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// v1ExactConfig is the config a well-formed client-built v1 exact payment
// carries: 20,000 CU at 1 microlamport/CU and the default data budget.
func v1ExactConfig() solana.TransactionConfig {
	return solana.TransactionConfig{}.
		WithComputeUnitLimit(svm.DefaultComputeUnitLimit).
		WithLoadedAccountsDataSizeLimit(svm.DefaultLoadedAccountsDataSizeLimit).
		WithPriorityFee(1)
}

// buildV1ExactFixture builds a signed version-1 exact payment: prefix, then
// the TransferChecked, then extra. The prefix lets tests smuggle a
// ComputeBudget instruction, which solana.NewTransaction refuses for v1.
func buildV1ExactFixture(t *testing.T, config solana.TransactionConfig, prefix []solana.Instruction, extra ...solana.Instruction) exactFixture {
	t.Helper()

	facilitatorAddr := solana.NewWallet().PublicKey()
	ownerWallet := solana.NewWallet()
	owner := ownerWallet.PublicKey()
	mint := solana.NewWallet().PublicKey()
	payTo := solana.NewWallet().PublicKey()
	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	destATA, _, err := solana.FindAssociatedTokenAddress(payTo, mint)
	require.NoError(t, err)
	transferIx, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(1000).
		SetDecimals(6).
		SetSourceAccount(sourceATA).
		SetMintAccount(mint).
		SetDestinationAccount(destATA).
		SetOwnerAccount(owner).
		ValidateAndBuild()
	require.NoError(t, err)
	blockhash, err := solana.HashFromBase58("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
	require.NoError(t, err)

	builder := solana.NewTransactionBuilder()
	for _, ix := range prefix {
		builder.AddInstruction(ix)
	}
	builder.AddInstruction(transferIx)
	for _, ix := range extra {
		builder.AddInstruction(ix)
	}
	tx, err := builder.SetRecentBlockHash(blockhash).SetFeePayer(facilitatorAddr).Build()
	require.NoError(t, err)
	_, err = tx.Message.SetVersion(solana.MessageVersionV1)
	require.NoError(t, err)
	tx.Message.TransactionConfig = config
	signTransaction(t, tx, ownerWallet.PrivateKey)

	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)
	requirements := types.PaymentRequirements{
		Scheme:  svm.SchemeExact,
		Network: svm.SolanaDevnetCAIP2,
		Asset:   mint.String(),
		Amount:  "1000",
		PayTo:   payTo.String(),
		Extra:   map[string]interface{}{"feePayer": facilitatorAddr.String()},
	}
	return exactFixture{
		payload: types.PaymentPayload{
			X402Version: 2,
			Payload:     (&svm.ExactSvmPayload{Transaction: encoded}).ToMap(),
			Accepted:    requirements,
		},
		requirements:    requirements,
		facilitatorAddr: facilitatorAddr,
		ownerKey:        ownerWallet.PrivateKey,
		tx:              tx,
		mint:            mint,
		payTo:           payTo,
		destATA:         destATA,
	}
}

func memoInstruction(data string) solana.Instruction {
	return solana.NewInstruction(solana.MustPublicKeyFromBase58(svm.MemoProgramAddress), solana.AccountMetaSlice{}, []byte(data))
}

// futureVersionTransaction is a v1 wire transaction relabelled as version 2,
// a format no verifier models.
func futureVersionTransaction(t *testing.T) string {
	t.Helper()
	f := buildV1ExactFixture(t, v1ExactConfig(), nil)
	raw, err := f.tx.MarshalBinary()
	require.NoError(t, err)
	require.Equal(t, byte(0x81), raw[0])
	raw[0] = 0x82
	return base64.StdEncoding.EncodeToString(raw)
}

func verifyFixture(t *testing.T, f exactFixture, config ...*Config) (*x402.VerifyResponse, *mockExactSvmSigner, error) {
	t.Helper()
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
	scheme := NewExactSvmScheme(signer, config...)
	resp, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	return resp, signer, err
}

func TestExactSvmScheme_GetExtraAdvertisesTransactionVersions(t *testing.T) {
	addr := solana.NewWallet().PublicKey()
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{addr}}
	scheme := NewExactSvmScheme(signer)

	extra := scheme.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))
	assert.Equal(t, addr.String(), extra["feePayer"])
	assert.Equal(t, []int{0, 1}, extra[svm.ExtraTransactionVersions])
}

func TestExactSvmScheme_VerifyRejectsUnknownTransactionVersionBeforeSignatureChecks(t *testing.T) {
	f := buildExactFixture(t)
	f.payload.Payload = (&svm.ExactSvmPayload{Transaction: futureVersionTransaction(t)}).ToMap()

	_, signer, err := verifyFixture(t, f)
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve), "%v", err)
	assert.Equal(t, svm.ErrUnsupportedTransactionVersion, ve.InvalidReason)
	assert.Contains(t, ve.InvalidMessage, "version 2")
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 0, signer.simulateCalls)
}

func TestExactSvmScheme_SettleRejectsUnknownTransactionVersionBeforeSigning(t *testing.T) {
	f := buildExactFixture(t)
	f.payload.Payload = (&svm.ExactSvmPayload{Transaction: futureVersionTransaction(t)}).ToMap()

	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
	_, err := NewExactSvmScheme(signer).Settle(context.Background(), f.payload, f.requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se), "%v", err)
	assert.Equal(t, ErrUnsupportedTransactionVersion, se.ErrorReason)
	assert.Contains(t, se.ErrorMessage, "version 2")
	assert.Equal(t, 0, signer.signCalls)
}

func TestExactSvmScheme_VerifyStillAcceptsLegacyAndV0(t *testing.T) {
	for _, version := range []solana.MessageVersion{solana.MessageVersionLegacy, solana.MessageVersionV0} {
		f := buildExactFixture(t)
		f.tx.Message.SetVersion(version)
		signTransaction(t, f.tx, f.ownerKey)
		encoded, err := svm.EncodeTransaction(f.tx)
		require.NoError(t, err)
		f.payload.Payload = (&svm.ExactSvmPayload{Transaction: encoded}).ToMap()

		resp, _, err := verifyFixture(t, f)
		require.NoError(t, err, "version %d", version)
		assert.True(t, resp.IsValid, "version %d", version)
	}
}

func TestExactSvmScheme_VerifyAcceptsVersion1StaticLayouts(t *testing.T) {
	tests := []struct {
		name  string
		extra []solana.Instruction
	}{
		{name: "transfer only"},
		{name: "transfer + memo", extra: []solana.Instruction{memoInstruction("nonce")}},
		{
			name: "transfer + three Lighthouse + memo",
			extra: []solana.Instruction{
				lighthouseInstruction(), lighthouseInstruction(), lighthouseInstruction(), memoInstruction("nonce"),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := buildV1ExactFixture(t, v1ExactConfig(), nil, test.extra...)
			resp, signer, err := verifyFixture(t, f)
			require.NoError(t, err)
			assert.True(t, resp.IsValid)
			assert.Equal(t, 1, signer.simulateCalls)
			assert.True(t, hasStaticTransferLayout(f.tx))
		})
	}
}

func TestExactSvmScheme_VerifyAcceptsVersion1AboveTheLegacySizeLimit(t *testing.T) {
	f := buildV1ExactFixture(t, v1ExactConfig(), nil, memoInstruction(strings.Repeat("a", 2000)))
	raw, err := f.tx.MarshalBinary()
	require.NoError(t, err)
	require.Greater(t, len(raw), svm.MaxTransactionSizeLegacy)
	require.LessOrEqual(t, len(raw), svm.MaxTransactionSizeV1)

	resp, _, err := verifyFixture(t, f)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

func TestExactSvmScheme_VerifyVersion1ExpectedMemo(t *testing.T) {
	f := buildV1ExactFixture(t, v1ExactConfig(), nil, memoInstruction("order-1"))
	f.requirements.Extra["memo"] = "order-1"
	f.payload.Accepted = f.requirements
	resp, _, err := verifyFixture(t, f)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)

	f.requirements.Extra["memo"] = "order-2"
	_, _, err = verifyFixture(t, f)
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve), "%v", err)
	assert.Equal(t, ErrMemoMismatch, ve.InvalidReason)
}

func TestExactSvmScheme_VerifyRejectsVersion1Violations(t *testing.T) {
	cuLimit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(20_000).ValidateAndBuild()
	require.NoError(t, err)
	maxComputeUnits := uint32(10_000)
	// 5 lamports per CU at 20,000 CU is exactly the default Path 1 cap.
	atCap := uint64(svm.MaxComputeUnitPriceMicrolamports) * uint64(svm.DefaultComputeUnitLimit) / 1_000_000

	tests := []struct {
		name   string
		config solana.TransactionConfig
		prefix []solana.Instruction
		extra  []solana.Instruction
		cfg    *Config
		reason string
	}{
		{name: "ComputeBudget instruction", config: v1ExactConfig(), prefix: []solana.Instruction{cuLimit}, reason: ErrTransactionV1ComputeBudgetIx},
		{
			name:   "computeUnitLimit unset",
			config: solana.TransactionConfig{}.WithLoadedAccountsDataSizeLimit(svm.DefaultLoadedAccountsDataSizeLimit),
			reason: ErrComputeLimitInstruction,
		},
		{name: "computeUnitLimit above the operator cap", config: v1ExactConfig(), cfg: &Config{MaxComputeUnits: &maxComputeUnits}, reason: ErrComputeLimitInstructionTooHigh},
		{
			name:   "loadedAccountsDataSizeLimit unset",
			config: solana.TransactionConfig{}.WithComputeUnitLimit(svm.DefaultComputeUnitLimit),
			reason: ErrLoadedAccountsDataSizeLimitMissing,
		},
		{name: "heap size requested", config: v1ExactConfig().WithHeapSize(64 * 1024), reason: ErrTransactionV1HeapSize},
		{name: "priorityFee one lamport over the cap", config: v1ExactConfig().WithPriorityFee(atCap + 1), reason: ErrComputePriceInstructionTooHigh},
		{name: "priorityFee near u64 max cannot wrap", config: v1ExactConfig().WithPriorityFee(math.MaxUint64), reason: ErrComputePriceInstructionTooHigh},
		{
			name:   "fifth optional instruction",
			config: v1ExactConfig(),
			extra: []solana.Instruction{
				lighthouseInstruction(), lighthouseInstruction(), lighthouseInstruction(), memoInstruction("a"), memoInstruction("b"),
			},
			reason: ErrTransactionInstructionsLength,
		},
		{
			name:   "unknown optional instruction",
			config: v1ExactConfig(),
			extra:  []solana.Instruction{solana.NewInstruction(solana.SystemProgramID, solana.AccountMetaSlice{}, []byte{1})},
			reason: ErrUnknownFourthInstruction,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := buildV1ExactFixture(t, test.config, test.prefix, test.extra...)
			var configs []*Config
			if test.cfg != nil {
				configs = append(configs, test.cfg)
			}
			_, signer, err := verifyFixture(t, f, configs...)
			var ve *x402.VerifyError
			require.True(t, errors.As(err, &ve), "%v", err)
			assert.Equal(t, test.reason, ve.InvalidReason)
			assert.Equal(t, 0, signer.simulateCalls)
		})
	}

	t.Run("priorityFee at the cap is accepted", func(t *testing.T) {
		f := buildV1ExactFixture(t, v1ExactConfig().WithPriorityFee(atCap), nil)
		resp, _, err := verifyFixture(t, f)
		require.NoError(t, err)
		assert.True(t, resp.IsValid)
	})
}

func TestValidateComputeBudgetLimitsVersion1UsesSmartWalletCodes(t *testing.T) {
	cuLimit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(20_000).ValidateAndBuild()
	require.NoError(t, err)
	tests := []struct {
		name   string
		config solana.TransactionConfig
		prefix []solana.Instruction
		reason string
	}{
		{name: "within caps", config: v1ExactConfig()},
		{name: "ComputeBudget instruction", config: v1ExactConfig(), prefix: []solana.Instruction{cuLimit}, reason: ErrSmartWalletUnsupportedComputeBudget},
		{name: "heap size", config: v1ExactConfig().WithHeapSize(64 * 1024), reason: ErrSmartWalletUnsupportedComputeBudget},
		{name: "computeUnitLimit unset", config: solana.TransactionConfig{}.WithLoadedAccountsDataSizeLimit(1), reason: ErrSmartWalletMalformedComputeLimit},
		{name: "loaded data unset", config: solana.TransactionConfig{}.WithComputeUnitLimit(20_000), reason: ErrSmartWalletMalformedComputeLimit},
		{name: "computeUnitLimit above cap", config: v1ExactConfig().WithComputeUnitLimit(500_000), reason: ErrSmartWalletComputeUnitsTooHigh},
		// 50,000 microlamports/CU at 20,000 CU is exactly 1,000 lamports.
		{name: "priorityFee at the Path 2 cap", config: v1ExactConfig().WithPriorityFee(1_000)},
		{name: "priorityFee above the stricter Path 2 cap", config: v1ExactConfig().WithPriorityFee(1_001), reason: ErrSmartWalletPriorityFeeTooHigh},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			f := buildV1ExactFixture(t, test.config, test.prefix)
			err := validateComputeBudgetLimits(f.tx, defaultSmartWalletMaxComputeUnits, defaultSmartWalletMaxPriorityFeeMicroLamports)
			if test.reason == "" {
				require.NoError(t, err)
				return
			}
			require.Error(t, err)
			assert.True(t, strings.HasPrefix(err.Error(), test.reason), err.Error())
		})
	}
}

// sizedExactFixture pads an exact payment's memo so the serialized
// transaction is exactly size bytes.
func sizedExactFixture(t *testing.T, version solana.MessageVersion, size int) exactFixture {
	t.Helper()
	build := func(memoLen int) exactFixture {
		memo := memoInstruction(strings.Repeat("a", memoLen))
		if version == solana.MessageVersionV1 {
			return buildV1ExactFixture(t, v1ExactConfig(), nil, memo)
		}
		return buildExactFixtureWithOptional(t, memo)
	}
	probe := build(500)
	raw, err := probe.tx.MarshalBinary()
	require.NoError(t, err)
	f := build(500 + size - len(raw))
	raw, err = f.tx.MarshalBinary()
	require.NoError(t, err)
	require.Len(t, raw, size)
	return f
}

func TestExactSvmScheme_VerifyEnforcesTheSizeLimitOfTheMessageVersion(t *testing.T) {
	tests := []struct {
		version  solana.MessageVersion
		size     int
		accepted bool
	}{
		{solana.MessageVersionV0, svm.MaxTransactionSizeLegacy, true},
		{solana.MessageVersionV0, svm.MaxTransactionSizeLegacy + 1, false},
		{solana.MessageVersionV1, svm.MaxTransactionSizeLegacy + 1, true},
		{solana.MessageVersionV1, svm.MaxTransactionSizeV1, true},
		{solana.MessageVersionV1, svm.MaxTransactionSizeV1 + 1, false},
	}
	for _, test := range tests {
		f := sizedExactFixture(t, test.version, test.size)
		resp, signer, err := verifyFixture(t, f)
		if test.accepted {
			require.NoError(t, err, "version %d, %d bytes", test.version, test.size)
			assert.True(t, resp.IsValid)
			continue
		}
		var verifyErr *x402.VerifyError
		require.True(t, errors.As(err, &verifyErr), "version %d, %d bytes: %v", test.version, test.size, err)
		assert.Equal(t, ErrTransactionSizeExceeded, verifyErr.InvalidReason)
		assert.Zero(t, signer.simulateCalls)
	}
}
