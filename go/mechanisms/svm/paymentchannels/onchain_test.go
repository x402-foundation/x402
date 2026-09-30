package paymentchannels

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

func TestTreasuryOwnerPerNetwork(t *testing.T) {
	assert.Equal(t, devnetTreasuryOwner, TreasuryOwner("solana-devnet"))
	assert.Equal(t, devnetTreasuryOwner, TreasuryOwner("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"))
	assert.Equal(t, mainnetTreasuryOwner, TreasuryOwner("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"))
}

func TestFindATAUsesTheGivenTokenProgram(t *testing.T) {
	owner := testKeypair(t).PublicKey()
	mint := testKeypair(t).PublicKey()

	legacy, err := FindATA(owner, mint, solana.TokenProgramID)
	require.NoError(t, err)
	token2022, err := FindATA(owner, mint, solana.Token2022ProgramID)
	require.NoError(t, err)

	assert.NotEqual(t, legacy, token2022)

	expectedLegacy, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	assert.Equal(t, expectedLegacy, legacy)
}

func TestFindChannelPDAIsSeedSensitive(t *testing.T) {
	fixture := newOpenFixture(t)

	base, err := FindChannelPDA(
		fixture.payerKey.PublicKey(), fixture.feePayer, fixture.mint, fixture.authorizer,
		fixture.salt, fixture.openSlot,
	)
	require.NoError(t, err)
	assert.Equal(t, fixture.built.ChannelID, base)

	otherSalt, err := FindChannelPDA(
		fixture.payerKey.PublicKey(), fixture.feePayer, fixture.mint, fixture.authorizer,
		fixture.salt+1, fixture.openSlot,
	)
	require.NoError(t, err)
	assert.NotEqual(t, base, otherSalt)

	otherSlot, err := FindChannelPDA(
		fixture.payerKey.PublicKey(), fixture.feePayer, fixture.mint, fixture.authorizer,
		fixture.salt, fixture.openSlot+1,
	)
	require.NoError(t, err)
	assert.NotEqual(t, base, otherSlot)
}

func TestBuildOpenInstructionAccountLayout(t *testing.T) {
	fixture := newOpenFixture(t)

	instruction, channelID, err := BuildOpenInstruction(OpenInstructionArgs{
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

	accounts := instruction.Accounts()
	require.Len(t, accounts, OpenAccountCount)
	assert.Equal(t, ProgramID, instruction.ProgramID())
	assert.Equal(t, fixture.built.ChannelID, channelID)

	channelATA, err := FindATA(channelID, fixture.mint, fixture.tokenProgram)
	require.NoError(t, err)
	payerATA, err := FindATA(fixture.payerKey.PublicKey(), fixture.mint, fixture.tokenProgram)
	require.NoError(t, err)
	eventAuthority, err := FindEventAuthorityPDA()
	require.NoError(t, err)

	expected := []solana.PublicKey{
		fixture.payerKey.PublicKey(), fixture.feePayer, fixture.feePayer, fixture.mint,
		fixture.authorizer, channelID, payerATA, channelATA, fixture.tokenProgram,
		solana.SystemProgramID, RentSysvar, solana.SPLAssociatedTokenAccountProgramID,
		eventAuthority, ProgramID,
	}
	for i, want := range expected {
		assert.Equal(t, want, accounts[i].PublicKey, "account slot %d", i)
	}

	assert.True(t, accounts[0].IsSigner && accounts[0].IsWritable, "payer must sign and be writable")
	assert.True(t, accounts[1].IsSigner && accounts[1].IsWritable, "rent payer must sign and be writable")
	for _, slot := range []int{5, 6, 7} {
		assert.True(t, accounts[slot].IsWritable, "account slot %d must be writable", slot)
		assert.False(t, accounts[slot].IsSigner, "account slot %d must not sign", slot)
	}

	data, err := instruction.Data()
	require.NoError(t, err)
	assert.Equal(t, uint8(generated.OpenDiscriminator), data[0])
	args, err := DecodeOpenArgs(data[1:])
	require.NoError(t, err)
	assert.Equal(t, fixture.deposit, args.Deposit)
	assert.Equal(t, fixture.salt, args.Salt)
}

func TestBuildSettleAndSealInstructions(t *testing.T) {
	channel := testKeypair(t).PublicKey()
	payee := testKeypair(t).PublicKey()
	signature := solana.Signature{1}

	tests := []struct {
		name       string
		voucher    *SettleVoucher
		wantFlag   byte
		wantCount  int
		settleSlot int
	}{
		{name: "without voucher", wantFlag: 0, wantCount: 1, settleSlot: 0},
		{
			name: "with voucher",
			voucher: &SettleVoucher{
				AuthorizedSigner: payee,
				SignatureBase58:  signature.String(),
				CumulativeAmount: 1,
				ExpiresAt:        2,
			},
			wantFlag:   1,
			wantCount:  2,
			settleSlot: 1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			instructions, err := BuildSettleAndSealInstructions(SettleAndSealBuildArgs{
				ChannelID: channel,
				Payee:     payee,
				Voucher:   test.voucher,
			})
			require.NoError(t, err)
			require.Len(t, instructions, test.wantCount)

			instruction := instructions[test.settleSlot]
			data, err := instruction.Data()
			require.NoError(t, err)
			assert.Equal(t, []byte{uint8(generated.SettleAndSealDiscriminator), test.wantFlag}, data)

			accounts := instruction.Accounts()
			require.Len(t, accounts, 3)
			assert.Equal(t, payee, accounts[0].PublicKey)
			assert.True(t, accounts[0].IsSigner, "payee is the lifecycle authority and must sign")
			assert.Equal(t, channel, accounts[1].PublicKey)
			assert.True(t, accounts[1].IsWritable)
			assert.Equal(t, InstructionsSysvar, accounts[2].PublicKey)
		})
	}
}

func TestBuildDistributeInstructionAppendsRecipientAccounts(t *testing.T) {
	channel := testKeypair(t).PublicKey()
	payer := testKeypair(t).PublicKey()
	payee := testKeypair(t).PublicKey()
	mint := testKeypair(t).PublicKey()
	payTo := testKeypair(t).PublicKey()
	network := "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

	instruction, err := BuildDistributeInstruction(DistributeInstructionArgs{
		Channel:      channel,
		Payer:        payer,
		Payee:        payee,
		RentPayer:    payee,
		Mint:         mint,
		TokenProgram: solana.TokenProgramID,
		Splits:       []Split{{Recipient: payTo.String(), BPS: BasisPointsDenominator}},
		Network:      network,
	})
	require.NoError(t, err)

	accounts := instruction.Accounts()
	require.Len(t, accounts, 12, "11 fixed accounts plus one recipient token account")

	treasuryATA, err := FindATA(TreasuryOwner(network), mint, solana.TokenProgramID)
	require.NoError(t, err)
	recipientATA, err := FindATA(payTo, mint, solana.TokenProgramID)
	require.NoError(t, err)
	assert.Equal(t, treasuryATA, accounts[6].PublicKey)
	assert.Equal(t, recipientATA, accounts[11].PublicKey)
	assert.True(t, accounts[11].IsWritable)

	data, err := instruction.Data()
	require.NoError(t, err)
	assert.Equal(t, uint8(generated.DistributeDiscriminator), data[0])
	assert.Equal(t, u32LE(1), data[1:5])
	assert.Equal(t, payTo.Bytes(), data[5:37])
	assert.Equal(t, u16LE(BasisPointsDenominator), data[37:39])
}

func TestBuildDistributeInstructionRejectsInvalidRecipient(t *testing.T) {
	_, err := BuildDistributeInstruction(DistributeInstructionArgs{
		Channel:      testKeypair(t).PublicKey(),
		Payer:        testKeypair(t).PublicKey(),
		Payee:        testKeypair(t).PublicKey(),
		RentPayer:    testKeypair(t).PublicKey(),
		Mint:         testKeypair(t).PublicKey(),
		TokenProgram: solana.TokenProgramID,
		Splits:       []Split{{Recipient: "not-an-address", BPS: BasisPointsDenominator}},
	})
	require.ErrorContains(t, err, "invalid distribution recipient")
}

func TestBuildReclaimInstruction(t *testing.T) {
	channel := testKeypair(t).PublicKey()
	rentPayer := testKeypair(t).PublicKey()

	instruction := BuildReclaimInstruction(channel, rentPayer)

	data, err := instruction.Data()
	require.NoError(t, err)
	assert.Equal(t, []byte{uint8(generated.ReclaimDiscriminator)}, data)

	accounts := instruction.Accounts()
	require.Len(t, accounts, 2)
	assert.Equal(t, channel, accounts[0].PublicKey)
	assert.Equal(t, rentPayer, accounts[1].PublicKey)
	assert.True(t, accounts[0].IsWritable && accounts[1].IsWritable)
}

func TestDecodeChannelLayout(t *testing.T) {
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
	copy(data[56:88], make([]byte, 32))
	copy(data[88:120], payer.Bytes())
	copy(data[120:152], payee.Bytes())
	copy(data[152:184], authorizedSigner.Bytes())
	copy(data[184:216], mint.Bytes())
	copy(data[216:248], rentPayer.Bytes())
	copy(data[248:256], u64LE(341_000_000))

	channel, err := DecodeChannel(data)
	require.NoError(t, err)

	assert.Equal(t, generated.ChannelStatus_Sealed, generated.ChannelStatus(channel.Status))
	assert.Equal(t, uint64(11), channel.Salt)
	assert.Equal(t, uint64(10_000), channel.Deposit)
	assert.Equal(t, uint64(1858), channel.Settlement.Settled)
	assert.Equal(t, uint32(3600), channel.GracePeriod)
	assert.Equal(t, payer, channel.Payer)
	assert.Equal(t, payee, channel.Payee)
	assert.Equal(t, authorizedSigner, channel.AuthorizedSigner)
	assert.Equal(t, mint, channel.Mint)
	assert.Equal(t, rentPayer, channel.RentPayer)
	assert.Equal(t, uint64(341_000_000), channel.OpenSlot)

	data[0] = 0
	_, err = DecodeChannel(data)
	require.ErrorContains(t, err, "not a payment channel")
}
