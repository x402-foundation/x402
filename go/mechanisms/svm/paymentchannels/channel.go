package paymentchannels

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

const (
	// ChannelAccountSize is the fixed byte length of the channel account layout
	// this scheme targets. Discovery filters on it via getProgramAccounts.
	ChannelAccountSize = 256

	// ChannelAccountDiscriminator is AccountDiscriminator::Channel; byte 0 is
	// reserved for uninitialized accounts.
	ChannelAccountDiscriminator uint8 = 1

	// Field offsets into the account layout, past the fixed-width scalar
	// prefix. Also usable as getProgramAccounts memcmp offsets.
	ChannelPayerOffset            = 88
	ChannelPayeeOffset            = 120
	ChannelAuthorizedSignerOffset = 152
	ChannelMintOffset             = 184
	ChannelRentPayerOffset        = 216
	ChannelOpenSlotOffset         = 248
)

// Channel is the decoded onchain channel account.
type Channel struct {
	Discriminator    uint8
	Version          uint8
	Bump             uint8
	Status           ChannelStatus
	Salt             uint64
	Deposit          uint64
	Settled          uint64
	PayoutWatermark  uint64
	ClosureStartedAt int64
	PayerWithdrawnAt int64
	GracePeriod      uint32
	DistributionHash [32]byte
	Payer            solana.PublicKey
	Payee            solana.PublicKey
	AuthorizedSigner solana.PublicKey
	Mint             solana.PublicKey
	RentPayer        solana.PublicKey
	OpenSlot         uint64
}

// DecodeChannel decodes a channel account. Accounts shorter than the supported
// layout are rejected rather than zero-filled; the byte offsets are only valid
// for this channel-account version.
func DecodeChannel(data []byte) (*Channel, error) {
	if len(data) < ChannelAccountSize {
		return nil, fmt.Errorf("channel account is %d bytes, expected at least %d", len(data), ChannelAccountSize)
	}
	channel := &Channel{
		Discriminator:    data[0],
		Version:          data[1],
		Bump:             data[2],
		Status:           ChannelStatus(data[3]),
		Salt:             binary.LittleEndian.Uint64(data[4:12]),
		Deposit:          binary.LittleEndian.Uint64(data[12:20]),
		Settled:          binary.LittleEndian.Uint64(data[20:28]),
		PayoutWatermark:  binary.LittleEndian.Uint64(data[28:36]),
		ClosureStartedAt: int64(binary.LittleEndian.Uint64(data[36:44])),
		PayerWithdrawnAt: int64(binary.LittleEndian.Uint64(data[44:52])),
		GracePeriod:      binary.LittleEndian.Uint32(data[52:56]),
		Payer:            solana.PublicKeyFromBytes(data[ChannelPayerOffset : ChannelPayerOffset+32]),
		Payee:            solana.PublicKeyFromBytes(data[ChannelPayeeOffset : ChannelPayeeOffset+32]),
		AuthorizedSigner: solana.PublicKeyFromBytes(data[ChannelAuthorizedSignerOffset : ChannelAuthorizedSignerOffset+32]),
		Mint:             solana.PublicKeyFromBytes(data[ChannelMintOffset : ChannelMintOffset+32]),
		RentPayer:        solana.PublicKeyFromBytes(data[ChannelRentPayerOffset : ChannelRentPayerOffset+32]),
		OpenSlot:         binary.LittleEndian.Uint64(data[ChannelOpenSlotOffset : ChannelOpenSlotOffset+8]),
	}
	copy(channel.DistributionHash[:], data[56:88])

	if channel.Discriminator != ChannelAccountDiscriminator {
		return nil, fmt.Errorf("account discriminator %d is not a payment channel", channel.Discriminator)
	}
	return channel, nil
}

// DistributionHash computes the distribution commitment the program stores at
// open and re-checks at distribute: SHA-256 over u32le(count) followed by each
// recipient pubkey and its u16le basis points.
func DistributionHash(splits []Split) ([32]byte, error) {
	hasher := sha256.New()
	hasher.Write(u32LE(uint32(len(splits))))
	for _, split := range splits {
		recipient, err := solana.PublicKeyFromBase58(split.Recipient)
		if err != nil {
			return [32]byte{}, fmt.Errorf("invalid distribution recipient %s: %w", split.Recipient, err)
		}
		hasher.Write(recipient.Bytes())
		hasher.Write(u16LE(split.BPS))
	}
	var out [32]byte
	copy(out[:], hasher.Sum(nil))
	return out, nil
}
