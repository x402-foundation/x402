package paymentchannels

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildOpenInstructionAccountLayout(t *testing.T) {
	fixture := newOpenFixture(t)

	instruction, channelID, err := BuildOpenInstruction(OpenInstructionArgs{
		Payer:            fixture.payerKey.PublicKey(),
		RentPayer:        fixture.feePayer,
		Payee:            fixture.feePayer,
		Mint:             fixture.mint,
		AuthorizedSigner: fixture.authorizer,
		TokenProgram:     fixture.tokenProgram,
		Args: OpenArgs{
			Salt:        fixture.salt,
			Deposit:     fixture.deposit,
			GracePeriod: fixture.graceSeconds,
			OpenSlot:    fixture.openSlot,
			Recipients:  []Split{{Recipient: fixture.payTo.String(), BPS: BasisPointsDenominator}},
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
	assert.Equal(t, OpenDiscriminator, data[0])
	args, err := DecodeOpenArgs(data[1:])
	require.NoError(t, err)
	assert.Equal(t, fixture.deposit, args.Deposit)
	assert.Equal(t, fixture.salt, args.Salt)
}

func TestBuildSettleAndSealInstruction(t *testing.T) {
	channel := testKeypair(t).PublicKey()
	payee := testKeypair(t).PublicKey()

	tests := []struct {
		name       string
		hasVoucher bool
		wantFlag   byte
	}{
		{name: "with voucher", hasVoucher: true, wantFlag: 1},
		{name: "without voucher", hasVoucher: false, wantFlag: 0},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			instruction := BuildSettleAndSealInstruction(channel, payee, test.hasVoucher)

			data, err := instruction.Data()
			require.NoError(t, err)
			assert.Equal(t, []byte{SettleAndSealDiscriminator, test.wantFlag}, data)

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
	assert.Equal(t, DistributeDiscriminator, data[0])
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
	assert.Equal(t, []byte{ReclaimDiscriminator}, data)

	accounts := instruction.Accounts()
	require.Len(t, accounts, 2)
	assert.Equal(t, channel, accounts[0].PublicKey)
	assert.Equal(t, rentPayer, accounts[1].PublicKey)
	assert.True(t, accounts[0].IsWritable && accounts[1].IsWritable)
}
