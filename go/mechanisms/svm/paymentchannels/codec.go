package paymentchannels

import (
	"encoding/binary"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

func u16LE(v uint16) []byte {
	out := make([]byte, 2)
	binary.LittleEndian.PutUint16(out, v)
	return out
}

func u32LE(v uint32) []byte {
	out := make([]byte, 4)
	binary.LittleEndian.PutUint32(out, v)
	return out
}

func u64LE(v uint64) []byte {
	out := make([]byte, 8)
	binary.LittleEndian.PutUint64(out, v)
	return out
}

func i64LE(v int64) []byte {
	return u64LE(uint64(v))
}

// OpenArgs are the borsh-encoded arguments of the `open` instruction.
type OpenArgs struct {
	Salt        uint64
	Deposit     uint64
	GracePeriod uint32
	OpenSlot    uint64
	Recipients  []Split
}

// EncodeOpenArgs serializes the open arguments in program (borsh) order.
func EncodeOpenArgs(args OpenArgs) ([]byte, error) {
	out := make([]byte, 0, 28+len(args.Recipients)*34)
	out = append(out, u64LE(args.Salt)...)
	out = append(out, u64LE(args.Deposit)...)
	out = append(out, u32LE(args.GracePeriod)...)
	out = append(out, u64LE(args.OpenSlot)...)
	entries, err := encodeDistributionEntries(args.Recipients)
	if err != nil {
		return nil, err
	}
	return append(out, entries...), nil
}

// DecodeOpenArgs deserializes open arguments, rejecting truncated data and
// trailing bytes so a client cannot smuggle extra payload past the verifier.
func DecodeOpenArgs(data []byte) (OpenArgs, error) {
	const fixedLen = 8 + 8 + 4 + 8 + 4
	if len(data) < fixedLen {
		return OpenArgs{}, fmt.Errorf("open args truncated: %d bytes", len(data))
	}
	args := OpenArgs{
		Salt:        binary.LittleEndian.Uint64(data[0:8]),
		Deposit:     binary.LittleEndian.Uint64(data[8:16]),
		GracePeriod: binary.LittleEndian.Uint32(data[16:20]),
		OpenSlot:    binary.LittleEndian.Uint64(data[20:28]),
	}

	count := binary.LittleEndian.Uint32(data[28:32])
	rest := data[32:]
	if uint64(len(rest)) != uint64(count)*34 {
		return OpenArgs{}, fmt.Errorf(
			"open args recipient section is %d bytes, expected %d for %d recipients",
			len(rest), uint64(count)*34, count,
		)
	}

	args.Recipients = make([]Split, 0, count)
	for i := uint32(0); i < count; i++ {
		offset := int(i) * 34
		recipient := solana.PublicKeyFromBytes(rest[offset : offset+32])
		args.Recipients = append(args.Recipients, Split{
			Recipient: recipient.String(),
			BPS:       binary.LittleEndian.Uint16(rest[offset+32 : offset+34]),
		})
	}
	return args, nil
}

func encodeDistributionEntries(splits []Split) ([]byte, error) {
	out := make([]byte, 0, 4+len(splits)*34)
	out = append(out, u32LE(uint32(len(splits)))...)
	for _, split := range splits {
		recipient, err := solana.PublicKeyFromBase58(split.Recipient)
		if err != nil {
			return nil, fmt.Errorf("invalid distribution recipient %s: %w", split.Recipient, err)
		}
		out = append(out, recipient.Bytes()...)
		out = append(out, u16LE(split.BPS)...)
	}
	return out, nil
}
