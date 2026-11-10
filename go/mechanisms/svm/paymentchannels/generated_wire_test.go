package paymentchannels

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	ag_binary "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

func TestGeneratedOpenArgsRoundTrip(t *testing.T) {
	recipient := testKeypair(t).PublicKey()
	args := generated.OpenArgs{
		Salt:        7,
		Deposit:     123456,
		GracePeriod: 900,
		OpenSlot:    999,
		Recipients: []generated.DistributionEntry{{
			Recipient: recipient,
			Bps:       BasisPointsDenominator,
		}},
	}
	encoded := mustBorshEncode(t, args)

	decoded, err := DecodeOpenArgs(encoded)
	require.NoError(t, err)
	assert.Equal(t, args, decoded)
}

func TestGeneratedOpenInstructionMatchesLayout(t *testing.T) {
	fixture := newOpenFixture(t)
	handwritten, channelID, err := BuildOpenInstruction(OpenInstructionArgs{
		Payer:            fixture.payerKey.PublicKey(),
		RentPayer:        fixture.feePayer,
		Payee:            fixture.feePayer,
		Mint:             fixture.mint,
		AuthorizedSigner: fixture.authorizer,
		TokenProgram:     fixture.tokenProgram,
		Args: generated.OpenArgs{
			Salt:        fixture.salt,
			Deposit:     fixture.deposit,
			GracePeriod: fixture.graceSeconds,
			OpenSlot:    fixture.openSlot,
			Recipients: []generated.DistributionEntry{{
				Recipient: fixture.payTo,
				Bps:       BasisPointsDenominator,
			}},
		},
	})
	require.NoError(t, err)

	payerATA, err := FindATA(fixture.payerKey.PublicKey(), fixture.mint, fixture.tokenProgram)
	require.NoError(t, err)
	channelATA, err := FindATA(channelID, fixture.mint, fixture.tokenProgram)
	require.NoError(t, err)
	eventAuthority, err := FindEventAuthorityPDA()
	require.NoError(t, err)

	instruction := generated.NewOpenInstructionBuilder().
		SetPayerAccount(fixture.payerKey.PublicKey()).
		SetRentPayerAccount(fixture.feePayer).
		SetPayeeAccount(fixture.feePayer).
		SetMintAccount(fixture.mint).
		SetAuthorizedSignerAccount(fixture.authorizer).
		SetChannelAccount(channelID).
		SetPayerTokenAccountAccount(payerATA).
		SetChannelTokenAccountAccount(channelATA).
		SetTokenProgramAccount(fixture.tokenProgram).
		SetSystemProgramAccount(solana.SystemProgramID).
		SetRentAccount(RentSysvar).
		SetAssociatedTokenProgramAccount(solana.SPLAssociatedTokenAccountProgramID).
		SetEventAuthorityAccount(eventAuthority).
		SetSelfProgramAccount(ProgramID).
		SetOpenArgs(generated.OpenArgs{
			Salt:        fixture.salt,
			Deposit:     fixture.deposit,
			GracePeriod: fixture.graceSeconds,
			OpenSlot:    fixture.openSlot,
			Recipients: []generated.DistributionEntry{{
				Recipient: fixture.payTo,
				Bps:       BasisPointsDenominator,
			}},
		}).
		Build()

	want, err := handwritten.Data()
	require.NoError(t, err)
	got, err := instruction.Data()
	require.NoError(t, err)
	assert.Equal(t, want, got)
	assert.Equal(t, ProgramID, instruction.ProgramID())
	assertSameAccountMetas(t, handwritten.Accounts(), instruction.Accounts())

	decoded, err := generated.DecodeInstruction(instruction.Accounts(), got)
	require.NoError(t, err)
	open, ok := decoded.Impl.(*generated.Open)
	require.True(t, ok)
	assert.Equal(t, fixture.deposit, open.OpenArgs.Deposit)
	assert.Equal(t, fixture.salt, open.OpenArgs.Salt)
	assert.Equal(t, fixture.payTo, open.OpenArgs.Recipients[0].Recipient)
}

func TestGeneratedSettleAndSealAndDistributeMatchLayout(t *testing.T) {
	channel := testKeypair(t).PublicKey()
	payee := testKeypair(t).PublicKey()
	signature := solana.Signature{1}
	built, err := BuildSettleAndSealInstructions(SettleAndSealBuildArgs{
		ChannelID: channel,
		Payee:     payee,
		Voucher: &SettleVoucher{
			AuthorizedSigner: payee,
			SignatureBase58:  signature.String(),
			CumulativeAmount: 1,
			ExpiresAt:        2,
		},
	})
	require.NoError(t, err)
	require.Len(t, built, 2)
	instruction := generated.NewSettleAndSealInstructionBuilder().
		SetPayeeAccount(payee).
		SetChannelAccount(channel).
		SetInstructionsSysvarAccount(InstructionsSysvar).
		SetSettleAndSealArgs(generated.SettleAndSealArgs{HasVoucher: 1}).
		Build()

	want, err := built[1].Data()
	require.NoError(t, err)
	got, err := instruction.Data()
	require.NoError(t, err)
	assert.Equal(t, want, got)
	assertSameAccountMetas(t, built[1].Accounts(), instruction.Accounts())

	mint := testKeypair(t).PublicKey()
	payer := testKeypair(t).PublicKey()
	rentPayer := testKeypair(t).PublicKey()
	payTo := testKeypair(t).PublicKey()
	network := "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
	distribute, err := BuildDistributeInstruction(DistributeInstructionArgs{
		Channel:      channel,
		Payer:        payer,
		Payee:        payee,
		RentPayer:    rentPayer,
		Mint:         mint,
		TokenProgram: solana.TokenProgramID,
		Splits:       []Split{{Recipient: payTo.String(), BPS: BasisPointsDenominator}},
		Network:      network,
	})
	require.NoError(t, err)

	channelATA, err := FindATA(channel, mint, solana.TokenProgramID)
	require.NoError(t, err)
	payerATA, err := FindATA(payer, mint, solana.TokenProgramID)
	require.NoError(t, err)
	payeeATA, err := FindATA(payee, mint, solana.TokenProgramID)
	require.NoError(t, err)
	treasuryATA, err := FindATA(TreasuryOwner(network), mint, solana.TokenProgramID)
	require.NoError(t, err)
	eventAuthority, err := FindEventAuthorityPDA()
	require.NoError(t, err)
	generatedDistribute := generated.NewDistributeInstructionBuilder().
		SetChannelAccount(channel).
		SetPayerAccount(payer).
		SetRentPayerAccount(rentPayer).
		SetChannelTokenAccountAccount(channelATA).
		SetPayerTokenAccountAccount(payerATA).
		SetPayeeTokenAccountAccount(payeeATA).
		SetTreasuryTokenAccountAccount(treasuryATA).
		SetMintAccount(mint).
		SetTokenProgramAccount(solana.TokenProgramID).
		SetEventAuthorityAccount(eventAuthority).
		SetSelfProgramAccount(ProgramID).
		SetDistributeArgs(generated.DistributeArgs{
			Recipients: []generated.DistributionEntry{{
				Recipient: payTo,
				Bps:       BasisPointsDenominator,
			}},
		}).
		Build()

	wantData, err := distribute.Data()
	require.NoError(t, err)
	gotData, err := generatedDistribute.Data()
	require.NoError(t, err)
	assert.Equal(t, wantData, gotData)
	assertSameAccountMetas(t, distribute.Accounts()[:11], generatedDistribute.Accounts())
}

func TestGeneratedChannelLayoutMatchesDecoder(t *testing.T) {
	payer := testKeypair(t).PublicKey()
	payee := testKeypair(t).PublicKey()
	authorizedSigner := testKeypair(t).PublicKey()
	mint := testKeypair(t).PublicKey()
	rentPayer := testKeypair(t).PublicKey()

	data := make([]byte, ChannelAccountSize)
	data[0] = uint8(generated.AccountDiscriminator_Channel)
	data[3] = byte(generated.ChannelStatus_Sealed)
	copy(data[4:12], u64LE(11))
	copy(data[12:20], u64LE(10_000))
	copy(data[20:28], u64LE(1858))
	copy(data[52:56], u32LE(3600))
	copy(data[88:120], payer.Bytes())
	copy(data[120:152], payee.Bytes())
	copy(data[152:184], authorizedSigner.Bytes())
	copy(data[184:216], mint.Bytes())
	copy(data[216:248], rentPayer.Bytes())
	copy(data[248:256], u64LE(341_000_000))

	channel, err := DecodeChannel(data)
	require.NoError(t, err)

	var decoded generated.Channel
	require.NoError(t, ag_binary.NewBorshDecoder(data).Decode(&decoded))
	assert.Equal(t, channel.Discriminator, decoded.Discriminator)
	assert.Equal(t, channel.Status, decoded.Status)
	assert.Equal(t, channel.Salt, decoded.Salt)
	assert.Equal(t, channel.Deposit, decoded.Deposit)
	assert.Equal(t, channel.Settlement, decoded.Settlement)
	assert.Equal(t, channel.GracePeriod, decoded.GracePeriod)
	assert.Equal(t, channel.Payer, decoded.Payer)
	assert.Equal(t, channel.Payee, decoded.Payee)
	assert.Equal(t, channel.AuthorizedSigner, decoded.AuthorizedSigner)
	assert.Equal(t, channel.Mint, decoded.Mint)
	assert.Equal(t, channel.RentPayer, decoded.RentPayer)
	assert.Equal(t, channel.OpenSlot, decoded.OpenSlot)
	assert.Equal(t, channel.DistributionHash, decoded.DistributionHash)
}

func TestGeneratedDistributionAndVoucherMatchGoldens(t *testing.T) {
	recipientOne := solana.PublicKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	recipientTwo := solana.PublicKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	entries := []generated.DistributionEntry{
		{Recipient: recipientOne, Bps: 7_500},
		{Recipient: recipientTwo, Bps: 2_500},
	}
	encoded := mustBorshEncode(t, entries)
	assert.Equal(t, [32]byte{
		0x54, 0xc8, 0x97, 0x55, 0x87, 0x75, 0x0e, 0x88, 0x21, 0xe9, 0x3f, 0x5d, 0x4a, 0xf6, 0x07,
		0xd2, 0x0d, 0x55, 0xa5, 0x8b, 0xa1, 0xb9, 0xa4, 0xb4, 0x9f, 0x72, 0xa5, 0x42, 0xed, 0x87,
		0x4a, 0x3f,
	}, sha256.Sum256(encoded))

	channel := solana.MustPublicKeyFromBase58(svm.USDCMainnetAddress)
	voucher := generated.VoucherArgs{
		Magic:            [2]uint8{0x56, 0x01},
		ChannelId:        channel,
		CumulativeAmount: 1_000_000,
		ExpiresAt:        4_102_444_800,
	}
	assert.Equal(t,
		"5601c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d6140420f0000000000005786f400000000",
		hex.EncodeToString(mustBorshEncode(t, voucher)),
	)
}

func mustBorshEncode[T any](t *testing.T, value T) []byte {
	t.Helper()
	buf := new(bytes.Buffer)
	require.NoError(t, ag_binary.NewBorshEncoder(buf).Encode(value))
	return buf.Bytes()
}

func assertSameAccountMetas(t *testing.T, want, got []*solana.AccountMeta) {
	t.Helper()
	require.Len(t, got, len(want))
	for i := range want {
		assert.Equal(t, want[i].PublicKey, got[i].PublicKey, "account %d", i)
		assert.Equal(t, want[i].IsSigner, got[i].IsSigner, "signer %d", i)
		assert.Equal(t, want[i].IsWritable, got[i].IsWritable, "writable %d", i)
	}
}
