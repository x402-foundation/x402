package signinwithx

import (
	"crypto/ed25519"
	"fmt"

	"github.com/mr-tron/base58"
)

// Common Solana CAIP-2 network identifiers (genesis hash as chain reference).
const (
	SolanaMainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
	SolanaDevnet  = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
	SolanaTestnet = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"
)

// verifySolana verifies an Ed25519 SIWS signature. The address is the base58
// public key and the signature is base58-encoded.
func verifySolana(message string, p Payload) VerifyResult {
	pub, err := base58.Decode(p.Address)
	if err != nil {
		return VerifyResult{Error: fmt.Sprintf("invalid base58 address: %v", err)}
	}
	sig, err := base58.Decode(p.Signature)
	if err != nil {
		return VerifyResult{Error: fmt.Sprintf("invalid base58 signature: %v", err)}
	}
	if len(pub) != ed25519.PublicKeySize {
		return VerifyResult{Error: fmt.Sprintf("invalid public key length: expected %d, got %d", ed25519.PublicKeySize, len(pub))}
	}
	if len(sig) != ed25519.SignatureSize {
		return VerifyResult{Error: fmt.Sprintf("invalid signature length: expected %d, got %d", ed25519.SignatureSize, len(sig))}
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), []byte(message), sig) {
		return VerifyResult{Error: "signature verification failed"}
	}
	return VerifyResult{Valid: true, Address: p.Address}
}
