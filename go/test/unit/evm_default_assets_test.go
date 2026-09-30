package unit_test

import (
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	evmserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
)

func TestEVMDefaultAssets(t *testing.T) {
	baseUSDC := evm.DefaultAssets["eip155:8453"][0]
	mezoTestnetMUSD := evm.DefaultAssets["eip155:31611"][0]

	t.Run("findDefaultAsset matches checksummed and lowercase addresses", func(t *testing.T) {
		checksummed := common.HexToAddress(baseUSDC.Asset).Hex()
		lowercase := strings.ToLower(baseUSDC.Asset)

		got := evm.FindDefaultAsset(checksummed, "eip155:8453")
		if got == nil || got.Asset != baseUSDC.Asset {
			t.Fatalf("checksummed lookup = %+v, want %+v", got, baseUSDC)
		}
		got = evm.FindDefaultAsset(lowercase, "eip155:8453")
		if got == nil || got.Asset != baseUSDC.Asset {
			t.Fatalf("lowercase lookup = %+v, want %+v", got, baseUSDC)
		}
	})

	t.Run("resolves v1 legacy network name base to eip155:8453", func(t *testing.T) {
		got := evm.FindDefaultAsset(baseUSDC.Asset, "base")
		if got == nil || got.Asset != baseUSDC.Asset {
			t.Fatalf("base lookup = %+v, want %+v", got, baseUSDC)
		}
	})

	t.Run("finds 18-decimal mUSD on Mezo testnet", func(t *testing.T) {
		got := evm.FindDefaultAsset(mezoTestnetMUSD.Asset, "eip155:31611")
		if got == nil || got.Decimals != 18 {
			t.Fatalf("mezo lookup = %+v, want decimals 18", got)
		}
	})

	t.Run("returns nil for an unknown asset", func(t *testing.T) {
		got := evm.FindDefaultAsset("0x0000000000000000000000000000000000000001", "eip155:8453")
		if got != nil {
			t.Fatalf("unknown asset = %+v, want nil", got)
		}
	})

	t.Run("getDefaultAsset returns the first list entry", func(t *testing.T) {
		got, err := evm.GetDefaultAsset("eip155:8453", "")
		if err != nil || got.Asset != baseUSDC.Asset {
			t.Fatalf("GetDefaultAsset(eip155:8453) = %+v, %v", got, err)
		}
		got, err = evm.GetDefaultAsset("base", "")
		if err != nil || got.Asset != baseUSDC.Asset {
			t.Fatalf("GetDefaultAsset(base) = %+v, %v", got, err)
		}
	})

	t.Run("throws when requesting a symbol that is not configured", func(t *testing.T) {
		_, err := evm.GetDefaultAsset("eip155:8453", "USDT")
		if err == nil || !strings.Contains(err.Error(), "no USDT default asset configured for network eip155:8453") {
			t.Fatalf("expected USDT error, got %v", err)
		}
	})

	t.Run("ConvertDefaultMoney converts decimal amount using default asset decimals", func(t *testing.T) {
		info, amount, err := evm.ConvertDefaultMoney("1.5", "eip155:8453", "")
		if err != nil {
			t.Fatalf("ConvertDefaultMoney: %v", err)
		}
		if info.Asset != baseUSDC.Asset {
			t.Fatalf("asset = %s, want %s", info.Asset, baseUSDC.Asset)
		}
		if amount != "1500000" {
			t.Fatalf("amount = %s, want 1500000", amount)
		}
	})

	t.Run("ConvertDefaultMoney returns lookup errors as-is", func(t *testing.T) {
		_, _, err := evm.ConvertDefaultMoney("1", "eip155:8453", "USDT")
		if err == nil || !strings.Contains(err.Error(), "no USDT default asset configured for network eip155:8453") {
			t.Fatalf("expected USDT error, got %v", err)
		}
	})

	t.Run("GetAssetDecimals returns false for unrecognized asset on 18-decimal network", func(t *testing.T) {
		server := evmserver.NewExactEvmScheme()
		otherAsset := "0x0000000000000000000000000000000000000001"
		if _, ok := server.GetAssetDecimals(otherAsset, "eip155:31611"); ok {
			t.Fatal("expected unrecognized asset to return ok=false")
		}
		decimals, ok := server.GetAssetDecimals(mezoTestnetMUSD.Asset, "eip155:31611")
		if !ok || decimals != 18 {
			t.Fatalf("mUSD decimals = %d, %v, want 18, true", decimals, ok)
		}
	})
}
