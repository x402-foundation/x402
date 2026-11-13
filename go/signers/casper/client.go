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
	key, err := NewPrivateKeyFromSecret(privateKeyHex, algo)
	if err != nil {
		return nil, err
	}
	return &ClientSigner{key: *key}, nil
}

// AccountAddress returns the account hash as 66 hex chars with a "00" prefix.
func (s *ClientSigner) AccountAddress() string {
	return "00" + s.key.PublicKey().AccountHash().ToHex()
}

// PublicKey returns the full public key hex (algo prefix byte + key bytes),
// e.g. "01aabb..." for ed25519 or "02aabb..." for secp256k1.
func (s *ClientSigner) PublicKey() string {
	return s.key.PublicKey().ToHex()
}

// SignEIP712 signs a 32-byte digest and returns a 65-byte signature.
// Byte 0 is the algorithm tag, followed by 64 signature bytes.
func (s *ClientSigner) SignEIP712(digest [32]byte) ([65]byte, error) {
	sig, err := s.key.Sign(digest[:])
	if err != nil {
		return [65]byte{}, fmt.Errorf("failed to sign EIP-712 digest: %w", err)
	}
	var result [65]byte
	copy(result[:], sig)
	return result, nil
}
