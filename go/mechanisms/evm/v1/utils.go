package v1

import (
	"fmt"
	"math/big"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// GetEvmChainId returns the chain ID for a v1 legacy network name.
func GetEvmChainId(network string) (*big.Int, error) {
	if chainID, ok := NetworkChainIDs[network]; ok {
		return chainID, nil
	}
	return nil, fmt.Errorf("unsupported v1 network: %s", network)
}

// GetNetworkConfig returns the full configuration for a v1 legacy network name.
func GetNetworkConfig(network string) (*evm.NetworkConfig, error) {
	if config, ok := NetworkConfigs[network]; ok {
		return &config, nil
	}
	return nil, fmt.Errorf("no configuration for v1 network: %s", network)
}

// GetAssetInfo returns information about an asset on a v1 network.
// If assetSymbolOrAddress is a valid address, returns info for that specific token.
// If assetSymbolOrAddress is empty or a symbol, attempts to use the network's default asset.
func GetAssetInfo(network string, assetSymbolOrAddress string) (*evm.AssetInfo, error) {
	if evm.IsValidAddress(assetSymbolOrAddress) {
		normalizedAddr := evm.NormalizeAddress(assetSymbolOrAddress)

		config, err := GetNetworkConfig(network)
		if err == nil && config.DefaultAsset.Address != "" {
			if normalizedAddr == evm.NormalizeAddress(config.DefaultAsset.Address) {
				return &config.DefaultAsset, nil
			}
		}

		return &evm.AssetInfo{
			Address:  normalizedAddr,
			Name:     "Unknown Token",
			Version:  "1",
			Decimals: 18,
		}, nil
	}

	config, err := GetNetworkConfig(network)
	if err != nil {
		return nil, err
	}

	if config.DefaultAsset.Address == "" {
		return nil, fmt.Errorf("no default asset configured for v1 network %s; specify an explicit asset address", network)
	}

	return &config.DefaultAsset, nil
}
