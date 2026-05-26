package server

import (
	"fmt"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
)

// TestRegisterMoneyParser_SingleCustomParser tests a single custom money parser
func TestRegisterMoneyParser_SingleCustomParser(t *testing.T) {
	server := NewExactSvmScheme()

	// Register custom parser: large amounts use custom token
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 100 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e9), // Custom token with 9 decimals
				Asset:  "CustomLargeTokenMint111111111111111",
				Extra: map[string]interface{}{
					"token": "CUSTOM",
					"tier":  "large",
				},
			}, nil
		}
		return nil, nil // Use default for small amounts
	})

	// Test large amount - should use custom parser
	result1, err := server.ParsePrice(150.0, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	expectedAmount1 := fmt.Sprintf("%.0f", 150*1e9)
	if result1.Amount != expectedAmount1 {
		t.Errorf("Expected amount %s, got %s", expectedAmount1, result1.Amount)
	}

	if result1.Asset != "CustomLargeTokenMint111111111111111" {
		t.Errorf("Expected custom token, got %s", result1.Asset)
	}

	if result1.Extra["token"] != "CUSTOM" {
		t.Errorf("Expected token='CUSTOM', got %v", result1.Extra["token"])
	}

	// Test small amount - should fall back to default (USDC)
	result2, err := server.ParsePrice(50.0, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	expectedAmount2 := "50000000" // 50 * 1e6 (USDC has 6 decimals)
	if result2.Amount != expectedAmount2 {
		t.Errorf("Expected amount %s, got %s", expectedAmount2, result2.Amount)
	}

	// Mainnet USDC mint
	if result2.Asset != "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" {
		t.Errorf("Expected USDC mint, got %s", result2.Asset)
	}
}

// TestRegisterMoneyParser_MultipleInChain tests multiple money parsers in chain
func TestRegisterMoneyParser_MultipleInChain(t *testing.T) {
	server := NewExactSvmScheme()

	// Parser 1: Premium tier (> 1000)
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 1000 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e9),
				Asset:  "PremiumMint1111111111111111111111111",
				Extra:  map[string]interface{}{"tier": "premium"},
			}, nil
		}
		return nil, nil
	})

	// Parser 2: Large tier (> 100)
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 100 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e9),
				Asset:  "LargeMint11111111111111111111111111",
				Extra:  map[string]interface{}{"tier": "large"},
			}, nil
		}
		return nil, nil
	})

	// Test premium tier (first parser)
	result1, err := server.ParsePrice(2000.0, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result1.Extra["tier"] != "premium" {
		t.Errorf("Expected tier='premium', got %v", result1.Extra["tier"])
	}

	// Test large tier (second parser)
	result2, err := server.ParsePrice(200.0, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result2.Extra["tier"] != "large" {
		t.Errorf("Expected tier='large', got %v", result2.Extra["tier"])
	}

	// Test default (no parser matches)
	result3, err := server.ParsePrice(50.0, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	// Should use default USDC
	if result3.Asset != "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" {
		t.Errorf("Expected USDC, got %s", result3.Asset)
	}
}

// TestRegisterMoneyParser_StringPrices tests parsing with string prices
func TestRegisterMoneyParser_StringPrices(t *testing.T) {
	server := NewExactSvmScheme()

	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 50 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e9),
				Asset:  "CustomMint111111111111111111111111",
			}, nil
		}
		return nil, nil
	})

	tests := []struct {
		name          string
		price         string
		expectedAsset string
	}{
		{"Dollar format", "$100", "CustomMint111111111111111111111111"},            // > 50
		{"Plain decimal", "25.50", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}, // <= 50 (USDC)
		{"Large amount", "75", "CustomMint111111111111111111111111"},               // > 50
		{"Small amount", "10", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},     // <= 50
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := server.ParsePrice(tt.price, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
			if err != nil {
				t.Fatalf("Expected no error, got %v", err)
			}
			if result.Asset != tt.expectedAsset {
				t.Errorf("Expected asset %s, got %s", tt.expectedAsset, result.Asset)
			}
		})
	}
}

// TestRegisterMoneyParser_Chainability tests that RegisterMoneyParser returns the service for chaining
func TestRegisterMoneyParser_Chainability(t *testing.T) {
	server := NewExactSvmScheme()

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

// TestRegisterMoneyParser_NoCustomParsers tests default behavior with no custom parsers
func TestRegisterMoneyParser_NoCustomParsers(t *testing.T) {
	server := NewExactSvmScheme()

	// No custom parsers registered, should use default
	result, err := server.ParsePrice(10.0, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	// Should use default USDC
	if result.Asset != "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" {
		t.Errorf("Expected default USDC, got %s", result.Asset)
	}

	expectedAmount := "10000000" // 10 * 1e6
	if result.Amount != expectedAmount {
		t.Errorf("Expected amount %s, got %s", expectedAmount, result.Amount)
	}
}
