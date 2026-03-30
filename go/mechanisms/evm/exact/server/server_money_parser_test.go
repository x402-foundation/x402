package server

import (
	"fmt"
	"testing"

	x402 "github.com/coinbase/x402/go"
)

// Base mainnet USDC address
const baseMainnetUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

// TestRegisterMoneyParser_SingleCustomParser tests a single custom money parser
func TestRegisterMoneyParser_SingleCustomParser(t *testing.T) {
	server := NewExactEvmScheme()

	// Register custom parser: large amounts use DAI
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 100 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e18),             // DAI has 18 decimals
				Asset:  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
				Extra: map[string]interface{}{
					"token": "DAI",
					"tier":  "large",
				},
			}, nil
		}
		return nil, nil // Use default for small amounts
	})

	// Test large amount - should use custom parser (DAI)
	result1, err := server.ParsePrice(150.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	expectedAmount1 := fmt.Sprintf("%.0f", 150*1e18)
	if result1.Amount != expectedAmount1 {
		t.Errorf("Expected amount %s, got %s", expectedAmount1, result1.Amount)
	}

	if result1.Asset != "0x6B175474E89094C44Da98b954EedeAC495271d0F" {
		t.Errorf("Expected DAI asset, got %s", result1.Asset)
	}

	if result1.Extra["token"] != "DAI" {
		t.Errorf("Expected token='DAI', got %v", result1.Extra["token"])
	}

	// Test small amount - should fall back to default (USDC)
	result2, err := server.ParsePrice(50.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	expectedAmount2 := "50000000" // 50 * 1e6 (USDC has 6 decimals)
	if result2.Amount != expectedAmount2 {
		t.Errorf("Expected amount %s, got %s", expectedAmount2, result2.Amount)
	}

	// Base mainnet USDC address
	if result2.Asset != baseMainnetUSDC {
		t.Errorf("Expected USDC asset, got %s", result2.Asset)
	}
}

// TestRegisterMoneyParser_MultipleInChain tests multiple money parsers in chain
func TestRegisterMoneyParser_MultipleInChain(t *testing.T) {
	server := NewExactEvmScheme()

	// Parser 1: Premium tier (> 1000)
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 1000 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e18),
				Asset:  "0xPremiumToken",
				Extra:  map[string]interface{}{"tier": "premium"},
			}, nil
		}
		return nil, nil
	})

	// Parser 2: Large tier (> 100)
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 100 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e18),
				Asset:  "0xLargeToken",
				Extra:  map[string]interface{}{"tier": "large"},
			}, nil
		}
		return nil, nil
	})

	// Parser 3: Medium tier (> 10)
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 10 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e6),
				Asset:  "0xMediumToken",
				Extra:  map[string]interface{}{"tier": "medium"},
			}, nil
		}
		return nil, nil
	})

	// Test premium tier
	result1, err := server.ParsePrice(2000.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result1.Extra["tier"] != "premium" {
		t.Errorf("Expected tier='premium', got %v", result1.Extra["tier"])
	}

	// Test large tier
	result2, err := server.ParsePrice(200.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result2.Extra["tier"] != "large" {
		t.Errorf("Expected tier='large', got %v", result2.Extra["tier"])
	}

	// Test medium tier
	result3, err := server.ParsePrice(20.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result3.Extra["tier"] != "medium" {
		t.Errorf("Expected tier='medium', got %v", result3.Extra["tier"])
	}

	// Test default (small amount)
	result4, err := server.ParsePrice(5.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	// Should use default USDC
	if result4.Asset != baseMainnetUSDC {
		t.Errorf("Expected USDC, got %s", result4.Asset)
	}
}

// TestRegisterMoneyParser_NetworkSpecific tests network-specific parsers
func TestRegisterMoneyParser_NetworkSpecific(t *testing.T) {
	server := NewExactEvmScheme()

	// Network-specific parser
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		// Only handle Base Sepolia
		if string(network) == "eip155:84532" {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e6),
				Asset:  "0xBaseSepoliaCustomToken",
				Extra:  map[string]interface{}{"network": "base-sepolia"},
			}, nil
		}
		return nil, nil // Skip for other networks
	})

	// Test Base Sepolia - should use custom parser
	result1, err := server.ParsePrice(10.0, "eip155:84532")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result1.Asset != "0xBaseSepoliaCustomToken" {
		t.Errorf("Expected custom token, got %s", result1.Asset)
	}

	// Test Base Mainnet - should use default
	result2, err := server.ParsePrice(10.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result2.Asset != baseMainnetUSDC {
		t.Errorf("Expected default USDC, got %s", result2.Asset)
	}
}

// TestRegisterMoneyParser_StringPrices tests parsing with string prices
func TestRegisterMoneyParser_StringPrices(t *testing.T) {
	server := NewExactEvmScheme()

	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 50 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e18),
				Asset:  "0xDAI",
			}, nil
		}
		return nil, nil
	})

	tests := []struct {
		name          string
		price         string
		expectedAsset string
	}{
		{"Dollar format", "$100", "0xDAI"},          // > 50, uses DAI
		{"Plain decimal", "25.50", baseMainnetUSDC}, // <= 50, uses USDC
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

// TestRegisterMoneyParser_ErrorHandling tests parser error handling
func TestRegisterMoneyParser_ErrorHandling(t *testing.T) {
	server := NewExactEvmScheme()

	// Parser that returns an error
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount == 99 {
			return nil, fmt.Errorf("amount 99 is not allowed")
		}
		return nil, nil
	})

	// Parser that handles successfully
	server.RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		if amount > 50 {
			return &x402.AssetAmount{
				Amount: "100000000",
				Asset:  "0xCustom",
			}, nil
		}
		return nil, nil
	})

	// Error in first parser should be skipped, second parser should handle
	result, err := server.ParsePrice(99.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error (should skip erroring parser), got %v", err)
	}
	if result.Asset != "0xCustom" {
		t.Errorf("Expected second parser to handle, got asset %s", result.Asset)
	}
}

// TestRegisterMoneyParser_Chainability tests that RegisterMoneyParser returns the service for chaining
func TestRegisterMoneyParser_Chainability(t *testing.T) {
	server := NewExactEvmScheme()

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
	server := NewExactEvmScheme()

	// No custom parsers registered, should use default
	result, err := server.ParsePrice(10.0, "eip155:8453")
	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}

	// Should use default USDC
	if result.Asset != baseMainnetUSDC {
		t.Errorf("Expected default USDC, got %s", result.Asset)
	}

	expectedAmount := "10000000" // 10 * 1e6
	if result.Amount != expectedAmount {
		t.Errorf("Expected amount %s, got %s", expectedAmount, result.Amount)
	}
}
