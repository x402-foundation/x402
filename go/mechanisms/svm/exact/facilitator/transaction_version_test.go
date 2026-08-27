package facilitator

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// asTransactionV1 rebuilds a transaction as a transaction v1 (SIMD-0385)
// payment: the ComputeBudget instructions are dropped, as a conformant v1
// client does, and their budget moves into the message's inline config with a
// priority fee far above any operator cap. That is the shape the version gate
// exists for — the instruction scan finds no ComputeBudget instruction to
// reject, so nothing but the version itself distinguishes this from a
// transaction whose fee is bounded.
func asTransactionV1(t *testing.T, base64Tx string, feePayer solana.PublicKey) string {
	t.Helper()

	tx, err := svm.DecodeTransaction(base64Tx)
	require.NoError(t, err)

	var instructions []solana.Instruction
	for _, compiled := range tx.Message.Instructions {
		program, err := tx.Message.Program(compiled.ProgramIDIndex)
		require.NoError(t, err)
		if program.Equals(solana.ComputeBudget) {
			continue
		}
		accounts, err := compiled.ResolveInstructionAccounts(&tx.Message)
		require.NoError(t, err)
		instructions = append(instructions, solana.NewInstruction(program, accounts, compiled.Data))
	}

	v1Tx, err := solana.NewTransaction(
		instructions,
		tx.Message.RecentBlockhash,
		solana.TransactionPayer(feePayer),
		solana.TransactionV1Config(solana.TransactionConfig{}.
			WithComputeUnitLimit(200_000).
			WithLoadedAccountsDataSizeLimit(64*1024).
			WithPriorityFee(1_000_000_000)),
	)
	require.NoError(t, err)
	v1Tx.Signatures = make([]solana.Signature, v1Tx.Message.Header.NumRequiredSignatures)

	wire, err := v1Tx.MarshalBinary()
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(wire)
}

func TestExactSvmSchemeRejectsAnUnsupportedTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	payload.Payload["transaction"] = asTransactionV1(t, payload.Payload["transaction"].(string), facilitatorAddr)
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)

	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)
}

// The version check must precede every structural check, so a transaction that
// would also fail the instruction-layout rules is still reported as an
// unsupported version: a version whose compute budget lives somewhere this code
// cannot read must never be evaluated by checks that scan instructions for it.
func TestExactSvmSchemeChecksTheVersionBeforeTheInstructionLayout(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)

	tx, err := solana.NewTransaction(
		[]solana.Instruction{solana.NewInstruction(
			solana.MustPublicKeyFromBase58(svm.MemoProgramAddress),
			solana.AccountMetaSlice{},
			[]byte("only instruction"),
		)},
		solana.Hash{},
		solana.TransactionPayer(facilitatorAddr),
		solana.TransactionV1Config(solana.TransactionConfig{}.WithComputeUnitLimit(200_000)),
	)
	require.NoError(t, err)
	wire, err := tx.MarshalBinary()
	require.NoError(t, err)
	payload.Payload["transaction"] = base64.StdEncoding.EncodeToString(wire)

	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)

	_, err = scheme.Verify(context.Background(), payload, requirements, nil)

	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)
}

func TestExactSvmSchemeSettleRejectsAnUnsupportedTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	payload.Payload["transaction"] = asTransactionV1(t, payload.Payload["transaction"].(string), facilitatorAddr)
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)

	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrUnsupportedTransactionVersion, se.ErrorReason)
	assert.Equal(t, 0, signer.sendCalls, "an unsupported version must never be broadcast")
}
