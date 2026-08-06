package signinwithx

import (
	"crypto/ed25519"

	"filippo.io/edwards25519"
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
	// Reject small-order public keys. Classic Ed25519 verify accepts
	// identity-point forgeries of the form (R=identity, S=0) for any message.
	var point edwards25519.Point
	if _, err := point.SetBytes(publicKey); err != nil {
		return false
	}
	var cofactored edwards25519.Point
	if cofactored.MultByCofactor(&point).Equal(edwards25519.NewIdentityPoint()) == 1 {
		return false
	}

	return ed25519.Verify(publicKey, []byte(message), signature)
}
