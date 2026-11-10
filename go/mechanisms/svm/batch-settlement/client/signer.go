package client

import (
	"context"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// BatchClientSigner signs the open or top-up transaction and the Ed25519
// voucher or payer authorization attached to it.
type BatchClientSigner interface {
	svm.ClientSvmSigner
	SignMessage(ctx context.Context, message []byte) ([]byte, error)
}

// PrivateKeySigner signs with one Ed25519 key.
type PrivateKeySigner struct {
	privateKey solana.PrivateKey
}

// NewPrivateKeySigner parses a base58 Solana private key.
func NewPrivateKeySigner(privateKeyBase58 string) (*PrivateKeySigner, error) {
	privateKey, err := solana.PrivateKeyFromBase58(privateKeyBase58)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}
	return &PrivateKeySigner{privateKey: privateKey}, nil
}

// Address returns the signer's Solana address.
func (s *PrivateKeySigner) Address() solana.PublicKey {
	return s.privateKey.PublicKey()
}

// SignMessage signs raw message bytes and returns the 64-byte signature.
func (s *PrivateKeySigner) SignMessage(_ context.Context, message []byte) ([]byte, error) {
	signature, err := s.privateKey.Sign(message)
	if err != nil {
		return nil, err
	}
	return signature[:], nil
}

// SignTransaction adds this key's signature at its account index.
func (s *PrivateKeySigner) SignTransaction(_ context.Context, tx *solana.Transaction) error {
	messageBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}
	signature, err := s.privateKey.Sign(messageBytes)
	if err != nil {
		return fmt.Errorf("failed to sign: %w", err)
	}
	accountIndex, err := tx.GetAccountIndex(s.privateKey.PublicKey())
	if err != nil {
		return fmt.Errorf("failed to get account index: %w", err)
	}
	if len(tx.Signatures) <= int(accountIndex) {
		signatures := make([]solana.Signature, accountIndex+1)
		copy(signatures, tx.Signatures)
		tx.Signatures = signatures
	}
	tx.Signatures[accountIndex] = signature
	return nil
}
