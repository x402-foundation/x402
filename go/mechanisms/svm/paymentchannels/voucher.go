package paymentchannels

import (
	"context"
	"crypto/ed25519"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
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

// VerifyEd25519Signature checks a raw Ed25519 signature over message.
func VerifyEd25519Signature(publicKey, signature, message []byte) error {
	if len(publicKey) != ed25519.PublicKeySize {
		return fmt.Errorf("publicKey must be %d bytes, got %d", ed25519.PublicKeySize, len(publicKey))
	}
	if len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("signature must be %d bytes, got %d", ed25519.SignatureSize, len(signature))
	}
	if !ed25519.Verify(publicKey, message, signature) {
		return fmt.Errorf("ed25519 signature verification failed")
	}
	return nil
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
	if err := VerifyEd25519Signature(signer.Bytes(), signature[:], message); err != nil {
		return fmt.Errorf("voucher signature is not signed by %s", signerBase58)
	}
	return nil
}

// SignVoucher signs the canonical voucher message and returns the base58 signature.
func SignVoucher(
	ctx context.Context,
	authorizer svm.ReceiverAuthorizerSigner,
	channelID solana.PublicKey,
	cumulativeAmount uint64,
	expiresAt int64,
) (string, error) {
	signature, err := authorizer.SignMessage(ctx, EncodeVoucherMessage(channelID, cumulativeAmount, expiresAt))
	if err != nil {
		return "", err
	}
	if len(signature) != ed25519.SignatureSize {
		return "", fmt.Errorf("voucher signature must be %d bytes, got %d", ed25519.SignatureSize, len(signature))
	}
	return solana.SignatureFromBytes(signature).String(), nil
}
