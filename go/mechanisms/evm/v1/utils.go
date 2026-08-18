package v1

import (
	"fmt"
	"math/big"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
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
	if found := evm.FindDefaultAsset(assetSymbolOrAddress, network); found != nil {
		return &evm.AssetInfo{
			Address:             found.Asset,
			Name:                found.Name,
			Version:             found.Version,
			Decimals:            found.Decimals,
			AssetTransferMethod: found.AssetTransferMethod,
			SupportsEip2612:     found.SupportsEip2612,
		}, nil
	}

	if evm.IsValidAddress(assetSymbolOrAddress) {
		normalizedAddr := evm.NormalizeAddress(assetSymbolOrAddress)

		return &evm.AssetInfo{
			Address:  normalizedAddr,
			Name:     "Unknown Token",
			Version:  "1",
			Decimals: 18,
		}, nil
	}

	info, err := evm.GetDefaultAsset(network, "")
	if err != nil {
		return nil, fmt.Errorf("no default asset configured for v1 network %s; specify an explicit asset address", network)
	}
	return &evm.AssetInfo{
		Address:             info.Asset,
		Name:                info.Name,
		Version:             info.Version,
		Decimals:            info.Decimals,
		AssetTransferMethod: info.AssetTransferMethod,
		SupportsEip2612:     info.SupportsEip2612,
	}, nil
}
