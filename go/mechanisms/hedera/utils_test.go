package hedera

import (
	"math/big"
	"testing"

	hiero "github.com/hiero-ledger/hiero-sdk-go/v2/sdk"
)

func TestIsValidEntityAndAsset(t *testing.T) {
	if !IsValidEntityID("0.0.1234") {
		t.Fatal("expected valid entity")
	}
	if IsValidEntityID("0xabc") {
		t.Fatal("expected invalid entity")
	}
	if !IsHbarAsset("0.0.0") || !IsValidAsset("0.0.0") {
		t.Fatal("hbar asset")
	}
	if !IsValidAsset("0.0.429274") {
		t.Fatal("token asset")
	}
	if !IsSupportedNetwork("hedera:testnet") || IsSupportedNetwork("hedera:previewnet") {
		t.Fatal("network support")
	}
}

func TestTransferMath(t *testing.T) {
	transfers := []TransferEntry{
		{AccountID: "0.0.1", Amount: "-100"},
		{AccountID: "0.0.2", Amount: "100"},
	}
	if SumTransfers(transfers).Cmp(big.NewInt(0)) != 0 {
		t.Fatal("sum")
	}
	receivers := GetPositiveReceivers(transfers)
	if len(receivers) != 1 || receivers[0] != "0.0.2" {
		t.Fatalf("receivers=%v", receivers)
	}
	if !HasNegativeTransfer(transfers, "0.0.1") {
		t.Fatal("expected negative")
	}
	if HasNegativeTransfer(transfers, "0.0.2") {
		t.Fatal("unexpected negative")
	}
	payers := InferPayers(transfers)
	if len(payers) != 1 || payers[0].AccountID != "0.0.1" || payers[0].Amount != "100" {
		t.Fatalf("payers=%v", payers)
	}
}

func TestAssetTransfersAmountAndFeePayerSafety(t *testing.T) {
	inspected := InspectedTransaction{
		TransactionType:      "TransferTransaction",
		TransactionID:        "0.0.9@1.000000000",
		TransactionIDAccount: "0.0.9",
		HbarTransfers: []TransferEntry{
			{AccountID: "0.0.1", Amount: "-50"},
			{AccountID: "0.0.2", Amount: "50"},
		},
		TokenTransfers: map[string][]TransferEntry{},
	}
	transfers, err := AssetTransfers(inspected, "0.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if SumTransfers(transfers).Cmp(big.NewInt(0)) != 0 {
		t.Fatal("sum")
	}
	if HasNegativeTransfer(transfers, "0.0.9") {
		t.Fatal("fee payer must not be debiting in this fixture")
	}

	bad := InspectedTransaction{
		TransactionType:      "TransferTransaction",
		TransactionID:        "0.0.9@1.000000000",
		TransactionIDAccount: "0.0.9",
		HbarTransfers: []TransferEntry{
			{AccountID: "0.0.9", Amount: "-50"},
			{AccountID: "0.0.2", Amount: "50"},
		},
		TokenTransfers: map[string][]TransferEntry{},
	}
	if !HasNegativeTransfer(bad.HbarTransfers, "0.0.9") {
		t.Fatal("expected fee payer debit")
	}

	netToPayTo := big.NewInt(0)
	for _, entry := range transfers {
		if AccountIDsEqual(entry.AccountID, "0.0.2") {
			n, _ := new(big.Int).SetString(entry.Amount, 10)
			netToPayTo.Add(netToPayTo, n)
		}
	}
	if netToPayTo.Cmp(big.NewInt(50)) != 0 {
		t.Fatalf("amount mismatch: got %s", netToPayTo)
	}
	if netToPayTo.Cmp(big.NewInt(40)) == 0 {
		t.Fatal("unexpected match for wrong amount")
	}
}

func TestMirrorURLForNetwork(t *testing.T) {
	url, err := mirrorURLForNetwork("hedera:testnet", "")
	if err != nil || url != HederaTestnetMirrorNodeURL {
		t.Fatalf("url=%s err=%v", url, err)
	}
	url, err = mirrorURLForNetwork("hedera:mainnet", "https://custom.example/")
	if err != nil || url != "https://custom.example" {
		t.Fatalf("url=%s err=%v", url, err)
	}
}

func TestParseAmount(t *testing.T) {
	got, err := ParseAmount("1.5", 6)
	if err != nil {
		t.Fatal(err)
	}
	if got.Cmp(big.NewInt(1500000)) != 0 {
		t.Fatalf("got %s", got)
	}
}

func TestDefaultAssets(t *testing.T) {
	asset, err := GetDefaultAsset(HederaTestnetCAIP2, "")
	if err != nil || asset.Asset != HederaTestnetUSDC || asset.Decimals != HederaUSDCDecimals {
		t.Fatalf("default asset=%+v err=%v", asset, err)
	}
	asset, err = GetDefaultAsset(HederaMainnetCAIP2, "usdc")
	if err != nil || asset.Asset != HederaMainnetUSDC {
		t.Fatalf("symbol lookup asset=%+v err=%v", asset, err)
	}
	if _, err := GetDefaultAsset(HederaTestnetCAIP2, "PYUSD"); err == nil {
		t.Fatal("expected error for unknown symbol")
	}
	if _, err := GetDefaultAsset("hedera:previewnet", ""); err == nil {
		t.Fatal("expected error for network without default asset")
	}
	if found := FindDefaultAsset(HederaTestnetUSDC, HederaTestnetCAIP2); found == nil || found.Symbol != "USDC" {
		t.Fatalf("reverse lookup=%+v", found)
	}
	if FindDefaultAsset(HederaTestnetUSDC, HederaMainnetCAIP2) != nil {
		t.Fatal("testnet USDC must not resolve on mainnet")
	}
	if FindDefaultAsset(HBARAssetID, HederaTestnetCAIP2) != nil {
		t.Fatal("HBAR is not a default asset")
	}
}

func TestAssetTransferMethod(t *testing.T) {
	tests := []struct {
		name   string
		extra  map[string]interface{}
		method string
		ok     bool
	}{
		{"nil extra", nil, AssetTransferMethodCryptoTransfer, true},
		{"absent", map[string]interface{}{"feePayer": "0.0.1"}, AssetTransferMethodCryptoTransfer, true},
		{"explicit", map[string]interface{}{"assetTransferMethod": AssetTransferMethodTransferExecutor}, AssetTransferMethodTransferExecutor, true},
		{"non-string", map[string]interface{}{"assetTransferMethod": 1}, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			method, ok := AssetTransferMethod(tt.extra)
			if method != tt.method || ok != tt.ok {
				t.Fatalf("got (%q, %v), want (%q, %v)", method, ok, tt.method, tt.ok)
			}
		})
	}
}

func TestParsePrivateKeyECDSAPreferred(t *testing.T) {
	// 32-byte hex must parse as ECDSA (not ED25519 default).
	hexKey := "a869f4c6191b9c8c99933e7f6b6611711737e4b1a1a5a4cb5370e719a1f6df98"
	key, err := ParsePrivateKey(hexKey)
	if err != nil {
		t.Fatal(err)
	}
	// ECDSA secp256k1 compressed pubkeys are 33 bytes; ED25519 are 32.
	if len(key.PublicKey().BytesRaw()) != 33 {
		t.Fatalf("expected ECDSA pubkey (33 bytes), got %d", len(key.PublicKey().BytesRaw()))
	}

	ed, err := hiero.PrivateKeyGenerateEd25519()
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParsePrivateKey(ed.String())
	if err != nil || parsed.PublicKey().String() != ed.PublicKey().String() {
		t.Fatalf("DER ED25519 key must keep its type: err=%v", err)
	}
	if _, err := ParsePrivateKey("not-a-key"); err == nil {
		t.Fatal("expected unsupported encoding error")
	}
}
