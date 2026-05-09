// Package unit_test contains unit tests for the SVM mechanism
package unit_test

import (
	"testing"

	solana "github.com/gagliardetto/solana-go"

	x402 "github.com/x402-foundation/x402/go"
	svm "github.com/x402-foundation/x402/go/mechanisms/svm"
	svmserver "github.com/x402-foundation/x402/go/mechanisms/svm/exact/server"
)

// TestSolanaServerPriceParsing tests V2 server price parsing
func TestSolanaServerPriceParsing(t *testing.T) {
	server := svmserver.NewExactSvmScheme()
	network := x402.Network(svm.SolanaDevnetCAIP2)

	tests := []struct {
		name          string
		price         x402.Price
		expectedAsset string
		shouldError   bool
	}{
		{
			name:          "Simple decimal",
			price:         "0.10",
			expectedAsset: svm.USDCDevnetAddress,
			shouldError:   false,
		},
		{
			name:          "Dollar sign",
			price:         "$0.10",
			expectedAsset: svm.USDCDevnetAddress,
			shouldError:   false,
		},
		{
			name:          "With currency",
			price:         "0.10 USDC",
			expectedAsset: svm.USDCDevnetAddress,
			shouldError:   false,
		},
		{
			name:          "Float",
			price:         float64(0.10),
			expectedAsset: svm.USDCDevnetAddress,
			shouldError:   false,
		},
		{
			name:          "Integer",
			price:         1,
			expectedAsset: svm.USDCDevnetAddress,
			shouldError:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := server.ParsePrice(tt.price, network)
			if tt.shouldError && err == nil {
				t.Fatal("Expected error but got none")
			}
			if !tt.shouldError && err != nil {
				t.Fatalf("Unexpected error: %v", err)
			}
			if !tt.shouldError {
				if result.Asset != tt.expectedAsset {
					t.Errorf("Expected asset %s, got %s", tt.expectedAsset, result.Asset)
				}
				if result.Amount == "" {
					t.Error("Expected non-empty amount")
				}
			}
		})
	}
}

// TestSolanaUtilities tests utility functions
func TestSolanaUtilities(t *testing.T) {
	t.Run("NormalizeNetwork", func(t *testing.T) {
		tests := []struct {
			input    string
			expected string
			isError  bool
		}{
			{svm.SolanaMainnetV1, svm.SolanaMainnetCAIP2, false},
			{svm.SolanaDevnetV1, svm.SolanaDevnetCAIP2, false},
			{svm.SolanaTestnetV1, svm.SolanaTestnetCAIP2, false},
			{svm.SolanaMainnetCAIP2, svm.SolanaMainnetCAIP2, false},
			{"invalid", "", true},
		}

		for _, tt := range tests {
			result, err := svm.NormalizeNetwork(tt.input)
			if tt.isError && err == nil {
				t.Errorf("Expected error for input %s", tt.input)
			}
			if !tt.isError && err != nil {
				t.Errorf("Unexpected error for input %s: %v", tt.input, err)
			}
			if !tt.isError && result != tt.expected {
				t.Errorf("For input %s, expected %s, got %s", tt.input, tt.expected, result)
			}
		}
	})

	t.Run("ValidateSolanaAddress", func(t *testing.T) {
		validAddresses := []string{
			"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mainnet
			"11111111111111111111111111111111",             // System program
			"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // USDC devnet
		}

		invalidAddresses := []string{
			"",
			"invalid",
			"0x1234567890123456789012345678901234567890", // EVM address
			"123",
		}

		for _, addr := range validAddresses {
			if !svm.ValidateSolanaAddress(addr) {
				t.Errorf("Expected %s to be valid", addr)
			}
		}

		for _, addr := range invalidAddresses {
			if svm.ValidateSolanaAddress(addr) {
				t.Errorf("Expected %s to be invalid", addr)
			}
		}
	})

	t.Run("ParseAmount", func(t *testing.T) {
		tests := []struct {
			amount   string
			decimals int
			expected uint64
		}{
			{"1", 6, 1000000},
			{"0.1", 6, 100000},
			{"0.01", 6, 10000},
			{"1.5", 6, 1500000},
			{"100", 6, 100000000},
		}

		for _, tt := range tests {
			result, err := svm.ParseAmount(tt.amount, tt.decimals)
			if err != nil {
				t.Errorf("Unexpected error for %s: %v", tt.amount, err)
			}
			if result != tt.expected {
				t.Errorf("For %s with %d decimals, expected %d, got %d", tt.amount, tt.decimals, tt.expected, result)
			}
		}
	})

	t.Run("FormatAmount", func(t *testing.T) {
		tests := []struct {
			amount   uint64
			decimals int
			expected string
		}{
			{1000000, 6, "1"},
			{100000, 6, "0.1"},
			{10000, 6, "0.01"},
			{1500000, 6, "1.5"},
			{100000000, 6, "100"},
		}

		for _, tt := range tests {
			result := svm.FormatAmount(tt.amount, tt.decimals)
			if result != tt.expected {
				t.Errorf("For %d with %d decimals, expected %s, got %s", tt.amount, tt.decimals, tt.expected, result)
			}
		}
	})
}

// TestSolanaIsValidNetwork tests network validation
func TestSolanaIsValidNetwork(t *testing.T) {
	validNetworks := []string{
		svm.SolanaMainnetCAIP2,
		svm.SolanaDevnetCAIP2,
		svm.SolanaTestnetCAIP2,
		svm.SolanaMainnetV1,
		svm.SolanaDevnetV1,
		svm.SolanaTestnetV1,
	}

	invalidNetworks := []string{
		"ethereum",
		"base",
		"invalid:network",
		"",
	}

	for _, network := range validNetworks {
		if !svm.IsValidNetwork(network) {
			t.Errorf("Expected %s to be valid", network)
		}
	}

	for _, network := range invalidNetworks {
		if svm.IsValidNetwork(network) {
			t.Errorf("Expected %s to be invalid", network)
		}
	}
}

// TestSolanaGetNetworkConfig tests network config retrieval
func TestSolanaGetNetworkConfig(t *testing.T) {
	tests := []struct {
		input        string
		expectedCAIP string
		shouldError  bool
	}{
		{svm.SolanaMainnetV1, svm.SolanaMainnetCAIP2, false},
		{svm.SolanaMainnetCAIP2, svm.SolanaMainnetCAIP2, false},
		{svm.SolanaDevnetV1, svm.SolanaDevnetCAIP2, false},
		{"invalid", "", true},
	}

	for _, tt := range tests {
		config, err := svm.GetNetworkConfig(tt.input)
		if tt.shouldError && err == nil {
			t.Errorf("Expected error for %s", tt.input)
		}
		if !tt.shouldError && err != nil {
			t.Errorf("Unexpected error for %s: %v", tt.input, err)
		}
		if !tt.shouldError {
			if config.CAIP2 != tt.expectedCAIP {
				t.Errorf("Expected CAIP2 %s, got %s", tt.expectedCAIP, config.CAIP2)
			}
		}
	}
}

// TestSolanaMessageVersioning tests message version setting
func TestSolanaMessageVersioning(t *testing.T) {
	t.Run("SetVersionToV0", func(t *testing.T) {
		// Test that we can set the message version to V0
		// This is important for cross-platform compatibility with Python/TypeScript facilitators
		msg := solana.Message{
			Header: solana.MessageHeader{
				NumRequiredSignatures:       1,
				NumReadonlySignedAccounts:   0,
				NumReadonlyUnsignedAccounts: 0,
			},
			AccountKeys:     []solana.PublicKey{solana.MustPublicKeyFromBase58("11111111111111111111111111111111")},
			RecentBlockhash: solana.MustHashFromBase58("11111111111111111111111111111111"),
		}

		// Default should be legacy
		if msg.IsVersioned() {
			t.Error("New message should be legacy by default")
		}

		// Set to V0
		msg.SetVersion(solana.MessageVersionV0)

		// Should now be versioned
		if !msg.IsVersioned() {
			t.Error("Message should be versioned after SetVersion(V0)")
		}
	})

	t.Run("VersionedTransactionSerialization", func(t *testing.T) {
		// Create a message and set it to V0
		msg := solana.Message{
			Header: solana.MessageHeader{
				NumRequiredSignatures:       1,
				NumReadonlySignedAccounts:   0,
				NumReadonlyUnsignedAccounts: 0,
			},
			AccountKeys:     []solana.PublicKey{solana.MustPublicKeyFromBase58("11111111111111111111111111111111")},
			RecentBlockhash: solana.MustHashFromBase58("11111111111111111111111111111111"),
		}
		msg.SetVersion(solana.MessageVersionV0)

		// Serialize
		msgBytes, err := msg.MarshalBinary()
		if err != nil {
			t.Fatalf("Failed to marshal message: %v", err)
		}

		// First byte should be version marker (128 for v0)
		if msgBytes[0] != 128 {
			t.Errorf("Expected first byte to be 128 (v0 marker), got %d", msgBytes[0])
		}
	})
}

// TestSolanaGetAssetInfo tests asset info retrieval
func TestSolanaGetAssetInfo(t *testing.T) {
	t.Run("By symbol", func(t *testing.T) {
		info, err := svm.GetAssetInfo(svm.SolanaDevnetCAIP2, "USDC")
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}
		if info.Address != svm.USDCDevnetAddress {
			t.Errorf("Expected address %s, got %s", svm.USDCDevnetAddress, info.Address)
		}
		if info.Decimals != 6 {
			t.Errorf("Expected decimals 6, got %d", info.Decimals)
		}
	})

	t.Run("By address", func(t *testing.T) {
		info, err := svm.GetAssetInfo(svm.SolanaDevnetCAIP2, svm.USDCDevnetAddress)
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}
		if info.Address != svm.USDCDevnetAddress {
			t.Errorf("Expected address %s, got %s", svm.USDCDevnetAddress, info.Address)
		}
	})

	t.Run("Default asset", func(t *testing.T) {
		info, err := svm.GetAssetInfo(svm.SolanaDevnetCAIP2, "unknown")
		if err != nil {
			t.Fatalf("Unexpected error: %v", err)
		}
		// Should return default asset
		if info.Address != svm.USDCDevnetAddress {
			t.Errorf("Expected default asset address %s, got %s", svm.USDCDevnetAddress, info.Address)
		}
	})
}
