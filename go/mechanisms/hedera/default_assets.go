package hedera

import (
	"fmt"
	"strings"
)

// HederaDefaultAsset is a USD-pegged HTS token used for money strings and spend caps.
type HederaDefaultAsset struct {
	Asset    string
	Decimals int
	Symbol   string
}

// DefaultAssets maps CAIP-2 network to USD-pegged assets; index 0 is the "$0.10" default.
var DefaultAssets = map[string][]HederaDefaultAsset{
	HederaMainnetCAIP2: {
		{Asset: HederaMainnetUSDC, Decimals: HederaUSDCDecimals, Symbol: "USDC"},
	},
	HederaTestnetCAIP2: {
		{Asset: HederaTestnetUSDC, Decimals: HederaUSDCDecimals, Symbol: "USDC"},
	},
}

// GetDefaultAsset looks up a default asset by network and optional ticker.
// Empty symbol returns the network default (index 0).
func GetDefaultAsset(network string, symbol string) (*HederaDefaultAsset, error) {
	assets := DefaultAssets[network]
	if len(assets) == 0 {
		return nil, fmt.Errorf("no default asset configured for network %s", network)
	}
	if symbol == "" {
		entry := assets[0]
		return &entry, nil
	}
	normalized := strings.ToUpper(symbol)
	for i := range assets {
		if strings.ToUpper(assets[i].Symbol) == normalized {
			entry := assets[i]
			return &entry, nil
		}
	}
	return nil, fmt.Errorf("no %s default asset configured for network %s", symbol, network)
}

// FindDefaultAsset reverse-looks up by HTS token id and network.
func FindDefaultAsset(asset string, network string) *HederaDefaultAsset {
	for _, entry := range DefaultAssets[network] {
		if entry.Asset == asset {
			return &entry
		}
	}
	return nil
}
