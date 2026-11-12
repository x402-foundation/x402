package casper

import (
	"fmt"

	"github.com/make-software/casper-go-sdk/v2/types/keypair"
)

// ClientSigner implements casper.ClientCasperSigner using a Casper keypair.
// It supports both ed25519 and secp256k1 keys.
type ClientSigner struct {
	key keypair.PrivateKey
}

// NewClientSignerFromKeyFile loads a Casper private key from a PEM file.
// algo must be "ed25519" or "secp256k1".
func NewClientSignerFromKeyFile(path, algo string) (*ClientSigner, error) {
	switch algo {
	case "ed25519", "":
		key, err := keypair.NewPrivateKeyFromFile(path, keypair.ED25519)
		if err != nil {
			return nil, fmt.Errorf("failed to load ed25519 key from %s: %w", path, err)
		}
		return &ClientSigner{key: key}, nil
	case "secp256k1":
		key, err := keypair.NewPrivateKeyFromFile(path, keypair.SECP256K1)
		if err != nil {
			return nil, fmt.Errorf("failed to load secp256k1 key from %s: %w", path, err)
		}
		return &ClientSigner{key: key}, nil
	default:
		return nil, fmt.Errorf("unsupported key algorithm: %q, must be 'ed25519' or 'secp256k1'", algo)
	}
}

// NewClientSignerFromSecret loads a Casper private key from a hex string.
// algo must be "ed25519" or "secp256k1".
func NewClientSignerFromSecret(privateKeyHex string, algo string) (*ClientSigner, error) {
	switch algo {
	case "ed25519", "":
		key, err := keypair.NewPrivateKeyFromSeedHex(privateKeyHex, keypair.ED25519)
		if err != nil {
			return nil, fmt.Errorf("failed to load ed25519 key: %w", err)
		}
		return &ClientSigner{key: key}, nil
	case "secp256k1":
		key, err := keypair.NewPrivateKeyFromHex(privateKeyHex, keypair.SECP256K1)
		if err != nil {
			return nil, fmt.Errorf("failed to load secp256k1 key: %w", err)
		}
		return &ClientSigner{key: key}, nil
	default:
		return nil, fmt.Errorf("unsupported key algorithm: %q, must be 'ed25519' or 'secp256k1'", algo)
	}
}

// AccountAddress returns the payer's Casper account hash as a 66-char hex string
// with a "00" prefix, e.g. "00aabb...". This format is required by the
// casper.ClientCasperSigner interface and validated by casper.IsValidAddress.
func (s *ClientSigner) AccountAddress() string {
	return "00" + s.key.PublicKey().AccountHash().ToHex()
}

// PublicKey returns the full public key hex (algo prefix byte + key bytes),
// e.g. "01aabb..." for ed25519 or "02aabb..." for secp256k1.
func (s *ClientSigner) PublicKey() string {
	return s.key.PublicKey().ToHex()
}

// SignEIP712 signs a 32-byte EIP-712 digest and returns a 65-byte signature.
// The signature format is [algo_byte][64_raw_sig_bytes], compatible with
// keypair.PublicKey.VerifySignature used by the Casper facilitator.
func (s *ClientSigner) SignEIP712(digest [32]byte) ([65]byte, error) {
	sig, err := s.key.Sign(digest[:])
	if err != nil {
		return [65]byte{}, fmt.Errorf("failed to sign EIP-712 digest: %w", err)
	}
	var result [65]byte
	copy(result[:], sig)
	return result, nil
}
