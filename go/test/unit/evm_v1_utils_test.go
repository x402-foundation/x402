package unit_test

import (
	"testing"

	evmv1 "github.com/coinbase/x402/go/mechanisms/evm/v1"
)

func TestV1GetEvmChainId(t *testing.T) {
	tests := []struct {
		name          string
		network       string
		expectedChain int64
		expectError   bool
	}{
		{"base", "base", 8453, false},
		{"base-sepolia", "base-sepolia", 84532, false},
		{"ethereum", "ethereum", 1, false},
		{"polygon", "polygon", 137, false},
		{"megaeth", "megaeth", 4326, false},
		{"monad", "monad", 143, false},
		{"avalanche", "avalanche", 43114, false},
		{"sei", "sei", 1329, false},

		// CAIP-2 format should NOT work in v1
		{"CAIP-2 rejected", "eip155:8453", 0, true},
		{"Unknown network", "unknown-chain", 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chainID, err := evmv1.GetEvmChainId(tt.network)

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

func TestV1GetNetworkConfig(t *testing.T) {
	t.Run("base has default asset", func(t *testing.T) {
		config, err := evmv1.GetNetworkConfig("base")
		if err != nil {
			t.Fatalf("Failed to get config: %v", err)
		}

		if config.ChainID.Int64() != 8453 {
			t.Errorf("Expected chain ID 8453, got %d", config.ChainID.Int64())
		}

		if config.DefaultAsset.Address == "" {
			t.Error("Expected default asset to be configured")
		}

		if config.DefaultAsset.Decimals != 6 {
			t.Errorf("Expected 6 decimals, got %d", config.DefaultAsset.Decimals)
		}
	})

	t.Run("base-sepolia has default asset", func(t *testing.T) {
		config, err := evmv1.GetNetworkConfig("base-sepolia")
		if err != nil {
			t.Fatalf("Failed to get config: %v", err)
		}

		if config.ChainID.Int64() != 84532 {
			t.Errorf("Expected chain ID 84532, got %d", config.ChainID.Int64())
		}
	})

	t.Run("polygon has default asset", func(t *testing.T) {
		config, err := evmv1.GetNetworkConfig("polygon")
		if err != nil {
			t.Fatalf("Failed to get config: %v", err)
		}

		if config.ChainID.Int64() != 137 {
			t.Errorf("Expected chain ID 137, got %d", config.ChainID.Int64())
		}

		if config.DefaultAsset.Address != "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" {
			t.Errorf("Expected USDC address, got %s", config.DefaultAsset.Address)
		}

		if config.DefaultAsset.Decimals != 6 {
			t.Errorf("Expected 6 decimals, got %d", config.DefaultAsset.Decimals)
		}
	})

	t.Run("network without config returns error", func(t *testing.T) {
		_, err := evmv1.GetNetworkConfig("iotex")
		if err == nil {
			t.Error("Expected error for network without configured default asset")
		}
	})

	t.Run("CAIP-2 format rejected", func(t *testing.T) {
		_, err := evmv1.GetNetworkConfig("eip155:8453")
		if err == nil {
			t.Error("Expected error for CAIP-2 format in v1")
		}
	})
}

func TestV1GetAssetInfo(t *testing.T) {
	t.Run("explicit address returns info", func(t *testing.T) {
		info, err := evmv1.GetAssetInfo("base", "0x1234567890123456789012345678901234567890")
		if err != nil {
			t.Fatalf("Failed to get asset info: %v", err)
		}

		if info.Address != "0x1234567890123456789012345678901234567890" {
			t.Errorf("Address mismatch: %s", info.Address)
		}

		if info.Decimals != 18 {
			t.Errorf("Expected 18 decimals for unknown token, got %d", info.Decimals)
		}
	})

	t.Run("empty asset uses network default", func(t *testing.T) {
		info, err := evmv1.GetAssetInfo("base-sepolia", "")
		if err != nil {
			t.Fatalf("Failed to get asset info: %v", err)
		}

		if info.Address == "" {
			t.Error("Expected default asset address")
		}
	})

	t.Run("polygon empty asset uses default USDC", func(t *testing.T) {
		info, err := evmv1.GetAssetInfo("polygon", "")
		if err != nil {
			t.Fatalf("Failed to get asset info: %v", err)
		}

		if info.Address != "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" {
			t.Errorf("Expected Polygon USDC address, got %s", info.Address)
		}
	})

	t.Run("network without config fails for empty asset", func(t *testing.T) {
		_, err := evmv1.GetAssetInfo("iotex", "")
		if err == nil {
			t.Error("Expected error for network without default asset")
		}
	})
}

func TestV1NetworksListPopulated(t *testing.T) {
	if len(evmv1.Networks) == 0 {
		t.Error("Networks list should not be empty")
	}

	if len(evmv1.Networks) != len(evmv1.NetworkChainIDs) {
		t.Errorf("Networks list length %d should match NetworkChainIDs length %d",
			len(evmv1.Networks), len(evmv1.NetworkChainIDs))
	}
}
