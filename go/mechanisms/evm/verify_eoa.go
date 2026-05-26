package evm

import (
	"errors"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// VerifyEOASignature verifies an ECDSA signature from an externally owned account (EOA)
//
// This function uses secp256k1 public key recovery to verify that the signature
// was created by the expected address. It handles the Ethereum-specific v value
// adjustment (27/28 → 0/1 for recovery).
//
// Args:
//
//	hash: The 32-byte message hash that was signed
//	signature: The 65-byte ECDSA signature (r: 32 bytes, s: 32 bytes, v: 1 byte)
//	expectedAddress: The Ethereum address that should have signed the message
//
// Returns:
//
//	true if the signature is valid and recovers to the expected address
//	error if the signature is malformed or recovery fails
func VerifyEOASignature(
	hash []byte,
	signature []byte,
	expectedAddress common.Address,
) (bool, error) {
	if len(signature) != 65 {
		return false, errors.New("invalid EOA signature length: expected 65 bytes")
	}

	// Create a copy to avoid modifying the original signature
	sig := make([]byte, 65)
	copy(sig, signature)

	// Adjust v value for recovery
	// Ethereum uses v = 27 or 28, but crypto.SigToPub expects v = 0 or 1
	v := sig[64]
	if v >= 27 {
		sig[64] = v - 27
	}

	// Recover the public key from the signature
	pubKey, err := crypto.SigToPub(hash, sig)
	if err != nil {
		return false, err
	}

	// Derive the Ethereum address from the recovered public key
	recoveredAddress := crypto.PubkeyToAddress(*pubKey)

	// Compare the recovered address with the expected address
	return recoveredAddress == expectedAddress, nil
}
