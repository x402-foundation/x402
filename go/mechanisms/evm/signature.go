package evm

import (
	"math/big"

	"github.com/ethereum/go-ethereum/crypto"
)

var secp256k1HalfN = new(big.Int).Rsh(crypto.S256().Params().N, 1)

// IsCanonicalECDSASignature reports whether a 65-byte ECDSA signature uses a low-s value.
func IsCanonicalECDSASignature(signature []byte) bool {
	if len(signature) != 65 {
		return false
	}

	s := new(big.Int).SetBytes(signature[32:64])
	return s.Cmp(secp256k1HalfN) <= 0
}
