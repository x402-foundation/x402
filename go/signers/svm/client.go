package svm

import (
	"context"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	x402svm "github.com/x402-foundation/x402/go/mechanisms/svm"
)

// ClientSigner implements x402svm.ClientSvmSigner using an Ed25519 private key.
// This provides client-side transaction signing for creating payment payloads.
type ClientSigner struct {
	privateKey solana.PrivateKey
}

// NewClientSignerFromPrivateKey creates a client signer from a base58-encoded private key.
//
// Args:
//
//	privateKeyBase58: Base58-encoded Solana private key
//
// Returns:
//
//	ClientSvmSigner implementation ready for use with svm.NewExactSvmClient()
//	Error if private key is invalid
//
// Example:
//
//	signer, err := svm.NewClientSignerFromPrivateKey("5J7W...")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	client := x402.Newx402Client().
//	    Register("solana:*", svm.NewExactSvmClient(signer))
func NewClientSignerFromPrivateKey(privateKeyBase58 string) (x402svm.ClientSvmSigner, error) {
	// Parse base58-encoded private key
	privateKey, err := solana.PrivateKeyFromBase58(privateKeyBase58)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}

	return &ClientSigner{
		privateKey: privateKey,
	}, nil
}

// Address returns the Solana public key of the signer.
func (s *ClientSigner) Address() solana.PublicKey {
	return s.privateKey.PublicKey()
}

// SignTransaction partially signs a Solana transaction.
// This adds the client's signature to the transaction at the appropriate index.
//
// Args:
//
//	ctx: Context for cancellation and timeout control
//	tx: The transaction to sign
//
// Returns:
//
//	Error if signing fails
func (s *ClientSigner) SignTransaction(ctx context.Context, tx *solana.Transaction) error {
	// Marshal transaction message to bytes
	messageBytes, err := tx.Message.MarshalBinary()
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}

	// Sign the message bytes with Ed25519
	signature, err := s.privateKey.Sign(messageBytes)
	if err != nil {
		return fmt.Errorf("failed to sign: %w", err)
	}

	// Find the index of our public key in the transaction
	accountIndex, err := tx.GetAccountIndex(s.privateKey.PublicKey())
	if err != nil {
		return fmt.Errorf("failed to get account index: %w", err)
	}

	// Ensure signatures array is large enough
	if len(tx.Signatures) <= int(accountIndex) {
		newSignatures := make([]solana.Signature, accountIndex+1)
		copy(newSignatures, tx.Signatures)
		tx.Signatures = newSignatures
	}

	// Add our signature at the correct index
	tx.Signatures[accountIndex] = signature

	return nil
}
