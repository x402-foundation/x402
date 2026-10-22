package facilitator

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

type canonicalSignatureTestSigner struct {
	code []byte
	err  error
}

func (s canonicalSignatureTestSigner) GetAddresses() []string {
	return nil
}

func (s canonicalSignatureTestSigner) ReadContract(context.Context, string, []byte, string, ...interface{}) (interface{}, error) {
	return nil, nil
}

func (s canonicalSignatureTestSigner) VerifyTypedData(context.Context, string, evm.TypedDataDomain, map[string][]evm.TypedDataField, string, map[string]interface{}, []byte) (bool, error) {
	return false, nil
}

func (s canonicalSignatureTestSigner) WriteContract(context.Context, string, []byte, string, []byte, ...interface{}) (string, error) {
	return "", nil
}

func (s canonicalSignatureTestSigner) SendTransaction(context.Context, string, []byte) (string, error) {
	return "", nil
}

func (s canonicalSignatureTestSigner) WaitForTransactionReceipt(context.Context, string) (*evm.TransactionReceipt, error) {
	return nil, nil
}

func (s canonicalSignatureTestSigner) GetBalance(context.Context, string, string) (*big.Int, error) {
	return nil, nil
}

func (s canonicalSignatureTestSigner) GetChainID(context.Context) (*big.Int, error) {
	return nil, nil
}

func (s canonicalSignatureTestSigner) GetCode(context.Context, string) ([]byte, error) {
	return s.code, s.err
}

func TestIsPlainNonCanonicalECDSASignature(t *testing.T) {
	halfN := new(big.Int).Rsh(crypto.S256().Params().N, 1)

	makeSig := func(s *big.Int) []byte {
		sig := make([]byte, 65)
		s.FillBytes(sig[32:64])
		sig[64] = 27
		return sig
	}

	ctx := context.Background()
	payer := "0x0000000000000000000000000000000000000001"

	t.Run("rejects high-s EOA signature", func(t *testing.T) {
		highS := new(big.Int).Add(halfN, big.NewInt(1))
		got, err := IsPlainNonCanonicalECDSASignature(ctx, canonicalSignatureTestSigner{}, payer, makeSig(highS))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !got {
			t.Fatal("expected high-s EOA signature to be non-canonical")
		}
	})

	t.Run("allows low-s EOA signature", func(t *testing.T) {
		got, err := IsPlainNonCanonicalECDSASignature(ctx, canonicalSignatureTestSigner{}, payer, makeSig(halfN))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got {
			t.Fatal("expected low-s signature to be allowed")
		}
	})

	t.Run("allows high-s deployed wallet signature", func(t *testing.T) {
		highS := new(big.Int).Add(halfN, big.NewInt(1))
		signer := canonicalSignatureTestSigner{code: []byte{1}}
		got, err := IsPlainNonCanonicalECDSASignature(ctx, signer, payer, makeSig(highS))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got {
			t.Fatal("expected deployed wallet signature to be allowed")
		}
	})

	t.Run("allows non-65-byte signatures", func(t *testing.T) {
		got, err := IsPlainNonCanonicalECDSASignature(ctx, canonicalSignatureTestSigner{}, payer, []byte{1, 2, 3})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got {
			t.Fatal("expected non-65-byte signature to be allowed")
		}
	})

	t.Run("returns get code errors", func(t *testing.T) {
		highS := new(big.Int).Add(halfN, big.NewInt(1))
		wantErr := errors.New("get code failed")
		_, err := IsPlainNonCanonicalECDSASignature(ctx, canonicalSignatureTestSigner{err: wantErr}, payer, makeSig(highS))
		if !errors.Is(err, wantErr) {
			t.Fatalf("err = %v, want %v", err, wantErr)
		}
	})
}
