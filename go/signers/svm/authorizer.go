package svm

import (
	"context"
	"fmt"

	solana "github.com/gagliardetto/solana-go"

	x402svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// ReceiverAuthorizerSigner implements x402svm.ReceiverAuthorizerSigner using an
// Ed25519 private key. The SVM `upto` server uses it to sign settlement
// vouchers; the key never signs a transaction and needs no SOL or token balance.
type ReceiverAuthorizerSigner struct {
	privateKey solana.PrivateKey
}

// NewReceiverAuthorizerSignerFromPrivateKey creates a voucher signer from a
// base58-encoded private key.
//
// Example:
//
//	authorizer, err := svm.NewReceiverAuthorizerSignerFromPrivateKey(os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"))
//	if err != nil {
//	    log.Fatal(err)
//	}
//	server := x402.Newx402ResourceServer(facilitatorClient).
//	    Register("solana:*", uptoserver.NewUptoSvmScheme(&uptoserver.Config{
//	        ReceiverAuthorizerSigner: authorizer,
//	    }))
func NewReceiverAuthorizerSignerFromPrivateKey(privateKeyBase58 string) (x402svm.ReceiverAuthorizerSigner, error) {
	privateKey, err := solana.PrivateKeyFromBase58(privateKeyBase58)
	if err != nil {
		return nil, fmt.Errorf("invalid private key: %w", err)
	}
	return &ReceiverAuthorizerSigner{privateKey: privateKey}, nil
}

// Address returns the Solana public key advertised as extra.receiverAuthorizer.
func (s *ReceiverAuthorizerSigner) Address() solana.PublicKey {
	return s.privateKey.PublicKey()
}

// SignMessage signs raw voucher bytes and returns the 64-byte Ed25519 signature.
func (s *ReceiverAuthorizerSigner) SignMessage(_ context.Context, message []byte) ([]byte, error) {
	signature, err := s.privateKey.Sign(message)
	if err != nil {
		return nil, fmt.Errorf("failed to sign voucher message: %w", err)
	}
	return signature[:], nil
}
