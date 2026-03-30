package server

import (
	"context"
	"fmt"
	"testing"

	x402 "github.com/coinbase/x402/go"
)

const baseMainnetUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

func TestParsePrice_DefaultNoCustomParsers(t *testing.T) {
	server := NewUptoEvmScheme()

	result, err := server.ParsePrice(10.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	if result.Asset != baseMainnetUSDC {
		t.Errorf("Expected default USDC, got %s", result.Asset)
	}

	expectedAmount := "10000000"
	if result.Amount != expectedAmount {
		t.Errorf("Expected amount %s, got %s", expectedAmount, result.Amount)
	}

	// Upto always includes assetTransferMethod: "permit2" in default conversion
	if result.Extra["assetTransferMethod"] != "permit2" {
		t.Errorf("Expected assetTransferMethod='permit2', got %v", result.Extra["assetTransferMethod"])
	}

	// Upto always includes name and version
	if result.Extra["name"] == nil {
		t.Error("Expected name in extra, got nil")
	}
	if result.Extra["version"] == nil {
		t.Error("Expected version in extra, got nil")
	}
}

func TestParsePrice_CustomParser(t *testing.T) {
	server := NewUptoEvmScheme()

	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 100 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e18),
				Asset:  "0x6B175474E89094C44Da98b954EedeAC495271d0F",
				Extra:  map[string]interface{}{"token": "DAI"},
			}, nil
		}
		return nil, nil
	})

	result1, err := server.ParsePrice(150.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result1.Extra["token"] != "DAI" {
		t.Errorf("Expected token='DAI', got %v", result1.Extra["token"])
	}

	result2, err := server.ParsePrice(50.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result2.Asset != baseMainnetUSDC {
		t.Errorf("Expected USDC asset, got %s", result2.Asset)
	}
}

func TestParsePrice_StringPrices(t *testing.T) {
	server := NewUptoEvmScheme()

	tests := []struct {
		name          string
		price         string
		expectedAsset string
	}{
		{"Dollar format", "$10.50", baseMainnetUSDC},
		{"Plain decimal", "25.50", baseMainnetUSDC},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := server.ParsePrice(tt.price, "eip155:8453")
			if err != nil {
				t.Fatalf("Expected no error, got %v", err)
			}
			if result.Asset != tt.expectedAsset {
				t.Errorf("Expected asset %s, got %s", tt.expectedAsset, result.Asset)
			}
		})
	}
}

func TestParsePrice_AssetAmountPassthrough(t *testing.T) {
	server := NewUptoEvmScheme()

	price := map[string]interface{}{
		"amount": "1000000",
		"asset":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		"extra": map[string]interface{}{
			"assetTransferMethod": "permit2",
		},
	}

	result, err := server.ParsePrice(price, "eip155:84532")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	if result.Amount != "1000000" {
		t.Errorf("Expected amount 1000000, got %s", result.Amount)
	}
	if result.Asset != "0x036CbD53842c5426634e7929541eC2318f3dCF7e" {
		t.Errorf("Expected asset pass-through, got %s", result.Asset)
	}
}

func TestRegisterMoneyParser_Chainability(t *testing.T) {
	server := NewUptoEvmScheme()

	result := server.
		RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
			return nil, nil
		}).
		RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
			return nil, nil
		})

	if result != server {
		t.Error("Expected RegisterMoneyParser to return server for chaining")
	}
}

func TestEnhancePaymentRequirements_SetsPermit2(t *testing.T) {
	server := NewUptoEvmScheme()

	requirements := x402.PaymentRequirements{
		Scheme:  "upto",
		Network: "eip155:84532",
		Amount:  "1000",
		Asset:   "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		PayTo:   "0x1234567890123456789012345678901234567890",
	}

	supportedKind := x402.SupportedKind{
		Scheme:  "upto",
		Network: "eip155:84532",
		Extra: map[string]interface{}{
			"facilitatorAddress": "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
		},
	}

	enhanced, err := server.EnhancePaymentRequirements(context.TODO(), requirements, supportedKind, nil)
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	if enhanced.Extra["assetTransferMethod"] != "permit2" {
		t.Errorf("Expected assetTransferMethod='permit2', got %v", enhanced.Extra["assetTransferMethod"])
	}

	if enhanced.Extra["facilitatorAddress"] == nil {
		t.Error("Expected facilitatorAddress in extra")
	}

	if enhanced.Extra["name"] == nil {
		t.Error("Expected name in extra")
	}
	if enhanced.Extra["version"] == nil {
		t.Error("Expected version in extra")
	}
}
