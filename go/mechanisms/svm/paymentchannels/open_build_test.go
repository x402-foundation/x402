package paymentchannels

import (
	"encoding/binary"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestVerifyOpenTransactionAcceptsBuiltOpen(t *testing.T) {
	fixture := newOpenFixture(t)

	result, err := VerifyOpenTransaction(encodeTransaction(t, fixture.built.Transaction), fixture.expected())
	require.NoError(t, err)

	assert.Equal(t, fixture.built.ChannelID, result.ChannelID)
	assert.Equal(t, fixture.payerKey.PublicKey(), result.Payer)
	assert.Equal(t, fixture.deposit, result.Deposit)
	assert.Equal(t, fixture.graceSeconds, result.GracePeriod)
	assert.Equal(t, fixture.openSlot, result.OpenSlot)
	assert.Equal(t, fixture.salt, result.Salt)
	require.Len(t, result.Recipients, 1)
	assert.Equal(t, fixture.payTo.String(), result.Recipients[0].Recipient)
	assert.Equal(t, BasisPointsDenominator, result.Recipients[0].BPS)
}

func TestVerifyOpenTransactionRejectsDepositMismatch(t *testing.T) {
	fixture := newOpenFixture(t)
	expected := fixture.expected()
	expected.MaxCap = fixture.deposit + 1

	_, err := VerifyOpenTransaction(encodeTransaction(t, fixture.built.Transaction), expected)
	require.ErrorContains(t, err, "deposit 10000 != maxCap 10001")
}

func TestVerifyOpenTransactionRejectsMissingPayerSignature(t *testing.T) {
	fixture := newOpenFixture(t)
	fixture.built.Transaction.Signatures = make([]solana.Signature, len(fixture.built.Transaction.Signatures))

	_, err := VerifyOpenTransaction(encodeTransaction(t, fixture.built.Transaction), fixture.expected())
	require.ErrorContains(t, err, "missing signature for payload.from")
}

// openComputeBudgetArgs are the fixed BuildOpenArgs fields shared by the
// ComputeBudget prefix tests, with only compute overrides varying.
func openComputeBudgetArgs(t *testing.T) BuildOpenArgs {
	t.Helper()
	payerKey := testKeypair(t)
	return BuildOpenArgs{
		Payer:            payerKey.PublicKey(),
		Payee:            testKeypair(t).PublicKey(),
		Mint:             testKeypair(t).PublicKey(),
		AuthorizedSigner: testKeypair(t).PublicKey(),
		FeePayer:         testKeypair(t).PublicKey(),
		TokenProgram:     solana.TokenProgramID,
		Deposit:          1_000_000,
		Blockhash:        solana.Hash(testKeypair(t).PublicKey()),
		OpenSlot:         341_000_000,
		GracePeriod:      900,
	}
}

func TestBuildOpenTransactionEmitsARightSizedComputeBudgetPrefixByDefault(t *testing.T) {
	built, err := BuildOpenTransaction(openComputeBudgetArgs(t))
	require.NoError(t, err)

	instructions := built.Transaction.Message.Instructions
	require.GreaterOrEqual(t, len(instructions), 2)
	assert.Equal(t, uint8(ComputeBudgetSetUnitLimit), instructions[0].Data[0])
	assert.Equal(t, OpenDefaultComputeUnitLimit, binary.LittleEndian.Uint32(instructions[0].Data[1:5]))
	assert.Equal(t, uint8(ComputeBudgetSetUnitPrice), instructions[1].Data[0])
	assert.Equal(
		t, uint64(svm.DefaultComputeUnitPriceMicrolamports), binary.LittleEndian.Uint64(instructions[1].Data[1:9]),
	)
}

func TestBuildOpenTransactionHonorsComputeBudgetOverridesAndOptOut(t *testing.T) {
	args := openComputeBudgetArgs(t)
	limit := uint32(120_000)
	price := uint64(5)
	args.ComputeUnitLimit = &limit
	args.ComputeUnitPriceMicroLamports = &price

	overridden, err := BuildOpenTransaction(args)
	require.NoError(t, err)
	instructions := overridden.Transaction.Message.Instructions
	require.GreaterOrEqual(t, len(instructions), 2)
	assert.Equal(t, limit, binary.LittleEndian.Uint32(instructions[0].Data[1:5]))
	assert.Equal(t, price, binary.LittleEndian.Uint64(instructions[1].Data[1:9]))

	// 0 omits each instruction (a wallet may inject its own prefix).
	zero := uint32(0)
	zeroPrice := uint64(0)
	bareArgs := openComputeBudgetArgs(t)
	bareArgs.ComputeUnitLimit = &zero
	bareArgs.ComputeUnitPriceMicroLamports = &zeroPrice
	bare, err := BuildOpenTransaction(bareArgs)
	require.NoError(t, err)
	assert.Equal(t, OpenDiscriminator, bare.Transaction.Message.Instructions[0].Data[0],
		"a zero limit and price omit the ComputeBudget prefix entirely")
}

func TestBuildOpenTransactionEnforcesComputeBudgetCeilings(t *testing.T) {
	overLimit := OpenMaxComputeUnitLimit + 1
	limitArgs := openComputeBudgetArgs(t)
	limitArgs.ComputeUnitLimit = &overLimit
	_, err := BuildOpenTransaction(limitArgs)
	require.ErrorContains(t, err, "computeUnitLimit")

	overPrice := uint64(svm.MaxComputeUnitPriceMicrolamports) + 1
	priceArgs := openComputeBudgetArgs(t)
	priceArgs.ComputeUnitPriceMicroLamports = &overPrice
	_, err = BuildOpenTransaction(priceArgs)
	require.ErrorContains(t, err, "computeUnitPriceMicroLamports")
}

func TestResolveMemoData(t *testing.T) {
	memo := "order-42"
	data, err := resolveMemoData(&memo)
	require.NoError(t, err)
	assert.Equal(t, "order-42", string(data))

	nonce, err := resolveMemoData(nil)
	require.NoError(t, err)
	assert.Len(t, nonce, 32, "a random nonce is 16 bytes of hex")

	// A seller that advertises an empty memo gets an empty memo: substituting a
	// nonce would fail the facilitator's exact-match check.
	empty := ""
	data, err = resolveMemoData(&empty)
	require.NoError(t, err)
	assert.Empty(t, data)

	oversized := string(make([]byte, MaxMemoBytes+1))
	_, err = resolveMemoData(&oversized)
	require.ErrorContains(t, err, "exceeds maximum 256 bytes")
}
