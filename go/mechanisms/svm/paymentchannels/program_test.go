package paymentchannels

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
