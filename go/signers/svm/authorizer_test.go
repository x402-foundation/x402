package svm

import (
	"context"
	"crypto/ed25519"
	"testing"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func TestNewReceiverAuthorizerSignerFromPrivateKey(t *testing.T) {
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
			signer, err := NewReceiverAuthorizerSignerFromPrivateKey(tt.key)

			if (err != nil) != tt.wantErr {
				t.Errorf("NewReceiverAuthorizerSignerFromPrivateKey() error = %v, wantErr %v", err, tt.wantErr)
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

func TestReceiverAuthorizerSigner_Address(t *testing.T) {
	key, err := solana.NewRandomPrivateKey()
	if err != nil {
		t.Fatalf("NewRandomPrivateKey() failed: %v", err)
	}

	signer, err := NewReceiverAuthorizerSignerFromPrivateKey(key.String())
	if err != nil {
		t.Fatalf("NewReceiverAuthorizerSignerFromPrivateKey() failed: %v", err)
	}

	if signer.Address() != key.PublicKey() {
		t.Errorf("Address() = %s, want %s", signer.Address(), key.PublicKey())
	}
}

func TestReceiverAuthorizerSigner_SignMessage(t *testing.T) {
	key, err := solana.NewRandomPrivateKey()
	if err != nil {
		t.Fatalf("NewRandomPrivateKey() failed: %v", err)
	}

	signer, err := NewReceiverAuthorizerSignerFromPrivateKey(key.String())
	if err != nil {
		t.Fatalf("NewReceiverAuthorizerSignerFromPrivateKey() failed: %v", err)
	}

	message := []byte("x402-upto-voucher")
	signature, err := signer.SignMessage(context.Background(), message)
	if err != nil {
		t.Fatalf("SignMessage() failed: %v", err)
	}

	if len(signature) != len(solana.Signature{}) {
		t.Errorf("SignMessage() length = %d, want %d", len(signature), len(solana.Signature{}))
	}

	authorizer := ed25519.PublicKey(signer.Address().Bytes())
	if !ed25519.Verify(authorizer, message, signature) {
		t.Error("SignMessage() produced a signature the authorizer public key does not verify")
	}

	if ed25519.Verify(authorizer, []byte("other message"), signature) {
		t.Error("SignMessage() signature verifies against a different message")
	}
}

// The Ed25519 precompile verifies the voucher onchain, so the authorizer's
// signature over the canonical message must satisfy the same check the
// facilitator runs before it settles.
func TestReceiverAuthorizerSigner_SignsAVoucherTheFacilitatorAccepts(t *testing.T) {
	key, err := solana.NewRandomPrivateKey()
	if err != nil {
		t.Fatalf("NewRandomPrivateKey() failed: %v", err)
	}
	signer, err := NewReceiverAuthorizerSignerFromPrivateKey(key.String())
	if err != nil {
		t.Fatalf("NewReceiverAuthorizerSignerFromPrivateKey() failed: %v", err)
	}

	channel, err := solana.NewRandomPrivateKey()
	if err != nil {
		t.Fatalf("NewRandomPrivateKey() failed: %v", err)
	}
	message := paymentchannels.EncodeVoucherMessage(channel.PublicKey(), 1858, 1893456000)
	signature, err := signer.SignMessage(context.Background(), message)
	if err != nil {
		t.Fatalf("SignMessage() failed: %v", err)
	}

	encoded := solana.SignatureFromBytes(signature).String()
	if err := paymentchannels.VerifyVoucherSignature(encoded, signer.Address().String(), message); err != nil {
		t.Errorf("VerifyVoucherSignature() rejected the authorizer's own voucher: %v", err)
	}

	replayed := paymentchannels.EncodeVoucherMessage(channel.PublicKey(), 1859, 1893456000)
	if err := paymentchannels.VerifyVoucherSignature(encoded, signer.Address().String(), replayed); err == nil {
		t.Error("VerifyVoucherSignature() accepted the voucher for a different amount")
	}
}
