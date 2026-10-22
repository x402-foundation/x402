package evm

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

func TestIsCanonicalECDSASignature(t *testing.T) {
	halfN := new(big.Int).Rsh(crypto.S256().Params().N, 1)

	makeSig := func(s *big.Int) []byte {
		sig := make([]byte, 65)
		s.FillBytes(sig[32:64])
		sig[64] = 27
		return sig
	}

	t.Run("accepts low-s signature", func(t *testing.T) {
		if !IsCanonicalECDSASignature(makeSig(halfN)) {
			t.Fatal("expected half-order s to be canonical")
		}
	})

	t.Run("rejects high-s signature", func(t *testing.T) {
		highS := new(big.Int).Add(halfN, big.NewInt(1))
		if IsCanonicalECDSASignature(makeSig(highS)) {
			t.Fatal("expected high-s signature to be non-canonical")
		}
	})

	t.Run("rejects malformed length", func(t *testing.T) {
		if IsCanonicalECDSASignature([]byte{1, 2, 3}) {
			t.Fatal("expected malformed signature to be non-canonical")
		}
	})
}
