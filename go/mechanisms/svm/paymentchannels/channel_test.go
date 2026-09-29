package paymentchannels

import (
	"bytes"
	"crypto/sha256"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDistributionHashMatchesProgramPreimage(t *testing.T) {
	recipient := solana.MustPublicKeyFromBase58("11111111111111111111111111111112")

	hash, err := DistributionHash([]Split{{Recipient: recipient.String(), BPS: BasisPointsDenominator}})
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

	hash, err := DistributionHash([]Split{
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

func TestDecodeChannelLayout(t *testing.T) {
	payer := testKeypair(t).PublicKey()
	payee := testKeypair(t).PublicKey()
	authorizedSigner := testKeypair(t).PublicKey()
	mint := testKeypair(t).PublicKey()
	rentPayer := testKeypair(t).PublicKey()

	data := make([]byte, ChannelAccountSize)
	data[0] = ChannelAccountDiscriminator
	data[3] = byte(StatusSealed)
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

	assert.Equal(t, StatusSealed, channel.Status)
	assert.Equal(t, uint64(11), channel.Salt)
	assert.Equal(t, uint64(10_000), channel.Deposit)
	assert.Equal(t, uint64(1858), channel.Settled)
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
