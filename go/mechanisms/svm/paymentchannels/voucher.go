package paymentchannels

import (
	"crypto/ed25519"
	"fmt"

	solana "github.com/gagliardetto/solana-go"
)

// VoucherMessageSize is the fixed length of the signed voucher payload.
const VoucherMessageSize = 50

// voucherMagic prefixes the signed payload. The program rejects vouchers
// without it; the wire JSON never carries it.
var voucherMagic = [2]byte{0x56, 0x01}

// EncodeVoucherMessage builds the canonical 50-byte voucher payload:
// magic(2) || channelId(32) || u64le(cumulativeAmount) || i64le(expiresAt).
func EncodeVoucherMessage(channelID solana.PublicKey, cumulativeAmount uint64, expiresAt int64) []byte {
	out := make([]byte, 0, VoucherMessageSize)
	out = append(out, voucherMagic[0], voucherMagic[1])
	out = append(out, channelID.Bytes()...)
	out = append(out, u64LE(cumulativeAmount)...)
	out = append(out, i64LE(expiresAt)...)
	return out
}

// VerifyVoucherSignature checks a base58 Ed25519 signature over the voucher
// message against the base58 authorized signer.
func VerifyVoucherSignature(signatureBase58, signerBase58 string, message []byte) error {
	signature, err := solana.SignatureFromBase58(signatureBase58)
	if err != nil {
		return fmt.Errorf("voucher signature is not valid base58: %w", err)
	}
	signer, err := solana.PublicKeyFromBase58(signerBase58)
	if err != nil {
		return fmt.Errorf("authorized signer is not a valid base58 address: %w", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(signer.Bytes()), message, signature[:]) {
		return fmt.Errorf("voucher signature is not signed by %s", signerBase58)
	}
	return nil
}

// BuildEd25519VerifyInstruction builds the Ed25519 precompile instruction that
// carries a voucher to the program. Layout matches the payment-channels Rust
// helper: a 16-byte offset header, then signer, signature, and message.
func BuildEd25519VerifyInstruction(
	message []byte,
	signature []byte,
	signer solana.PublicKey,
) (solana.Instruction, error) {
	if len(signature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("voucher signature must be %d bytes, got %d", ed25519.SignatureSize, len(signature))
	}
	if len(message) > 0xffff {
		return nil, fmt.Errorf("voucher message too long: %d bytes", len(message))
	}

	const (
		publicKeyOffset    = 16
		signatureOffset    = publicKeyOffset + ed25519.PublicKeySize
		messageDataOffset  = signatureOffset + ed25519.SignatureSize
		currentInstruction = 0xffff
	)

	data := make([]byte, messageDataOffset+len(message))
	data[0] = 1 // num_signatures
	data[1] = 0 // padding
	copy(data[2:4], u16LE(signatureOffset))
	copy(data[4:6], u16LE(currentInstruction))
	copy(data[6:8], u16LE(publicKeyOffset))
	copy(data[8:10], u16LE(currentInstruction))
	copy(data[10:12], u16LE(messageDataOffset))
	copy(data[12:14], u16LE(uint16(len(message))))
	copy(data[14:16], u16LE(currentInstruction))
	copy(data[publicKeyOffset:], signer.Bytes())
	copy(data[signatureOffset:], signature)
	copy(data[messageDataOffset:], message)

	return solana.NewInstruction(Ed25519ProgramID, solana.AccountMetaSlice{}, data), nil
}
