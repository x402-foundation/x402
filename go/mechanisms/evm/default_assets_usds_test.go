package evm

import "testing"

func TestFindDefaultAssetUSDsOnArbitrum(t *testing.T) {
	usds := FindDefaultAsset("0xd74f5255d557944cf7dd0e45ff521520002d5748", "eip155:42161")
	if usds == nil {
		t.Fatal("expected USDs to be a default asset on Arbitrum One")
	}
	if usds.Symbol != "USDs" || usds.Name != "Sperax USD" || usds.Version != "1" || usds.Decimals != 18 {
		t.Fatalf("unexpected USDs entry: %+v", usds)
	}
	if usds.AssetTransferMethod != AssetTransferMethodPermit2 {
		t.Fatalf("USDs must use Permit2, got %q", usds.AssetTransferMethod)
	}
	if usds.SupportsEip2612 {
		t.Fatal("USDs permit() does not set allowances, so SupportsEip2612 must be false")
	}
}

func TestArbitrumDefaultStaysUSDC(t *testing.T) {
	def, err := GetDefaultAsset("eip155:42161", "")
	if err != nil || def.Symbol != "USDC" {
		t.Fatalf("expected USDC as the Arbitrum One default, got %+v, %v", def, err)
	}
	usds, err := GetDefaultAsset("eip155:42161", "USDs")
	if err != nil || usds.Decimals != 18 {
		t.Fatalf("expected USDs by symbol, got %+v, %v", usds, err)
	}
}
