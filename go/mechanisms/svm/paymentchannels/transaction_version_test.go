package paymentchannels

import (
	"context"
	"encoding/base64"
	"math"
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

// v1ChannelConfig is the config the SDK builders emit for an open or top_up:
// 200,000 CU at 1 microlamport/CU and the default loaded-data budget.
func v1ChannelConfig() solana.TransactionConfig {
	return solana.TransactionConfig{}.
		WithComputeUnitLimit(OpenDefaultComputeUnitLimit).
		WithLoadedAccountsDataSizeLimit(svm.DefaultLoadedAccountsDataSizeLimit).
		WithPriorityFee(1)
}

// signedV1Wire assembles a payer-signed version-1 transaction. The builder
// path lets tests smuggle a ComputeBudget instruction, which
// solana.NewTransaction refuses for v1.
func signedV1Wire(t *testing.T, payer solana.PrivateKey, feePayer solana.PublicKey, config solana.TransactionConfig, instructions []solana.Instruction) string {
	t.Helper()
	builder := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(feePayer)
	for _, instruction := range instructions {
		builder = builder.AddInstruction(instruction)
	}
	tx, err := builder.Build()
	require.NoError(t, err)
	_, err = tx.Message.SetVersion(solana.MessageVersionV1)
	require.NoError(t, err)
	tx.Message.TransactionConfig = config
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	signTransaction(t, tx, payer)
	return encodeTransaction(t, tx)
}

// relabelVersion rewrites a v1 wire transaction's version byte to version 2,
// a format no verifier models.
func relabelVersion(t *testing.T, wire string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(wire)
	require.NoError(t, err)
	require.Equal(t, byte(0x81), raw[0])
	raw[0] = 0x82
	return base64.StdEncoding.EncodeToString(raw)
}

func (f *openFixture) buildV1Open(t *testing.T, args func(*BuildOpenArgs)) string {
	t.Helper()
	build := BuildOpenArgs{
		Payer:              f.payerKey.PublicKey(),
		Payee:              f.feePayer,
		Mint:               f.mint,
		AuthorizedSigner:   f.authorizer,
		FeePayer:           f.feePayer,
		TokenProgram:       f.tokenProgram,
		Deposit:            f.deposit,
		Blockhash:          solana.Hash(testKeypair(t).PublicKey()),
		OpenSlot:           f.openSlot,
		GracePeriod:        f.graceSeconds,
		Recipients:         []Split{{Recipient: f.payTo.String(), BPS: BasisPointsDenominator}},
		Salt:               &f.salt,
		TransactionVersion: solana.MessageVersionV1,
	}
	if args != nil {
		args(&build)
	}
	built, err := BuildOpenTransaction(build)
	require.NoError(t, err)
	signTransaction(t, built.Transaction, f.payerKey)
	return encodeTransaction(t, built.Transaction)
}

func TestBuildOpenTransactionBuildsVersion1(t *testing.T) {
	fixture := newOpenFixture(t)
	binding := "x402-binding"
	wire := fixture.buildV1Open(t, func(args *BuildOpenArgs) { args.BindingMemo = &binding })

	tx, err := svm.DecodeTransaction(wire)
	require.NoError(t, err)
	assert.Equal(t, solana.MessageVersionV1, tx.Message.GetVersion())
	config := tx.Message.TransactionConfig
	require.NotNil(t, config.ComputeUnitLimit)
	assert.Equal(t, OpenDefaultComputeUnitLimit, *config.ComputeUnitLimit)
	require.NotNil(t, config.LoadedAccountsDataSizeLimit)
	assert.Equal(t, svm.DefaultLoadedAccountsDataSizeLimit, *config.LoadedAccountsDataSizeLimit)
	require.NotNil(t, config.PriorityFee)
	assert.Equal(t, uint64(1), *config.PriorityFee, "1 microlamport/CU at 200,000 CU rounds up to 1 lamport")
	require.Len(t, tx.Message.Instructions, 3, "open + nonce memo + binding memo, no ComputeBudget prefix")
	for _, ix := range tx.Message.Instructions {
		program, err := tx.Message.Program(ix.ProgramIDIndex)
		require.NoError(t, err)
		assert.False(t, program.Equals(solana.ComputeBudget))
	}

	expected := fixture.expected()
	expected.ExpectedBindingMemo = &binding
	result, err := VerifyOpenTransaction(wire, expected)
	require.NoError(t, err)
	assert.Equal(t, fixture.deposit, result.Deposit)
}

func TestBuildOpenTransactionVersion1Options(t *testing.T) {
	fixture := newOpenFixture(t)
	zero := uint32(0)
	_, err := BuildOpenTransaction(BuildOpenArgs{
		Payer: fixture.payerKey.PublicKey(), Payee: fixture.feePayer, Mint: fixture.mint,
		AuthorizedSigner: fixture.authorizer, FeePayer: fixture.feePayer, TokenProgram: fixture.tokenProgram,
		Deposit: fixture.deposit, OpenSlot: fixture.openSlot, GracePeriod: fixture.graceSeconds,
		Salt: &fixture.salt, ComputeUnitLimit: &zero, TransactionVersion: solana.MessageVersionV1,
	})
	require.ErrorContains(t, err, "computeUnitLimit", "version 1 has no runtime CU default, so 0 is refused")

	noFee := uint64(0)
	wire := fixture.buildV1Open(t, func(args *BuildOpenArgs) { args.ComputeUnitPriceMicroLamports = &noFee })
	tx, err := svm.DecodeTransaction(wire)
	require.NoError(t, err)
	assert.Nil(t, tx.Message.TransactionConfig.PriorityFee, "a zero price omits the priority fee")
	_, err = VerifyOpenTransaction(wire, fixture.expected())
	require.NoError(t, err)
}

func TestVerifyOpenTransactionVersion1Policy(t *testing.T) {
	fixture := newOpenFixture(t)
	open := fixture.openInstruction(t)
	nonce := memoInstruction("0123456789abcdef0123456789abcdef")
	maxCU := uint32(100_000)
	zeroFee := uint64(0)
	// 5 lamports per CU at 200,000 CU is exactly the spec cap.
	atCap := uint64(MaxComputeUnitPriceMicroLamports) * uint64(OpenDefaultComputeUnitLimit) / 1_000_000

	tests := []struct {
		name         string
		config       solana.TransactionConfig
		instructions []solana.Instruction
		expected     func(*VerifyOpenExpected)
		wantErr      string
	}{
		{name: "canonical layout", config: v1ChannelConfig(), instructions: []solana.Instruction{open, nonce}},
		{name: "Lighthouse suffix", config: v1ChannelConfig(), instructions: []solana.Instruction{open, lighthouseInstruction(), nonce}},
		{name: "priorityFee at the spec cap", config: v1ChannelConfig().WithPriorityFee(atCap), instructions: []solana.Instruction{open, nonce}},
		{
			name:         "ComputeBudget prefix",
			config:       v1ChannelConfig(),
			instructions: []solana.Instruction{computeUnitLimitInstruction(t, 200_000), open, nonce},
			wantErr:      svm.TransactionV1ComputeBudgetInstruction.String(),
		},
		{
			name:         "computeUnitLimit unset",
			config:       solana.TransactionConfig{}.WithLoadedAccountsDataSizeLimit(svm.DefaultLoadedAccountsDataSizeLimit),
			instructions: []solana.Instruction{open, nonce},
			wantErr:      svm.TransactionV1ComputeUnitLimitMissing.String(),
		},
		{
			name:         "computeUnitLimit above the spec ceiling",
			config:       v1ChannelConfig().WithComputeUnitLimit(OpenMaxComputeUnitLimit + 1),
			instructions: []solana.Instruction{open, nonce},
			wantErr:      svm.TransactionV1ComputeUnitLimitTooHigh.String(),
		},
		{
			name:         "computeUnitLimit above the operator cap",
			config:       v1ChannelConfig(),
			instructions: []solana.Instruction{open, nonce},
			expected:     func(e *VerifyOpenExpected) { e.MaxComputeUnits = &maxCU },
			wantErr:      svm.TransactionV1ComputeUnitLimitTooHigh.String(),
		},
		{
			name:         "loadedAccountsDataSizeLimit unset",
			config:       solana.TransactionConfig{}.WithComputeUnitLimit(OpenDefaultComputeUnitLimit),
			instructions: []solana.Instruction{open, nonce},
			wantErr:      svm.TransactionV1LoadedAccountsDataSizeLimitMissing.String(),
		},
		{
			name:         "heap size",
			config:       v1ChannelConfig().WithHeapSize(64 * 1024),
			instructions: []solana.Instruction{open, nonce},
			wantErr:      svm.TransactionV1HeapSize.String(),
		},
		{
			name:         "priorityFee above the spec cap",
			config:       v1ChannelConfig().WithPriorityFee(atCap + 1),
			instructions: []solana.Instruction{open, nonce},
			wantErr:      svm.TransactionV1PriorityFeeTooHigh.String(),
		},
		{
			name:         "priorityFee near u64 max cannot wrap",
			config:       v1ChannelConfig().WithPriorityFee(math.MaxUint64),
			instructions: []solana.Instruction{open, nonce},
			wantErr:      svm.TransactionV1PriorityFeeTooHigh.String(),
		},
		{
			name:         "priorityFee above a zero operator price cap",
			config:       v1ChannelConfig(),
			instructions: []solana.Instruction{open, nonce},
			expected:     func(e *VerifyOpenExpected) { e.MaxPriorityFeeMicroLamports = &zeroFee },
			wantErr:      svm.TransactionV1PriorityFeeTooHigh.String(),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			wire := signedV1Wire(t, fixture.payerKey, fixture.feePayer, test.config, test.instructions)
			expected := fixture.expected()
			if test.expected != nil {
				test.expected(&expected)
			}
			_, err := VerifyOpenTransaction(wire, expected)
			if test.wantErr == "" {
				require.NoError(t, err)
				return
			}
			require.ErrorContains(t, err, test.wantErr)
		})
	}
}

func TestVerifyOpenTransactionAcceptsAVersion1OpenAboveTheLegacySizeLimit(t *testing.T) {
	fixture := newOpenFixture(t)
	// Twenty recipients and a full memo push the open past the 1232-byte
	// v0 packet limit.
	recipients := make([]Split, 20)
	for i := range recipients {
		recipients[i] = Split{Recipient: testKeypair(t).PublicKey().String(), BPS: BasisPointsDenominator / 20}
	}
	memo := strings.Repeat("m", svm.MaxMemoBytes)
	wire := fixture.buildV1Open(t, func(args *BuildOpenArgs) {
		args.Recipients = recipients
		args.Memo = &memo
	})
	raw, err := base64.StdEncoding.DecodeString(wire)
	require.NoError(t, err)
	require.Greater(t, len(raw), svm.MaxTransactionSizeLegacy)
	require.LessOrEqual(t, len(raw), svm.MaxTransactionSizeV1)

	expected := fixture.expected()
	expected.Recipients = recipients
	expected.Memo = &memo
	_, err = VerifyOpenTransaction(wire, expected)
	require.NoError(t, err)

	// The same open does not fit a version-0 packet.
	_, err = BuildOpenTransaction(BuildOpenArgs{
		Payer: fixture.payerKey.PublicKey(), Payee: fixture.feePayer, Mint: fixture.mint,
		AuthorizedSigner: fixture.authorizer, FeePayer: fixture.feePayer, TokenProgram: fixture.tokenProgram,
		Deposit: fixture.deposit, OpenSlot: fixture.openSlot, GracePeriod: fixture.graceSeconds,
		Recipients: recipients, Salt: &fixture.salt, Memo: &memo,
	})
	require.ErrorContains(t, err, "1232-byte packet limit")
}

func TestChannelVerifiersRejectAnUnknownTransactionVersion(t *testing.T) {
	fixture := newOpenFixture(t)
	wire := relabelVersion(t, fixture.buildV1Open(t, nil))

	_, err := VerifyOpenTransaction(wire, fixture.expected())
	require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
	require.ErrorContains(t, err, "unsupported transaction message version 2")

	require.ErrorContains(t, VerifyTopUpTransaction(wire, VerifyTopUpExpected{}), svm.ErrUnsupportedTransactionVersion)
	require.ErrorContains(t, VerifyRequestCloseTransaction(wire, VerifyRequestCloseExpected{
		Payer: fixture.payerKey.PublicKey(), FeePayer: fixture.feePayer,
	}), svm.ErrUnsupportedTransactionVersion)

	// The gate runs before the signer is touched.
	_, err = BroadcastOpen(context.Background(), nil, fixture.feePayer, "", wire, ChannelBroadcastHooks{})
	require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
}

func TestTopUpAndRequestCloseBuildAndVerifyVersion1(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	mint := testKeypair(t).PublicKey()

	topUp, err := BuildTopUpPaymentChannelTransaction(BuildTopUpArgs{
		Payer: payer.PublicKey(), ChannelID: channel, Mint: mint, TokenProgram: solana.TokenProgramID,
		FeePayer: feePayer, Amount: 7, Blockhash: solana.Hash(testKeypair(t).PublicKey()),
		TransactionVersion: solana.MessageVersionV1,
	})
	require.NoError(t, err)
	assert.Equal(t, solana.MessageVersionV1, topUp.Transaction.Message.GetVersion())
	require.Len(t, topUp.Transaction.Message.Instructions, 2, "top_up + memo, no ComputeBudget prefix")
	signTransaction(t, topUp.Transaction, payer)
	require.NoError(t, VerifyTopUpTransaction(encodeTransaction(t, topUp.Transaction), VerifyTopUpExpected{
		FeePayer: feePayer, From: payer.PublicKey(), ChannelID: channel,
		Mint: mint, TokenProgram: solana.TokenProgramID, Amount: 7,
	}))

	requestClose, err := BuildRequestCloseTransaction(BuildRequestCloseArgs{
		Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
		Blockhash: solana.Hash(testKeypair(t).PublicKey()), TransactionVersion: solana.MessageVersionV1,
	})
	require.NoError(t, err)
	assert.Equal(t, solana.MessageVersionV1, requestClose.Message.GetVersion())
	config := requestClose.Message.TransactionConfig
	require.NotNil(t, config.ComputeUnitLimit)
	assert.Equal(t, RequestCloseV1ComputeUnitLimit, *config.ComputeUnitLimit)
	assert.Nil(t, config.PriorityFee, "request_close carries no priority fee, as on version 0")
	signTransaction(t, requestClose, payer)
	require.NoError(t, VerifyRequestCloseTransaction(encodeTransaction(t, requestClose), VerifyRequestCloseExpected{
		Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
	}))

	zero := uint32(0)
	_, err = BuildRequestCloseTransaction(BuildRequestCloseArgs{
		Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
		ComputeUnitLimit: &zero, TransactionVersion: solana.MessageVersionV1,
	})
	require.ErrorContains(t, err, "computeUnitLimit")
}

func TestVerifyChannelTransactionsApplyCapsToVersion1Budgets(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	mint := testKeypair(t).PublicKey()
	payerATA, err := FindATA(payer.PublicKey(), mint, solana.TokenProgramID)
	require.NoError(t, err)
	channelATA, err := FindATA(channel, mint, solana.TokenProgramID)
	require.NoError(t, err)
	topUp, err := generated.NewTopUpInstructionBuilder().
		SetTopUpArgs(generated.TopUpArgs{Amount: 1}).
		SetPayerAccount(payer.PublicKey()).
		SetChannelAccount(channel).
		SetPayerTokenAccountAccount(payerATA).
		SetChannelTokenAccountAccount(channelATA).
		SetMintAccount(mint).
		SetTokenProgramAccount(solana.TokenProgramID).
		ValidateAndBuild()
	require.NoError(t, err)
	zeroFee := uint64(0)
	tests := []struct {
		name        string
		instruction solana.Instruction
		verify      func(string) error
	}{
		{
			name:        "top_up",
			instruction: topUp,
			verify: func(wire string) error {
				return VerifyTopUpTransaction(wire, VerifyTopUpExpected{
					FeePayer: feePayer, From: payer.PublicKey(), ChannelID: channel,
					Mint: mint, TokenProgram: solana.TokenProgramID, Amount: 1,
					MaxPriorityFeeMicroLamports: &zeroFee,
				})
			},
		},
		{
			name:        "request_close",
			instruction: requestCloseInstruction(t, payer.PublicKey(), channel),
			verify: func(wire string) error {
				return VerifyRequestCloseTransaction(wire, VerifyRequestCloseExpected{
					FeePayer: feePayer, Payer: payer.PublicKey(), ChannelID: channel,
					MaxPriorityFeeMicroLamports: &zeroFee,
				})
			},
		},
	}
	nonce := memoInstruction("0123456789abcdef0123456789abcdef")
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			noFee := solana.TransactionConfig{}.
				WithComputeUnitLimit(OpenDefaultComputeUnitLimit).
				WithLoadedAccountsDataSizeLimit(svm.DefaultLoadedAccountsDataSizeLimit)
			require.NoError(t, test.verify(signedV1Wire(t, payer, feePayer, noFee, []solana.Instruction{test.instruction, nonce})))

			for _, bad := range []struct {
				config  solana.TransactionConfig
				prefix  []solana.Instruction
				wantErr svm.TransactionV1ConfigViolation
			}{
				{config: noFee.WithComputeUnitLimit(1_400_000), wantErr: svm.TransactionV1ComputeUnitLimitTooHigh},
				{config: noFee.WithPriorityFee(1), wantErr: svm.TransactionV1PriorityFeeTooHigh},
				{config: solana.TransactionConfig{}.WithComputeUnitLimit(1), wantErr: svm.TransactionV1LoadedAccountsDataSizeLimitMissing},
				{config: noFee, prefix: []solana.Instruction{computeUnitLimitInstruction(t, 1)}, wantErr: svm.TransactionV1ComputeBudgetInstruction},
			} {
				instructions := append(append([]solana.Instruction{}, bad.prefix...), test.instruction, nonce)
				err := test.verify(signedV1Wire(t, payer, feePayer, bad.config, instructions))
				require.ErrorContains(t, err, bad.wantErr.String())
			}
		})
	}
}

// padWithMemo appends a copy of the transaction's last instruction (its memo)
// carrying size bytes of data, then re-signs as payer: a payload over its
// version's size limit that the builders refuse to produce.
func padWithMemo(t *testing.T, wire string, payer solana.PrivateKey, size int) string {
	t.Helper()
	tx, err := svm.DecodeTransaction(wire)
	require.NoError(t, err)
	last := tx.Message.Instructions[len(tx.Message.Instructions)-1]
	tx.Message.Instructions = append(tx.Message.Instructions, solana.CompiledInstruction{
		ProgramIDIndex: last.ProgramIDIndex,
		Data:           []byte(strings.Repeat("a", size)),
	})
	signTransaction(t, tx, payer)
	return encodeTransaction(t, tx)
}

func TestChannelVerifiersEnforceTheSizeLimitOfTheMessageVersion(t *testing.T) {
	fixture := newOpenFixture(t)

	v0Open := padWithMemo(t, fixture.buildSignedOpen(t, nil, nil), fixture.payerKey, 1300)
	_, err := VerifyOpenTransaction(v0Open, fixture.expected())
	require.ErrorContains(t, err, "verifyOpenTransaction: transaction is")
	require.ErrorContains(t, err, "above the 1232-byte limit for version 0")

	v1Open := padWithMemo(t, fixture.buildV1Open(t, nil), fixture.payerKey, 4200)
	_, err = VerifyOpenTransaction(v1Open, fixture.expected())
	require.ErrorContains(t, err, "above the 4096-byte limit for version 1")

	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	topUp, err := BuildTopUpPaymentChannelTransaction(BuildTopUpArgs{
		Payer: payer.PublicKey(), ChannelID: channel, Mint: fixture.mint, TokenProgram: solana.TokenProgramID,
		FeePayer: feePayer, Amount: 7, Blockhash: solana.Hash(testKeypair(t).PublicKey()),
		TransactionVersion: solana.MessageVersionV0,
	})
	require.NoError(t, err)
	require.ErrorContains(t, VerifyTopUpTransaction(
		padWithMemo(t, encodeTransaction(t, topUp.Transaction), payer, 1300),
		VerifyTopUpExpected{FeePayer: feePayer, From: payer.PublicKey(), ChannelID: channel},
	), "verifyTopUpTransaction: transaction is")

	requestClose, err := BuildRequestCloseTransaction(BuildRequestCloseArgs{
		Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
		Blockhash: solana.Hash(testKeypair(t).PublicKey()), TransactionVersion: solana.MessageVersionV1,
	})
	require.NoError(t, err)
	require.ErrorContains(t, VerifyRequestCloseTransaction(
		padWithMemo(t, encodeTransaction(t, requestClose), payer, 4200),
		VerifyRequestCloseExpected{Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel},
	), "verifyRequestCloseTransaction: transaction is")
}
