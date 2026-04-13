package svm

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/system"
)

// Test private key (deterministic for testing)
// This is a valid test key for Solana
const testPrivateKeyBase58 = "4Z7cXSyeFR8wNGMVXUE1TwtKn5D5Vu7FzEv69dokLv7KrQk7h2enu1bSz1tLTjKLuqBm1cUYXL9j3xTmD8wWEqmr"

func TestNewClientSignerFromPrivateKey(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		wantErr bool
	}{
		{
			name:    "valid key",
			key:     testPrivateKeyBase58,
			wantErr: false,
		},
		{
			name:    "invalid key - not base58",
			key:     "invalid!!!",
			wantErr: true,
		},
		{
			name:    "invalid key - wrong length",
			key:     "short",
			wantErr: true,
		},
		{
			name:    "empty key",
			key:     "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			signer, err := NewClientSignerFromPrivateKey(tt.key)

			if (err != nil) != tt.wantErr {
				t.Errorf("NewClientSignerFromPrivateKey() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if err != nil {
				return
			}

			if signer == nil {
				t.Error("expected non-nil signer")
			}
		})
	}
}

func TestClientSigner_Address(t *testing.T) {
	signer, err := NewClientSignerFromPrivateKey(testPrivateKeyBase58)
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey() failed: %v", err)
	}

	addr := signer.Address()

	// Should return a valid Solana public key
	if addr == (solana.PublicKey{}) {
		t.Error("Address() returned zero public key")
	}

	// Should be 32 bytes
	if len(addr) != 32 {
		t.Errorf("Address() length = %d, want 32", len(addr))
	}
}

func TestNewClientSigner(t *testing.T) {
	privateKey, err := solana.PrivateKeyFromBase58(testPrivateKeyBase58)
	if err != nil {
		t.Fatalf("PrivateKeyFromBase58() failed: %v", err)
	}

	called := false
	signer, err := NewClientSigner(privateKey.PublicKey(), func(ctx context.Context, tx *solana.Transaction) error {
		called = true
		if ctx == nil {
			t.Fatal("expected context")
		}
		return signTransactionWithPrivateKey(ctx, tx, privateKey)
	})
	if err != nil {
		t.Fatalf("NewClientSigner() failed: %v", err)
	}

	tx := newTestTransaction(t, signer.Address())

	if err := signer.SignTransaction(context.Background(), tx); err != nil {
		t.Fatalf("SignTransaction() failed: %v", err)
	}

	if !called {
		t.Fatal("expected signing callback to be called")
	}

	accountIndex, err := tx.GetAccountIndex(signer.Address())
	if err != nil {
		t.Fatalf("GetAccountIndex() failed: %v", err)
	}
	if tx.Signatures[accountIndex] == (solana.Signature{}) {
		t.Fatal("SignTransaction() added zero signature")
	}
}

func TestNewClientSignerValidation(t *testing.T) {
	signFunc := func(context.Context, *solana.Transaction) error { return nil }

	if _, err := NewClientSigner(solana.PublicKey{}, signFunc); err == nil {
		t.Fatal("expected zero public key error")
	}
	if _, err := NewClientSigner(solana.MustPublicKeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), nil); err == nil {
		t.Fatal("expected nil callback error")
	}
}

func TestClientSigner_SignTransaction(t *testing.T) {
	signer, err := NewClientSignerFromPrivateKey(testPrivateKeyBase58)
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey() failed: %v", err)
	}

	tx := newTestTransaction(t, signer.Address())

	// Sign the transaction
	err = signer.SignTransaction(context.Background(), tx)
	if err != nil {
		t.Fatalf("SignTransaction() failed: %v", err)
	}

	// Check that signature was added
	if len(tx.Signatures) == 0 {
		t.Error("SignTransaction() did not add signature to transaction")
	}

	// Check that signature is not zero
	hasNonZeroSignature := false
	for _, sig := range tx.Signatures {
		if sig != (solana.Signature{}) {
			hasNonZeroSignature = true
			break
		}
	}

	if !hasNonZeroSignature {
		t.Error("SignTransaction() added zero signature")
	}
}

func TestClientSigner_SignTransaction_SignatureArray(t *testing.T) {
	signer, err := NewClientSignerFromPrivateKey(testPrivateKeyBase58)
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey() failed: %v", err)
	}

	tx := newTestTransaction(t, signer.Address())

	// Sign the transaction (should handle expanding signatures array)
	err = signer.SignTransaction(context.Background(), tx)
	if err != nil {
		t.Fatalf("SignTransaction() failed: %v", err)
	}

	// Verify signature was added
	if len(tx.Signatures) == 0 {
		t.Error("SignTransaction() did not add signature")
	}

	// Verify signature is not zero
	accountIndex, _ := tx.GetAccountIndex(signer.Address())
	if int(accountIndex) >= len(tx.Signatures) {
		t.Errorf("Signature array not properly sized: index %d, length %d", accountIndex, len(tx.Signatures))
	} else if tx.Signatures[accountIndex] == (solana.Signature{}) {
		t.Error("SignTransaction() added zero signature")
	}
}

func newTestTransaction(t *testing.T, signer solana.PublicKey) *solana.Transaction {
	t.Helper()

	recentBlockhash := solana.MustHashFromBase58("11111111111111111111111111111111")
	recipient := solana.MustPublicKeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

	transferIx := system.NewTransferInstruction(
		1000000,
		signer,
		recipient,
	).Build()

	tx, err := solana.NewTransactionBuilder().
		AddInstruction(transferIx).
		SetRecentBlockHash(recentBlockhash).
		SetFeePayer(signer).
		Build()
	if err != nil {
		t.Fatalf("Failed to create test transaction: %v", err)
	}

	return tx
}
