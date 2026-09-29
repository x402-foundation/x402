package paymentchannels

import (
	"encoding/base64"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/stretchr/testify/require"
)

func testKeypair(t *testing.T) solana.PrivateKey {
	t.Helper()
	key, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return key
}

func signTransaction(t *testing.T, tx *solana.Transaction, key solana.PrivateKey) {
	t.Helper()
	messageBytes, err := tx.Message.MarshalBinary()
	require.NoError(t, err)
	signature, err := key.Sign(messageBytes)
	require.NoError(t, err)
	index, err := tx.GetAccountIndex(key.PublicKey())
	require.NoError(t, err)
	if len(tx.Signatures) <= int(index) {
		signatures := make([]solana.Signature, index+1)
		copy(signatures, tx.Signatures)
		tx.Signatures = signatures
	}
	tx.Signatures[index] = signature
}

func encodeTransaction(t *testing.T, tx *solana.Transaction) string {
	t.Helper()
	raw, err := tx.MarshalBinary()
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(raw)
}

type openFixture struct {
	payerKey     solana.PrivateKey
	feePayer     solana.PublicKey
	authorizer   solana.PublicKey
	mint         solana.PublicKey
	payTo        solana.PublicKey
	tokenProgram solana.PublicKey
	salt         uint64
	openSlot     uint64
	deposit      uint64
	graceSeconds uint32
	built        *BuiltOpen
}

func newOpenFixture(t *testing.T) *openFixture {
	t.Helper()
	payerKey := testKeypair(t)
	fixture := &openFixture{
		payerKey:     payerKey,
		feePayer:     testKeypair(t).PublicKey(),
		authorizer:   testKeypair(t).PublicKey(),
		mint:         testKeypair(t).PublicKey(),
		payTo:        testKeypair(t).PublicKey(),
		tokenProgram: solana.TokenProgramID,
		salt:         42,
		openSlot:     341_000_000,
		deposit:      10_000,
		graceSeconds: 3600,
	}

	built, err := BuildOpenTransaction(BuildOpenArgs{
		Payer:            payerKey.PublicKey(),
		Payee:            fixture.feePayer,
		Mint:             fixture.mint,
		AuthorizedSigner: fixture.authorizer,
		FeePayer:         fixture.feePayer,
		TokenProgram:     fixture.tokenProgram,
		Deposit:          fixture.deposit,
		Blockhash:        solana.Hash(testKeypair(t).PublicKey()),
		OpenSlot:         fixture.openSlot,
		GracePeriod:      fixture.graceSeconds,
		Recipients:       []Split{{Recipient: fixture.payTo.String(), BPS: BasisPointsDenominator}},
		Salt:             &fixture.salt,
	})
	require.NoError(t, err)
	signTransaction(t, built.Transaction, payerKey)
	fixture.built = built
	return fixture
}

func (f *openFixture) expected() VerifyOpenExpected {
	return VerifyOpenExpected{
		AuthorizedSigner: f.authorizer,
		FeePayer:         f.feePayer,
		From:             f.payerKey.PublicKey(),
		Mint:             f.mint,
		TokenProgram:     f.tokenProgram,
		Payee:            f.feePayer,
		MaxCap:           f.deposit,
		WithdrawDelay:    f.graceSeconds,
		OpenSlot:         f.openSlot,
		Recipients:       []Split{{Recipient: f.payTo.String(), BPS: BasisPointsDenominator}},
	}
}

// openInstruction rebuilds the fixture's canonical open instruction so tests
// can assemble transactions with their own prefix and suffix.
func (f *openFixture) openInstruction(t *testing.T) solana.Instruction {
	t.Helper()
	instruction, _, err := BuildOpenInstruction(OpenInstructionArgs{
		Payer:            f.payerKey.PublicKey(),
		RentPayer:        f.feePayer,
		Payee:            f.feePayer,
		Mint:             f.mint,
		AuthorizedSigner: f.authorizer,
		TokenProgram:     f.tokenProgram,
		Args: OpenArgs{
			Salt:        f.salt,
			Deposit:     f.deposit,
			GracePeriod: f.graceSeconds,
			OpenSlot:    f.openSlot,
			Recipients:  []Split{{Recipient: f.payTo.String(), BPS: BasisPointsDenominator}},
		},
	})
	require.NoError(t, err)
	return instruction
}

// buildSignedOpen assembles a payer-signed open with the given surrounding
// instructions and returns its base64 wire form.
func (f *openFixture) buildSignedOpen(t *testing.T, prefix, suffix []solana.Instruction) string {
	t.Helper()

	builder := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(f.feePayer)
	for _, instruction := range prefix {
		builder = builder.AddInstruction(instruction)
	}
	builder = builder.AddInstruction(f.openInstruction(t))
	for _, instruction := range suffix {
		builder = builder.AddInstruction(instruction)
	}

	tx, err := builder.Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	signTransaction(t, tx, f.payerKey)
	return encodeTransaction(t, tx)
}

// buildSignedOpenWith assembles a payer-signed transaction around a caller-built
// open instruction, so tests can tamper with the open itself.
func (f *openFixture) buildSignedOpenWith(t *testing.T, open solana.Instruction) string {
	t.Helper()

	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash(testKeypair(t).PublicKey())).
		SetFeePayer(f.feePayer).
		AddInstruction(open).
		Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	signTransaction(t, tx, f.payerKey)
	return encodeTransaction(t, tx)
}

func computeUnitLimitInstruction(t *testing.T, units uint32) solana.Instruction {
	t.Helper()
	instruction, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(units).ValidateAndBuild()
	require.NoError(t, err)
	return instruction
}

func computeUnitPriceInstruction(t *testing.T, microLamports uint64) solana.Instruction {
	t.Helper()
	instruction, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
		SetMicroLamports(microLamports).
		ValidateAndBuild()
	require.NoError(t, err)
	return instruction
}

func lighthouseInstruction() solana.Instruction {
	return solana.NewInstruction(lighthouseProgramID, solana.AccountMetaSlice{}, []byte{0x01})
}

func memoInstruction(data string) solana.Instruction {
	return solana.NewInstruction(memoProgramID, solana.AccountMetaSlice{}, []byte(data))
}
