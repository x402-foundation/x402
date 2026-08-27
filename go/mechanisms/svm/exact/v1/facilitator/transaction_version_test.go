package facilitator

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

// mockSignerV1 is a fully-mocked FacilitatorSvmSigner: only GetAddresses
// matters here, because the version gate rejects the payload long before any
// signing, simulation or broadcast is reached.
type mockSignerV1 struct {
	addresses []solana.PublicKey
	sendCalls int
}

func (m *mockSignerV1) GetAddresses(_ context.Context, _ string) []solana.PublicKey {
	return m.addresses
}
func (m *mockSignerV1) SignTransaction(_ context.Context, _ *solana.Transaction, _ solana.PublicKey, _ string) error {
	return nil
}
func (m *mockSignerV1) SimulateTransaction(_ context.Context, _ *solana.Transaction, _ string) error {
	return nil
}
func (m *mockSignerV1) SendTransaction(_ context.Context, _ *solana.Transaction, _ string) (solana.Signature, error) {
	m.sendCalls++
	return solana.Signature{}, nil
}
func (m *mockSignerV1) ConfirmTransaction(_ context.Context, _ solana.Signature, _ string) error {
	return nil
}

// buildTransactionV1Payload assembles the V1 wire scheme's payload and
// requirements around a transaction v1 (SIMD-0385) payment: a bare
// TransferChecked, with the compute budget in the message's inline config
// rather than in ComputeBudget instructions, and a priority fee far above any
// operator cap. The scheme's compute budget checks have no instruction to find
// here, so only the version itself stands between this transaction and the
// facilitator paying that fee.
func buildTransactionV1Payload(
	t *testing.T,
) (types.PaymentPayloadV1, types.PaymentRequirementsV1, solana.PublicKey) {
	t.Helper()

	facilitatorAddr := solana.NewWallet().PrivateKey.PublicKey()
	owner := solana.NewWallet().PrivateKey.PublicKey()
	mint := solana.NewWallet().PrivateKey.PublicKey()
	payTo := solana.NewWallet().PrivateKey.PublicKey()

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

	tx, err := solana.NewTransaction(
		[]solana.Instruction{transferIx},
		solana.Hash{},
		solana.TransactionPayer(facilitatorAddr),
		solana.TransactionV1Config(solana.TransactionConfig{}.
			WithComputeUnitLimit(200_000).
			WithLoadedAccountsDataSizeLimit(64*1024).
			WithPriorityFee(1_000_000_000)),
	)
	require.NoError(t, err)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)

	wire, err := tx.MarshalBinary()
	require.NoError(t, err)

	extra, err := json.Marshal(map[string]string{"feePayer": facilitatorAddr.String()})
	require.NoError(t, err)
	rawExtra := json.RawMessage(extra)

	requirements := types.PaymentRequirementsV1{
		Scheme:            svm.SchemeExact,
		Network:           svm.SolanaDevnetV1,
		MaxAmountRequired: "1000",
		Resource:          "https://example.com",
		PayTo:             payTo.String(),
		MaxTimeoutSeconds: 3600,
		Asset:             mint.String(),
		Extra:             &rawExtra,
	}
	payload := types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      svm.SchemeExact,
		Network:     svm.SolanaDevnetV1,
		Payload: (&svm.ExactSvmPayload{
			Transaction: base64.StdEncoding.EncodeToString(wire),
		}).ToMap(),
	}
	return payload, requirements, facilitatorAddr
}

// The legacy V1 wire scheme reads its sponsorship policy out of the first two
// ComputeBudget instructions, so it accepts only the versions that carry the
// compute budget as instructions. A version it predates is rejected before any
// instruction is inspected.
func TestExactSvmSchemeV1RejectsAnUnsupportedTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr := buildTransactionV1Payload(t)
	signer := &mockSignerV1{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)

	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)
}

func TestExactSvmSchemeV1SettleRejectsAnUnsupportedTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr := buildTransactionV1Payload(t)
	signer := &mockSignerV1{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)

	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrUnsupportedTransactionVersion, se.ErrorReason)
	assert.Equal(t, 0, signer.sendCalls, "an unsupported version must never be broadcast")
}
