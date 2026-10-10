package paymentchannels

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

// The open verifier reads a ComputeBudget prefix and static account keys that
// only legacy and v0 messages carry in the shape it models, so any other
// version must be refused before a single instruction is inspected.
func TestVerifyOpenTransactionRejectsUnsupportedTransactionVersions(t *testing.T) {
	fixture := newOpenFixture(t)
	payer := solana.NewWallet()
	tx, err := solana.NewTransaction(
		[]solana.Instruction{solana.NewInstruction(solana.MemoProgramID, nil, []byte("v1"))},
		solana.Hash{},
		solana.TransactionPayer(payer.PublicKey()),
		solana.TransactionV1Config(solana.TransactionConfig{}.
			WithComputeUnitLimit(10_000).
			WithLoadedAccountsDataSizeLimit(65_536)),
	)
	require.NoError(t, err)
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(payer.PublicKey()) {
			return &payer.PrivateKey
		}
		return nil
	})
	require.NoError(t, err)
	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)

	_, err = VerifyOpenTransaction(encoded, fixture.expected())
	require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
	require.ErrorContains(t, err, "unsupported transaction message version 1")
}

func TestVerifyChannelTransactionsRejectV1HeaderBudgets(t *testing.T) {
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
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, version := range []string{"v0", "v1"} {
				t.Run(version, func(t *testing.T) {
					opts := []solana.TransactionOption{solana.TransactionPayer(feePayer)}
					if version == "v1" {
						opts = append(opts, solana.TransactionV1Config(solana.TransactionConfig{}.
							WithComputeUnitLimit(1_400_000).
							WithLoadedAccountsDataSizeLimit(65_536).
							WithPriorityFee(1_000_000_000)))
					}
					tx, err := solana.NewTransaction([]solana.Instruction{
						test.instruction, memoInstruction("0123456789abcdef0123456789abcdef"),
					}, solana.Hash{}, opts...)
					require.NoError(t, err)
					if version == "v0" {
						_, err = tx.Message.SetVersion(solana.MessageVersionV0)
						require.NoError(t, err)
					}
					tx.Signatures = make([]solana.Signature, tx.Message.Header.NumRequiredSignatures)
					signTransaction(t, tx, payer)
					wire := encodeTransaction(t, tx)
					if version == "v0" {
						require.NoError(t, test.verify(wire))
						return
					}
					_, err = BroadcastOpen(context.Background(), nil, feePayer, "", wire, ChannelBroadcastHooks{})
					require.ErrorContains(t, err, svm.ErrUnsupportedTransactionVersion)
					require.ErrorContains(t, test.verify(wire), svm.ErrUnsupportedTransactionVersion)
				})
			}
		})
	}
}
