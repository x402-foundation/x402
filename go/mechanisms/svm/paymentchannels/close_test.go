package paymentchannels

import (
	"strings"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

func signedRequestClose(
	t *testing.T,
	payer solana.PrivateKey,
	feePayer, channel solana.PublicKey,
	memo *string,
	program solana.PublicKey,
) string {
	t.Helper()
	tx, err := BuildRequestCloseTransaction(BuildRequestCloseArgs{
		Payer:     payer.PublicKey(),
		FeePayer:  feePayer,
		ChannelID: channel,
		Blockhash: solana.Hash(testKeypair(t).PublicKey()),
		Memo:      memo,
		Program:   program,
	})
	require.NoError(t, err)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	signTransaction(t, tx, payer)
	return encodeTransaction(t, tx)
}

func requestCloseInstruction(t *testing.T, payer, channel solana.PublicKey) solana.Instruction {
	t.Helper()
	instruction, err := generated.NewRequestCloseInstructionBuilder().
		SetPayerAccount(payer).
		SetChannelAccount(channel).
		ValidateAndBuild()
	require.NoError(t, err)
	return instruction
}

func signedCloseWire(t *testing.T, payer solana.PrivateKey, feePayer solana.PublicKey, instructions []solana.Instruction) string {
	t.Helper()
	builder := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(feePayer)
	for _, instruction := range instructions {
		builder = builder.AddInstruction(instruction)
	}
	tx, err := builder.Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	if payer != nil {
		signTransaction(t, tx, payer)
	}
	return encodeTransaction(t, tx)
}

func TestRequestCloseBuildsAndVerifiesNonceAndMemo(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	invoice := "invoice"

	nonceWire := signedRequestClose(t, payer, feePayer, channel, nil, solana.PublicKey{})
	require.NoError(t, VerifyRequestCloseTransaction(nonceWire, VerifyRequestCloseExpected{
		Payer:     payer.PublicKey(),
		FeePayer:  feePayer,
		ChannelID: channel,
	}))

	memoWire := signedRequestClose(t, payer, feePayer, channel, &invoice, solana.PublicKey{})
	require.NoError(t, VerifyRequestCloseTransaction(memoWire, VerifyRequestCloseExpected{
		Payer:     payer.PublicKey(),
		FeePayer:  feePayer,
		ChannelID: channel,
		Memo:      &invoice,
	}))
}

func TestRequestCloseAcceptsTheCanonicalProgram(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	memo := "custom"
	wire := signedRequestClose(t, payer, feePayer, channel, &memo, ProgramID)
	require.NoError(t, VerifyRequestCloseTransaction(wire, VerifyRequestCloseExpected{
		Payer:     payer.PublicKey(),
		FeePayer:  feePayer,
		ChannelID: channel,
		Memo:      &memo,
		Program:   ProgramID,
	}))
}

func TestRequestCloseRejectsEnvelopeAndBindingSubstitutions(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	other := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	invoice := "invoice"
	wire := signedRequestClose(t, payer, feePayer, channel, &invoice, solana.PublicKey{})

	cases := []struct {
		name     string
		expected VerifyRequestCloseExpected
		message  string
	}{
		{
			name: "payer is the fee payer",
			expected: VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: payer.PublicKey(), ChannelID: channel, Memo: &invoice,
			},
			message: "payer must differ",
		},
		{
			name: "fee payer mismatch",
			expected: VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: other, ChannelID: channel, Memo: &invoice,
			},
			message: "required signers",
		},
		{
			name: "payer mismatch",
			expected: VerifyRequestCloseExpected{
				Payer: other, FeePayer: feePayer, ChannelID: channel, Memo: &invoice,
			},
			message: "required signers",
		},
		{
			name: "channel mismatch",
			expected: VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: other, Memo: &invoice,
			},
			message: "account binding mismatch",
		},
		{
			name: "memo mismatch",
			expected: VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel, Memo: memoPtr("other"),
			},
			message: "memo mismatch",
		},
		{
			name: "explicit memo is not a nonce",
			expected: VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
			},
			message: "nonce memo must be hexadecimal",
		},
		{
			name: "wrong program",
			expected: VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel, Memo: &invoice, Program: other,
			},
			message: "unexpected instruction before request_close",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := VerifyRequestCloseTransaction(wire, test.expected)
			require.Error(t, err)
			assert.Contains(t, err.Error(), test.message)
		})
	}
}

func TestRequestCloseRejectsAnOversizedMemo(t *testing.T) {
	memo := strings.Repeat("x", svm.MaxMemoBytes+1)
	_, err := BuildRequestCloseTransaction(BuildRequestCloseArgs{
		Payer:     testKeypair(t).PublicKey(),
		FeePayer:  testKeypair(t).PublicKey(),
		ChannelID: testKeypair(t).PublicKey(),
		Blockhash: solana.Hash(testKeypair(t).PublicKey()),
		Memo:      &memo,
	})
	require.ErrorContains(t, err, "exceeds maximum")
}

func TestRequestCloseAcceptsComputeBudgetAndLighthouse(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	nonce := "0123456789abcdef0123456789abcdef"
	wire := signedCloseWire(t, payer, feePayer, []solana.Instruction{
		computeUnitLimitInstruction(t, 10_000),
		computeUnitPriceInstruction(t, 1_000),
		requestCloseInstruction(t, payer.PublicKey(), channel),
		lighthouseInstruction(),
		memoInstruction(nonce),
	})
	expected := VerifyRequestCloseExpected{Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel}
	require.NoError(t, VerifyRequestCloseTransaction(wire, expected))

	units, price := uint32(20_000), uint64(2_000)
	expected.MaxComputeUnits = &units
	expected.MaxPriorityFeeMicroLamports = &price
	require.NoError(t, VerifyRequestCloseTransaction(wire, expected))
}

func TestRequestCloseRejectsComputeBudgetOutsidePolicy(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	closeIx := requestCloseInstruction(t, payer.PublicKey(), channel)
	nonce := memoInstruction("0123456789abcdef0123456789abcdef")

	cases := []struct {
		name    string
		prefix  []solana.Instruction
		message string
	}{
		{
			name:    "limit above the spec ceiling",
			prefix:  []solana.Instruction{computeUnitLimitInstruction(t, OpenMaxComputeUnitLimit+1)},
			message: "compute unit limit exceeds sponsor cap",
		},
		{
			name:    "price above the spec ceiling",
			prefix:  []solana.Instruction{computeUnitPriceInstruction(t, svm.MaxComputeUnitPriceMicrolamports+1)},
			message: "compute unit price exceeds sponsor cap",
		},
		{
			name: "duplicate limit",
			prefix: []solana.Instruction{
				computeUnitLimitInstruction(t, 1),
				computeUnitLimitInstruction(t, 2),
			},
			message: "invalid SetComputeUnitLimit",
		},
		{
			name: "price before limit",
			prefix: []solana.Instruction{
				computeUnitPriceInstruction(t, 1),
				computeUnitLimitInstruction(t, 1),
			},
			message: "invalid SetComputeUnitLimit",
		},
		{
			name: "duplicate price",
			prefix: []solana.Instruction{
				computeUnitPriceInstruction(t, 1),
				computeUnitPriceInstruction(t, 2),
			},
			message: "invalid SetComputeUnitPrice",
		},
		{
			name:    "truncated limit",
			prefix:  []solana.Instruction{solana.NewInstruction(solana.ComputeBudget, nil, []byte{ComputeBudgetSetUnitLimit, 1, 0})},
			message: "invalid SetComputeUnitLimit",
		},
		{
			name:    "truncated price",
			prefix:  []solana.Instruction{solana.NewInstruction(solana.ComputeBudget, nil, []byte{ComputeBudgetSetUnitPrice, 1, 0})},
			message: "invalid SetComputeUnitPrice",
		},
		{
			name:    "unknown budget discriminator",
			prefix:  []solana.Instruction{solana.NewInstruction(solana.ComputeBudget, nil, []byte{1, 0, 0, 0, 0})},
			message: "unsupported Compute Budget instruction",
		},
		{
			name:    "empty budget data",
			prefix:  []solana.Instruction{solana.NewInstruction(solana.ComputeBudget, nil, nil)},
			message: "invalid Compute Budget instruction",
		},
		{
			name: "budget instruction names an account",
			prefix: []solana.Instruction{solana.NewInstruction(
				solana.ComputeBudget,
				[]*solana.AccountMeta{solana.Meta(channel)},
				[]byte{ComputeBudgetSetUnitLimit, 16, 39, 0, 0},
			)},
			message: "invalid Compute Budget instruction",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			instructions := append(append([]solana.Instruction{}, test.prefix...), closeIx, nonce)
			wire := signedCloseWire(t, payer, feePayer, instructions)
			err := VerifyRequestCloseTransaction(wire, VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
			})
			require.ErrorContains(t, err, test.message)
		})
	}
}

func TestRequestCloseRejectsADisallowedSuffix(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	closeIx := requestCloseInstruction(t, payer.PublicKey(), channel)
	nonce := "0123456789abcdef0123456789abcdef"

	cases := []struct {
		name    string
		suffix  []solana.Instruction
		message string
	}{
		{
			name:    "two memos",
			suffix:  []solana.Instruction{memoInstruction(nonce), memoInstruction(nonce)},
			message: "invalid Memo suffix",
		},
		{
			name: "memo names an account",
			suffix: []solana.Instruction{solana.NewInstruction(
				memoProgramID,
				[]*solana.AccountMeta{solana.Meta(channel)},
				[]byte(nonce),
			)},
			message: "invalid Memo suffix",
		},
		{
			name:    "memo above the byte limit",
			suffix:  []solana.Instruction{memoInstruction(strings.Repeat("x", svm.MaxMemoBytes+1))},
			message: "memo exceeds the byte limit",
		},
		{
			name: "too many lighthouse instructions",
			suffix: []solana.Instruction{
				lighthouseInstruction(), lighthouseInstruction(), lighthouseInstruction(), lighthouseInstruction(),
				memoInstruction(nonce),
			},
			message: "too many Lighthouse",
		},
		{
			name: "lighthouse names the fee payer",
			suffix: []solana.Instruction{
				solana.NewInstruction(lighthouseProgramID, []*solana.AccountMeta{solana.Meta(feePayer)}, []byte{1}),
				memoInstruction(nonce),
			},
			message: "feePayer must not be a suffix account",
		},
		{
			name: "unknown suffix program",
			suffix: []solana.Instruction{
				solana.NewInstruction(testKeypair(t).PublicKey(), nil, []byte{1}),
				memoInstruction(nonce),
			},
			message: "unsupported suffix instruction",
		},
		{
			name:    "empty memo is not a nonce",
			suffix:  []solana.Instruction{memoInstruction("")},
			message: "nonce memo must be hexadecimal",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			instructions := append([]solana.Instruction{closeIx}, test.suffix...)
			wire := signedCloseWire(t, payer, feePayer, instructions)
			err := VerifyRequestCloseTransaction(wire, VerifyRequestCloseExpected{
				Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
			})
			require.ErrorContains(t, err, test.message)
		})
	}
}

func TestRequestCloseRejectsAFeePayerSlotThatIsNotTheSponsor(t *testing.T) {
	payer := testKeypair(t)
	sponsor := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	wire := signedCloseWire(t, payer, payer.PublicKey(), []solana.Instruction{
		requestCloseInstruction(t, payer.PublicKey(), channel),
		solana.NewInstruction(lighthouseProgramID, []*solana.AccountMeta{
			{PublicKey: sponsor, IsSigner: true},
		}, []byte{1}),
		memoInstruction("0123456789abcdef0123456789abcdef"),
	})
	err := VerifyRequestCloseTransaction(wire, VerifyRequestCloseExpected{
		Payer: payer.PublicKey(), FeePayer: sponsor, ChannelID: channel,
	})
	require.ErrorContains(t, err, "transaction fee payer mismatch")
}

func TestRequestCloseRejectsAMissingOrForgedPayerSignature(t *testing.T) {
	payer := testKeypair(t)
	feePayer := testKeypair(t).PublicKey()
	channel := testKeypair(t).PublicKey()
	unsigned := signedCloseWire(t, nil, feePayer, []solana.Instruction{
		requestCloseInstruction(t, payer.PublicKey(), channel),
		memoInstruction("0123456789abcdef0123456789abcdef"),
	})
	err := VerifyRequestCloseTransaction(unsigned, VerifyRequestCloseExpected{
		Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
	})
	require.ErrorContains(t, err, "missing or invalid payer signature")

	tx, decodeErr := svm.DecodeTransaction(signedCloseWire(t, payer, feePayer, []solana.Instruction{
		requestCloseInstruction(t, payer.PublicKey(), channel),
		memoInstruction("0123456789abcdef0123456789abcdef"),
	}))
	require.NoError(t, decodeErr)
	index, err := tx.GetAccountIndex(payer.PublicKey())
	require.NoError(t, err)
	tx.Signatures[index][0] ^= 0xff
	err = VerifyRequestCloseTransaction(encodeTransaction(t, tx), VerifyRequestCloseExpected{
		Payer: payer.PublicKey(), FeePayer: feePayer, ChannelID: channel,
	})
	require.ErrorContains(t, err, "missing or invalid payer signature")
}

func memoPtr(value string) *string { return &value }
