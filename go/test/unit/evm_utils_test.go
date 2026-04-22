package unit_test

import (
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// TestGetEvmChainId tests chain ID retrieval for various network formats
func TestGetEvmChainId(t *testing.T) {
	tests := []struct {
		name          string
		network       string
		expectedChain int64
		expectError   bool
	}{
		// CAIP-2 format
		{"Base Mainnet CAIP-2", "eip155:8453", 8453, false},
		{"Base Sepolia CAIP-2", "eip155:84532", 84532, false},
		{"Ethereum Mainnet CAIP-2", "eip155:1", 1, false},
		{"Polygon CAIP-2", "eip155:137", 137, false},
		{"Arbitrum CAIP-2", "eip155:42161", 42161, false},

		// Legacy names should now fail (use evm/v1.GetEvmChainId for v1 networks)
		{"Legacy name rejected", "base", 0, true},
		{"Legacy name rejected 2", "base-sepolia", 0, true},

		// Invalid formats
		{"Invalid prefix", "ethereum:1", 0, true},
		{"Empty string", "", 0, true},
		{"Invalid chain ID", "eip155:abc", 0, true},
		{"Missing chain ID", "eip155:", 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chainID, err := evm.GetEvmChainId(tt.network)

			if tt.expectError {
				if err == nil {
					t.Errorf("Expected error for network %s, got nil", tt.network)
				}
				return
			}

			if err != nil {
				t.Errorf("Unexpected error for network %s: %v", tt.network, err)
				return
			}

			if chainID.Int64() != tt.expectedChain {
				t.Errorf("Expected chain ID %d, got %d", tt.expectedChain, chainID.Int64())
			}
		})
	}
}

// TestCreateNonce tests EIP-3009 nonce generation
func TestCreateNonce(t *testing.T) {
	t.Run("generates valid hex nonce", func(t *testing.T) {
		nonce, err := evm.CreateNonce()
		if err != nil {
			t.Fatalf("Failed to create nonce: %v", err)
		}

		// Should be hex format with 0x prefix
		if !strings.HasPrefix(nonce, "0x") {
			t.Errorf("Nonce should have 0x prefix, got %s", nonce)
		}

		// Should be 32 bytes = 64 hex chars + 2 for "0x"
		if len(nonce) != 66 {
			t.Errorf("Expected nonce length 66, got %d", len(nonce))
		}

		// Should be valid hex
		_, err = evm.HexToBytes(nonce)
		if err != nil {
			t.Errorf("Nonce is not valid hex: %v", err)
		}
	})

	t.Run("generates unique nonces", func(t *testing.T) {
		nonces := make(map[string]bool)
		for i := 0; i < 100; i++ {
			nonce, err := evm.CreateNonce()
			if err != nil {
				t.Fatalf("Failed to create nonce: %v", err)
			}
			if nonces[nonce] {
				t.Error("Duplicate nonce generated")
			}
			nonces[nonce] = true
		}
	})
}

// TestCreatePermit2Nonce tests Permit2 nonce generation
func TestCreatePermit2Nonce(t *testing.T) {
	t.Run("generates valid decimal nonce", func(t *testing.T) {
		nonce, err := evm.CreatePermit2Nonce()
		if err != nil {
			t.Fatalf("Failed to create nonce: %v", err)
		}

		// Should NOT be hex format
		if strings.HasPrefix(nonce, "0x") {
			t.Errorf("Permit2 nonce should not have 0x prefix, got %s", nonce)
		}

		// Should be parseable as big int
		n, ok := new(big.Int).SetString(nonce, 10)
		if !ok {
			t.Errorf("Nonce is not a valid decimal number: %s", nonce)
		}

		// Should be positive
		if n.Sign() < 0 {
			t.Errorf("Nonce should be non-negative")
		}
	})

	t.Run("generates unique nonces", func(t *testing.T) {
		nonces := make(map[string]bool)
		for i := 0; i < 100; i++ {
			nonce, err := evm.CreatePermit2Nonce()
			if err != nil {
				t.Fatalf("Failed to create nonce: %v", err)
			}
			if nonces[nonce] {
				t.Error("Duplicate nonce generated")
			}
			nonces[nonce] = true
		}
	})
}

// TestMaxUint256 tests the maximum uint256 value
func TestMaxUint256(t *testing.T) {
	max := evm.MaxUint256()

	// Max uint256 = 2^256 - 1
	expected := new(big.Int)
	expected.Exp(big.NewInt(2), big.NewInt(256), nil)
	expected.Sub(expected, big.NewInt(1))

	if max.Cmp(expected) != 0 {
		t.Errorf("MaxUint256 mismatch: expected %s, got %s", expected.String(), max.String())
	}

	// Adding 1 should overflow (become 2^256)
	overflowed := new(big.Int).Add(max, big.NewInt(1))
	twoTo256 := new(big.Int).Exp(big.NewInt(2), big.NewInt(256), nil)
	if overflowed.Cmp(twoTo256) != 0 {
		t.Errorf("Max + 1 should equal 2^256")
	}
}

// TestNormalizeAddress tests address normalization
func TestNormalizeAddress(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"Lowercase with prefix", "0xabcdef1234567890abcdef1234567890abcdef12", "0xabcdef1234567890abcdef1234567890abcdef12"},
		{"Uppercase with prefix", "0xABCDEF1234567890ABCDEF1234567890ABCDEF12", "0xabcdef1234567890abcdef1234567890abcdef12"},
		{"Mixed case with prefix", "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12", "0xabcdef1234567890abcdef1234567890abcdef12"},
		{"Without prefix", "abcdef1234567890abcdef1234567890abcdef12", "0xabcdef1234567890abcdef1234567890abcdef12"},
		{"Zero address", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := evm.NormalizeAddress(tt.input)
			if result != tt.expected {
				t.Errorf("Expected %s, got %s", tt.expected, result)
			}
		})
	}
}

// TestIsValidAddress tests address validation
func TestIsValidAddress(t *testing.T) {
	tests := []struct {
		name     string
		address  string
		expected bool
	}{
		{"Valid lowercase", "0xabcdef1234567890abcdef1234567890abcdef12", true},
		{"Valid uppercase", "0xABCDEF1234567890ABCDEF1234567890ABCDEF12", true},
		{"Valid mixed case", "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12", true},
		{"Valid without prefix", "abcdef1234567890abcdef1234567890abcdef12", true},
		{"Zero address", "0x0000000000000000000000000000000000000000", true},

		{"Too short", "0xabcdef", false},
		{"Too long", "0xabcdef1234567890abcdef1234567890abcdef1234", false},
		{"Invalid hex chars", "0xghijkl1234567890abcdef1234567890abcdef12", false},
		{"Empty string", "", false},
		{"Just prefix", "0x", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := evm.IsValidAddress(tt.address)
			if result != tt.expected {
				t.Errorf("IsValidAddress(%s) = %v, expected %v", tt.address, result, tt.expected)
			}
		})
	}
}

// TestParseAmount tests amount parsing with various formats
func TestParseAmount(t *testing.T) {
	tests := []struct {
		name      string
		amount    string
		decimals  int
		expected  string
		expectErr bool
	}{
		// USDC (6 decimals)
		{"1 USDC", "1", 6, "1000000", false},
		{"0.5 USDC", "0.5", 6, "500000", false},
		{"0.000001 USDC", "0.000001", 6, "1", false},
		{"1.234567 USDC", "1.234567", 6, "1234567", false},
		{"100.123456 USDC", "100.123456", 6, "100123456", false},

		// ETH (18 decimals)
		{"1 ETH", "1", 18, "1000000000000000000", false},
		{"0.1 ETH", "0.1", 18, "100000000000000000", false},
		{"0.000000000000000001 ETH", "0.000000000000000001", 18, "1", false},

		// Edge cases
		{"Zero", "0", 6, "0", false},
		{"Large number", "1000000", 6, "1000000000000", false},
		{"Truncates extra decimals", "1.1234567890", 6, "1123456", false},

		// Errors
		{"Invalid format", "abc", 6, "", true},
		{"Multiple dots", "1.2.3", 6, "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := evm.ParseAmount(tt.amount, tt.decimals)

			if tt.expectErr {
				if err == nil {
					t.Errorf("Expected error for amount %s", tt.amount)
				}
				return
			}

			if err != nil {
				t.Errorf("Unexpected error: %v", err)
				return
			}

			if result.String() != tt.expected {
				t.Errorf("Expected %s, got %s", tt.expected, result.String())
			}
		})
	}
}

// TestFormatAmount tests amount formatting
func TestFormatAmount(t *testing.T) {
	tests := []struct {
		name     string
		amount   string
		decimals int
		expected string
	}{
		// USDC (6 decimals)
		{"1 USDC", "1000000", 6, "1"},
		{"0.5 USDC", "500000", 6, "0.5"},
		{"0.000001 USDC", "1", 6, "0.000001"},
		{"1.234567 USDC", "1234567", 6, "1.234567"},
		{"100.123456 USDC", "100123456", 6, "100.123456"},
		{"100.1 USDC (trailing zeros removed)", "100100000", 6, "100.1"},

		// ETH (18 decimals)
		{"1 ETH", "1000000000000000000", 18, "1"},
		{"0.1 ETH", "100000000000000000", 18, "0.1"},

		// Edge cases
		{"Zero", "0", 6, "0"},
		{"Large number", "1000000000000", 6, "1000000"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			amount, _ := new(big.Int).SetString(tt.amount, 10)
			result := evm.FormatAmount(amount, tt.decimals)

			if result != tt.expected {
				t.Errorf("Expected %s, got %s", tt.expected, result)
			}
		})
	}

	t.Run("nil amount returns zero", func(t *testing.T) {
		result := evm.FormatAmount(nil, 6)
		if result != "0" {
			t.Errorf("Expected '0' for nil amount, got %s", result)
		}
	})
}

// TestHexToBytes tests hex string conversion
func TestHexToBytes(t *testing.T) {
	tests := []struct {
		name      string
		hex       string
		expected  []byte
		expectErr bool
	}{
		{"With 0x prefix", "0xabcdef", []byte{0xab, 0xcd, 0xef}, false},
		{"Without prefix", "abcdef", []byte{0xab, 0xcd, 0xef}, false},
		{"Empty with prefix", "0x", []byte{}, false},
		{"Empty string", "", []byte{}, false},
		{"Single byte", "0xff", []byte{0xff}, false},
		{"32 bytes", "0x0000000000000000000000000000000000000000000000000000000000000001",
			make([]byte, 32), false},

		{"Invalid hex", "0xgg", nil, true},
		{"Odd length", "0xabc", nil, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := evm.HexToBytes(tt.hex)

			if tt.expectErr {
				if err == nil {
					t.Errorf("Expected error for hex %s", tt.hex)
				}
				return
			}

			if err != nil {
				t.Errorf("Unexpected error: %v", err)
				return
			}

			// For the 32 bytes test, set the expected value properly
			if tt.name == "32 bytes" {
				tt.expected[31] = 1
			}

			if len(result) != len(tt.expected) {
				t.Errorf("Length mismatch: expected %d, got %d", len(tt.expected), len(result))
				return
			}

			for i := range result {
				if result[i] != tt.expected[i] {
					t.Errorf("Byte %d mismatch: expected %x, got %x", i, tt.expected[i], result[i])
				}
			}
		})
	}
}

// TestBytesToHex tests bytes to hex conversion
func TestBytesToHex(t *testing.T) {
	tests := []struct {
		name     string
		bytes    []byte
		expected string
	}{
		{"Simple bytes", []byte{0xab, 0xcd, 0xef}, "0xabcdef"},
		{"Single byte", []byte{0xff}, "0xff"},
		{"Zero byte", []byte{0x00}, "0x00"},
		{"Empty bytes", []byte{}, "0x"},
		{"32 bytes", make([]byte, 32), "0x0000000000000000000000000000000000000000000000000000000000000000"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := evm.BytesToHex(tt.bytes)
			if result != tt.expected {
				t.Errorf("Expected %s, got %s", tt.expected, result)
			}
		})
	}
}

// TestHexRoundTrip tests that HexToBytes and BytesToHex are inverses
func TestHexRoundTrip(t *testing.T) {
	testHexes := []string{
		"0x",
		"0xabcdef",
		"0x0000000000000000000000000000000000000000000000000000000000000001",
		"0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	}

	for _, hex := range testHexes {
		bytes, err := evm.HexToBytes(hex)
		if err != nil {
			t.Errorf("Failed to convert %s to bytes: %v", hex, err)
			continue
		}

		result := evm.BytesToHex(bytes)
		if result != hex {
			t.Errorf("Round trip failed: %s -> %s", hex, result)
		}
	}
}

// TestGetNetworkConfig tests network configuration retrieval
func TestGetNetworkConfig(t *testing.T) {
	t.Run("Base Mainnet has default asset", func(t *testing.T) {
		config, err := evm.GetNetworkConfig("eip155:8453")
		if err != nil {
			t.Fatalf("Failed to get config: %v", err)
		}

		if config.ChainID.Int64() != 8453 {
			t.Errorf("Expected chain ID 8453, got %d", config.ChainID.Int64())
		}

		if config.DefaultAsset.Address == "" {
			t.Error("Expected default asset to be configured")
		}

		// USDC should have 6 decimals
		if config.DefaultAsset.Decimals != 6 {
			t.Errorf("Expected 6 decimals, got %d", config.DefaultAsset.Decimals)
		}
	})

	t.Run("Base Sepolia has default asset", func(t *testing.T) {
		config, err := evm.GetNetworkConfig("eip155:84532")
		if err != nil {
			t.Fatalf("Failed to get config: %v", err)
		}

		if config.ChainID.Int64() != 84532 {
			t.Errorf("Expected chain ID 84532, got %d", config.ChainID.Int64())
		}

		if config.DefaultAsset.Address == "" {
			t.Error("Expected default asset to be configured")
		}
	})

	t.Run("Arbitrary EVM chain works without default asset", func(t *testing.T) {
		config, err := evm.GetNetworkConfig("eip155:999999")
		if err != nil {
			t.Fatalf("Failed to get config: %v", err)
		}

		if config.ChainID.Int64() != 999999 {
			t.Errorf("Expected chain ID 999999, got %d", config.ChainID.Int64())
		}

		// Should NOT have default asset
		if config.DefaultAsset.Address != "" {
			t.Error("Arbitrary chain should not have default asset")
		}
	})

	t.Run("Legacy names rejected", func(t *testing.T) {
		_, err := evm.GetNetworkConfig("base")
		if err == nil {
			t.Error("Expected error for legacy network name; use evm/v1 package for v1 networks")
		}
	})

	t.Run("Invalid format returns error", func(t *testing.T) {
		_, err := evm.GetNetworkConfig("invalid")
		if err == nil {
			t.Error("Expected error for invalid network format")
		}
	})
}

// TestGetAssetInfo tests asset information retrieval
func TestGetAssetInfo(t *testing.T) {
	t.Run("Explicit address returns asset info", func(t *testing.T) {
		// Use a random valid address
		info, err := evm.GetAssetInfo("eip155:8453", "0x1234567890123456789012345678901234567890")
		if err != nil {
			t.Fatalf("Failed to get asset info: %v", err)
		}

		if info.Address != "0x1234567890123456789012345678901234567890" {
			t.Errorf("Address mismatch: %s", info.Address)
		}

		// Unknown token should have default 18 decimals
		if info.Decimals != 18 {
			t.Errorf("Expected 18 decimals for unknown token, got %d", info.Decimals)
		}
	})

	t.Run("Known default asset returns rich metadata", func(t *testing.T) {
		// Base Sepolia USDC address
		info, err := evm.GetAssetInfo("eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
		if err != nil {
			t.Fatalf("Failed to get asset info: %v", err)
		}

		// Should match the configured USDC
		if info.Decimals != 6 {
			t.Errorf("Expected 6 decimals for USDC, got %d", info.Decimals)
		}
	})

	t.Run("Empty asset uses network default", func(t *testing.T) {
		info, err := evm.GetAssetInfo("eip155:84532", "")
		if err != nil {
			t.Fatalf("Failed to get asset info: %v", err)
		}

		if info.Address == "" {
			t.Error("Expected default asset address")
		}
	})

	t.Run("Network without default asset fails for empty asset", func(t *testing.T) {
		_, err := evm.GetAssetInfo("eip155:999999", "")
		if err == nil {
			t.Error("Expected error when no default asset configured")
		}
	})
}

// TestCreateValidityWindow tests validity window creation
func TestCreateValidityWindow(t *testing.T) {
	t.Run("Creates valid window", func(t *testing.T) {
		validAfter, validBefore := evm.CreateValidityWindow(time.Hour) // 1 hour

		// validAfter should be ~30 seconds in the past
		if validAfter.Int64() >= validBefore.Int64() {
			t.Error("validAfter should be before validBefore")
		}

		// Window should be approximately 1 hour + 600 seconds buffer
		window := validBefore.Int64() - validAfter.Int64()
		if window < 4100 || window > 4300 { // Allow some tolerance
			t.Errorf("Expected window ~4200 seconds, got %d", window)
		}
	})

	t.Run("validAfter is in the past", func(t *testing.T) {
		now := time.Now().Unix()
		validAfter, _ := evm.CreateValidityWindow(time.Minute)

		// validAfter should be approximately now - 600
		diff := now - validAfter.Int64()
		if diff < 595 || diff > 605 { // Allow tolerance for test execution time
			t.Errorf("validAfter should be ~600 seconds in the past, diff was %d", diff)
		}
	})

	t.Run("validBefore is in the future", func(t *testing.T) {
		now := time.Now().Unix()
		_, validBefore := evm.CreateValidityWindow(5 * time.Minute)

		// validBefore should be approximately now + 5 minutes
		diff := validBefore.Int64() - now
		if diff < 295 || diff > 305 { // Allow tolerance
			t.Errorf("validBefore should be ~5 minutes in the future, diff was %d", diff)
		}
	})
}
