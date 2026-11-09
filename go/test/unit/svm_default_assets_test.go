package unit_test

import (
	"strings"
	"testing"

	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestSVMDefaultAssets(t *testing.T) {
	mainnetUSDC := svm.DefaultAssets[svm.SolanaMainnetCAIP2][0]

	t.Run("resolves v1 legacy network name solana", func(t *testing.T) {
		got := svm.FindDefaultAsset(svm.USDCMainnetAddress, "solana")
		if got == nil || got.Asset != mainnetUSDC.Asset {
			t.Fatalf("solana lookup = %+v, want %+v", got, mainnetUSDC)
		}
	})

	t.Run("returns nil for an unknown asset", func(t *testing.T) {
		got := svm.FindDefaultAsset("UnknownMint1111111111111111111111111111111", "solana")
		if got != nil {
			t.Fatalf("unknown mint = %+v, want nil", got)
		}
	})

	t.Run("getDefaultAsset returns the first list entry", func(t *testing.T) {
		got, err := svm.GetDefaultAsset(svm.SolanaMainnetCAIP2, "")
		if err != nil || got.Asset != mainnetUSDC.Asset {
			t.Fatalf("GetDefaultAsset(mainnet) = %+v, %v", got, err)
		}
		got, err = svm.GetDefaultAsset("solana", "")
		if err != nil || got.Asset != mainnetUSDC.Asset {
			t.Fatalf("GetDefaultAsset(solana) = %+v, %v", got, err)
		}
	})

	t.Run("resolves a suffixed ticker to a non-default entry", func(t *testing.T) {
		got, err := svm.GetDefaultAsset(svm.SolanaMainnetCAIP2, "USDT")
		if err != nil || got.Symbol != "USDT" {
			t.Fatalf("USDT lookup = %+v, %v", got, err)
		}
	})

	t.Run("throws when requesting a symbol that is not configured", func(t *testing.T) {
		_, err := svm.GetDefaultAsset(svm.SolanaDevnetCAIP2, "USDT")
		if err == nil || !strings.Contains(err.Error(), "no USDT default asset configured for network") {
			t.Fatalf("expected USDT error, got %v", err)
		}
	})
}
