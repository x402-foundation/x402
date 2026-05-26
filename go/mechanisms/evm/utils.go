package evm

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"time"
)

// GetEvmChainId returns the chain ID for a given CAIP-2 network identifier (eip155:CHAIN_ID).
func GetEvmChainId(network string) (*big.Int, error) {
	if strings.HasPrefix(network, "eip155:") {
		chainIdStr := strings.TrimPrefix(network, "eip155:")
		chainId, ok := new(big.Int).SetString(chainIdStr, 10)
		if ok {
			return chainId, nil
		}
	}

	return nil, fmt.Errorf("unsupported network: %s (expected eip155:CHAIN_ID)", network)
}

// CreateNonce generates a random 32-byte nonce for EIP-3009
func CreateNonce() (string, error) {
	nonce := make([]byte, 32)
	_, err := rand.Read(nonce)
	if err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}
	return "0x" + hex.EncodeToString(nonce), nil
}

// CreatePermit2Nonce generates a random 256-bit nonce for Permit2.
// Permit2 uses uint256 nonces (not bytes32 like EIP-3009).
func CreatePermit2Nonce() (string, error) {
	nonce := make([]byte, 32)
	_, err := rand.Read(nonce)
	if err != nil {
		return "", fmt.Errorf("failed to generate nonce: %w", err)
	}
	// Convert to uint256 string representation
	nonceInt := new(big.Int).SetBytes(nonce)
	return nonceInt.String(), nil
}

// MaxUint256 returns the maximum value for uint256 (used for unlimited approval).
func MaxUint256() *big.Int {
	max := new(big.Int)
	max.Exp(big.NewInt(2), big.NewInt(256), nil)
	max.Sub(max, big.NewInt(1))
	return max
}

// NormalizeAddress ensures an Ethereum address is in the correct format
func NormalizeAddress(address string) string {
	// Remove 0x prefix if present
	addr := strings.TrimPrefix(strings.ToLower(address), "0x")

	// Add 0x prefix back
	return "0x" + addr
}

// IsValidAddress checks if a string is a valid Ethereum address
func IsValidAddress(address string) bool {
	// Remove 0x prefix if present
	addr := strings.TrimPrefix(address, "0x")

	// Check length (40 hex characters)
	if len(addr) != 40 {
		return false
	}

	// Check if all characters are valid hex
	_, err := hex.DecodeString(addr)
	return err == nil
}

// ParseAmount converts a decimal string amount to wei based on token decimals
func ParseAmount(amount string, decimals int) (*big.Int, error) {
	// Parse the decimal amount
	parts := strings.Split(amount, ".")
	if len(parts) > 2 {
		return nil, fmt.Errorf("invalid amount format: %s", amount)
	}

	// Parse integer part
	intPart, ok := new(big.Int).SetString(parts[0], 10)
	if !ok {
		return nil, fmt.Errorf("invalid integer part: %s", parts[0])
	}

	// Handle decimal part
	decPart := new(big.Int)
	if len(parts) == 2 && parts[1] != "" {
		// Pad or truncate decimal part to match token decimals
		decStr := parts[1]
		if len(decStr) > decimals {
			decStr = decStr[:decimals]
		} else {
			decStr += strings.Repeat("0", decimals-len(decStr))
		}

		decPart, ok = new(big.Int).SetString(decStr, 10)
		if !ok {
			return nil, fmt.Errorf("invalid decimal part: %s", parts[1])
		}
	}

	// Calculate total in smallest unit
	multiplier := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	result := new(big.Int).Mul(intPart, multiplier)
	result.Add(result, decPart)

	return result, nil
}

// FormatAmount converts an amount in wei to a decimal string
func FormatAmount(amount *big.Int, decimals int) string {
	if amount == nil {
		return "0"
	}

	divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	quotient, remainder := new(big.Int).DivMod(amount, divisor, new(big.Int))

	// Format the decimal part with leading zeros
	decStr := remainder.String()
	if len(decStr) < decimals {
		decStr = strings.Repeat("0", decimals-len(decStr)) + decStr
	}

	// Remove trailing zeros
	decStr = strings.TrimRight(decStr, "0")

	if decStr == "" {
		return quotient.String()
	}

	return quotient.String() + "." + decStr
}

// GetNetworkConfig returns the configuration for a CAIP-2 network identifier (eip155:CHAIN_ID).
// For networks with configured defaults, returns the full config.
// For other valid EIP-155 networks, returns a config with just the chain ID (no default asset).
func GetNetworkConfig(network string) (*NetworkConfig, error) {
	if config, ok := NetworkConfigs[network]; ok {
		return &config, nil
	}

	if strings.HasPrefix(network, "eip155:") {
		chainIdStr := strings.TrimPrefix(network, "eip155:")
		chainId, ok := new(big.Int).SetString(chainIdStr, 10)
		if ok {
			return &NetworkConfig{
				ChainID: chainId,
			}, nil
		}
	}

	return nil, fmt.Errorf("invalid network format: %s (expected eip155:CHAIN_ID)", network)
}

// GetAssetInfo returns information about an asset on a network.
// If assetSymbolOrAddress is a valid address, returns info for that specific token.
// If assetSymbolOrAddress is empty or a symbol, attempts to use the network's default asset.
//
// Args:
//   - network: The network identifier
//   - assetSymbolOrAddress: Either an asset address (0x...) or empty for default
//
// Returns:
//   - AssetInfo for the requested asset
//   - Error if default asset is requested but not configured for this network
func GetAssetInfo(network string, assetSymbolOrAddress string) (*AssetInfo, error) {
	// Check if it's an explicit address - works for ANY network
	if IsValidAddress(assetSymbolOrAddress) {
		normalizedAddr := NormalizeAddress(assetSymbolOrAddress)

		// Check if this matches a known default asset for richer metadata
		config, err := GetNetworkConfig(network)
		if err == nil && config.DefaultAsset.Address != "" {
			if normalizedAddr == NormalizeAddress(config.DefaultAsset.Address) {
				return &config.DefaultAsset, nil
			}
		}

		// Unknown token - return basic info (works for any EVM network)
		return &AssetInfo{
			Address:  normalizedAddr,
			Name:     "Unknown Token",
			Version:  "1",
			Decimals: 18, // Default to 18 decimals for unknown tokens
		}, nil
	}

	// Not an explicit address - need the network's default asset
	config, err := GetNetworkConfig(network)
	if err != nil {
		return nil, err
	}

	// Check if default asset is configured
	if config.DefaultAsset.Address == "" {
		return nil, fmt.Errorf("no default asset configured for network %s; specify an explicit asset address or register a money parser", network)
	}

	return &config.DefaultAsset, nil
}

// CreateValidityWindow creates valid after/before timestamps
func CreateValidityWindow(duration time.Duration) (validAfter, validBefore *big.Int) {
	now := time.Now().Unix()
	// Add 10 minute buffer to account for clock skew and block time
	validAfter = big.NewInt(now - 600)
	validBefore = big.NewInt(now + int64(duration.Seconds()))
	return validAfter, validBefore
}

// HexToBytes converts a hex string to bytes
func HexToBytes(hexStr string) ([]byte, error) {
	// Remove 0x prefix if present
	cleaned := strings.TrimPrefix(hexStr, "0x")
	return hex.DecodeString(cleaned)
}

// BytesToHex converts bytes to a hex string with 0x prefix
func BytesToHex(data []byte) string {
	return "0x" + hex.EncodeToString(data)
}
