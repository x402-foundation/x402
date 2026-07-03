package signinwithx

import (
	"crypto/ed25519"

	"github.com/mr-tron/base58"
)

// DecodeBase58 decodes a Bitcoin-alphabet Base58 string.
func DecodeBase58(encoded string) ([]byte, error) {
	return base58.Decode(encoded)
}

// EncodeBase58 encodes bytes with the Bitcoin Base58 alphabet.
func EncodeBase58(bytes []byte) string {
	return base58.Encode(bytes)
}

// VerifySolanaSignature verifies an Ed25519 SIWS signature.
func VerifySolanaSignature(message string, signature []byte, publicKey []byte) bool {
	return ed25519.Verify(publicKey, []byte(message), signature)
}
