package paymentchannels

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

func TestDistributionHashMatchesProgramPreimage(t *testing.T) {
	recipient := solana.MustPublicKeyFromBase58("11111111111111111111111111111112")

	hash, err := GetChannelDistributionHash([]Split{{Recipient: recipient.String(), BPS: BasisPointsDenominator}})
	require.NoError(t, err)

	// sha256(u32le(1) || recipient || u16le(10000))
	preimage := append(u32LE(1), recipient.Bytes()...)
	preimage = append(preimage, u16LE(BasisPointsDenominator)...)
	assert.Equal(t, sha256.Sum256(preimage), hash)
}

// TestDistributionHashMatchesTheCrossLanguageGolden pins the same two-recipient
// vector the TypeScript SDK asserts, so a preimage that drifts from the program
// (or from the other SDK) fails here rather than onchain at distribute.
func TestDistributionHashMatchesTheCrossLanguageGolden(t *testing.T) {
	recipientOne := solana.PublicKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	recipientTwo := solana.PublicKeyFromBytes(bytes.Repeat([]byte{2}, 32))

	hash, err := GetChannelDistributionHash([]Split{
		{Recipient: recipientOne.String(), BPS: 7_500},
		{Recipient: recipientTwo.String(), BPS: 2_500},
	})
	require.NoError(t, err)

	assert.Equal(t, [32]byte{
		0x54, 0xc8, 0x97, 0x55, 0x87, 0x75, 0x0e, 0x88, 0x21, 0xe9, 0x3f, 0x5d, 0x4a, 0xf6, 0x07,
		0xd2, 0x0d, 0x55, 0xa5, 0x8b, 0xa1, 0xb9, 0xa4, 0xb4, 0x9f, 0x72, 0xa5, 0x42, 0xed, 0x87,
		0x4a, 0x3f,
	}, hash)
}

func TestFetchAndVerifyOpenChannelDoesNotRetryInvalidState(t *testing.T) {
	channelID := testKeypair(t).PublicKey()
	payer := testKeypair(t).PublicKey()
	data := make([]byte, ChannelAccountSize)
	data[0] = uint8(generated.AccountDiscriminator_Channel)
	data[3] = byte(generated.ChannelStatus_Sealed)
	copy(data[ChannelPayerOffset:ChannelPayerOffset+32], payer.Bytes())

	rpcClient := &staticChannelRPC{data: data}
	_, err := FetchAndVerifyOpenChannel(t.Context(), rpcClient, channelID, ExpectedOpenChannel{
		Payer: payer.String(),
	}, ChannelReadPolicy{})
	require.ErrorContains(t, err, "is not open")
	assert.Equal(t, 1, rpcClient.calls)
}

func TestChannelExistsReportsPresence(t *testing.T) {
	channelID := testKeypair(t).PublicKey()
	missing := &staticChannelRPC{}
	exists, err := ChannelExists(t.Context(), missing, channelID)
	require.NoError(t, err)
	assert.False(t, exists)

	present := &staticChannelRPC{data: []byte{1}}
	exists, err = ChannelExists(t.Context(), present, channelID)
	require.NoError(t, err)
	assert.True(t, exists)
}

func TestReclaimComputeUnitLimitStaysWithinTheTransactionCeiling(t *testing.T) {
	assert.Equal(t, uint32(30_000), ReclaimComputeUnitLimit(1))
	assert.Equal(t, uint32(65_000), ReclaimComputeUnitLimit(8))
	assert.Equal(t, maxTransactionComputeUnits, ReclaimComputeUnitLimit(1_000_000))
}

func TestBroadcastOpenReportsTheSignatureBeforeConfirmation(t *testing.T) {
	feePayer := testKeypair(t).PublicKey()
	signer := &recordingChannelSigner{sent: solana.Signature{9}}
	var events []string
	wire := unsignedMemoTransaction(t, feePayer)

	got, err := BroadcastOpen(t.Context(), signer, feePayer, svm.SolanaDevnetCAIP2, wire, ChannelBroadcastHooks{
		OnBroadcast: func(signature string) error {
			events = append(events, "broadcast:"+signature)
			return nil
		},
	})
	require.NoError(t, err)
	assert.Equal(t, signer.sent.String(), got)
	assert.Equal(t, []string{"broadcast:" + signer.sent.String()}, events)
	assert.Equal(t, 1, signer.confirms)
}

func TestBroadcastOpenCarriesAnUnconfirmedSignature(t *testing.T) {
	feePayer := testKeypair(t).PublicKey()
	signer := &recordingChannelSigner{sent: solana.Signature{9}, confirmErr: errors.New("timeout")}
	_, err := BroadcastOpen(t.Context(), signer, feePayer, svm.SolanaDevnetCAIP2, unsignedMemoTransaction(t, feePayer), ChannelBroadcastHooks{})
	var confirmErr *ChannelBroadcastConfirmationError
	require.ErrorAs(t, err, &confirmErr)
	assert.Equal(t, signer.sent.String(), confirmErr.Signature)
}

func TestSubmitChannelTransactionSimulatesThenConfirms(t *testing.T) {
	feePayer := testKeypair(t).PublicKey()
	signer := &recordingChannelSigner{sent: solana.Signature{4}}
	var broadcast string
	got, err := SubmitChannelTransactionWithSigner(
		t.Context(), signer, signer, feePayer, svm.SolanaDevnetCAIP2,
		[]solana.Instruction{memoInstruction("settle")},
		SubmitSettleOptions{OnBroadcast: func(signature string) error {
			broadcast = signature
			return nil
		}},
	)
	require.NoError(t, err)
	assert.Equal(t, signer.sent.String(), got)
	assert.Equal(t, 1, signer.simulations)
	assert.Equal(t, signer.sent.String(), broadcast)
	assert.Equal(t, 1, signer.confirms)
}

func TestSubmitChannelTransactionDoesNotBroadcastWhenPreparationFails(t *testing.T) {
	feePayer := testKeypair(t).PublicKey()
	signer := &recordingChannelSigner{}
	_, err := SubmitChannelTransactionWithSigner(
		t.Context(), signer, signer, feePayer, svm.SolanaDevnetCAIP2,
		[]solana.Instruction{memoInstruction("settle")},
		SubmitSettleOptions{OnPrepared: func(string, string) error {
			return errors.New("storage unavailable")
		}},
	)
	require.ErrorContains(t, err, "storage unavailable")
	assert.Equal(t, 0, signer.sends)
}

func TestSubmitChannelTransactionWrapsSimulationFailure(t *testing.T) {
	feePayer := testKeypair(t).PublicKey()
	signer := &recordingChannelSigner{simErr: errors.New("bad simulation")}
	_, err := SubmitChannelTransactionWithSigner(
		t.Context(), signer, signer, feePayer, svm.SolanaDevnetCAIP2,
		[]solana.Instruction{memoInstruction("settle")},
		SubmitSettleOptions{},
	)
	var simErr *ChannelSimulationError
	require.ErrorAs(t, err, &simErr)
	assert.Equal(t, 0, signer.sends)
}

type staticChannelRPC struct {
	data  []byte
	calls int
}

func (s *staticChannelRPC) GetAccountInfo(
	context.Context, solana.PublicKey, *rpc.GetAccountInfoOpts,
) (*rpc.GetAccountInfoResult, error) {
	s.calls++
	if s.data == nil {
		return nil, rpc.ErrNotFound
	}
	return &rpc.GetAccountInfoResult{Value: &rpc.Account{Data: rpc.DataBytesOrJSONFromBytes(s.data)}}, nil
}

type recordingChannelSigner struct {
	sent        solana.Signature
	simErr      error
	confirmErr  error
	simulations int
	sends       int
	confirms    int
}

func (s *recordingChannelSigner) GetAddresses(context.Context, string) []solana.PublicKey {
	return nil
}

func (s *recordingChannelSigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return nil
}

func (s *recordingChannelSigner) SimulateTransaction(context.Context, *solana.Transaction, string, *svm.FacilitatorSimulateTransactionOptions) error {
	s.simulations++
	return s.simErr
}

func (s *recordingChannelSigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	s.sends++
	return s.sent, nil
}

func (s *recordingChannelSigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	s.confirms++
	return s.confirmErr
}

func (s *recordingChannelSigner) GetLatestBlockhash(context.Context, string) (solana.Hash, uint64, error) {
	return solana.Hash{1}, 1, nil
}

func unsignedMemoTransaction(t *testing.T, feePayer solana.PublicKey) string {
	t.Helper()
	tx, err := solana.NewTransactionBuilder().
		SetRecentBlockHash(solana.Hash{1}).
		SetFeePayer(feePayer).
		AddInstruction(memoInstruction("open")).
		Build()
	require.NoError(t, err)
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
	return encodeTransaction(t, tx)
}
