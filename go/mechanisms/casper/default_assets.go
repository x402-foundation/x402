package casper

import (
	"fmt"
	"strings"
)

// CasperDefaultAsset is a USD-pegged Casper asset used for money strings and spend caps.
type CasperDefaultAsset struct {
	Asset    string
	Decimals int
	Name     string
	Symbol   string
	Version  string
}

// DefaultAssets maps CAIP-2 network to USD-pegged assets; index 0 is the "$0.10" default.
var DefaultAssets = map[string][]CasperDefaultAsset{
	CasperMainnetCAIP2: {
		{Asset: CSPRUSDMainnetAsset, Decimals: CSPRUSDDecimals, Name: CSPRUSDName, Symbol: CSPRUSDSymbol, Version: "1"},
	},
	CasperTestnetCAIP2: {
		{Asset: CSPRUSDTestnetAsset, Decimals: CSPRUSDDecimals, Name: CSPRUSDName, Symbol: CSPRUSDSymbol, Version: "1"},
	},
}

// GetDefaultAsset looks up a default asset by CAIP-2 network and optional ticker.
// Empty symbol returns the network default (index 0).
func GetDefaultAsset(network string, symbol string) (*CasperDefaultAsset, error) {
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

// FindDefaultAsset reverse-looks up by mint address and CAIP-2 network.
func FindDefaultAsset(asset string, network string) *CasperDefaultAsset {
	assets := DefaultAssets[network]
	if len(assets) == 0 {
		return nil
	}
	for i := range assets {
		if strings.EqualFold(assets[i].Asset, asset) {
			entry := assets[i]
			return &entry
		}
	}
	return nil
}

func defaultAssetToAssetInfo(info *CasperDefaultAsset) *AssetInfo {
	return &AssetInfo{
		Asset:    info.Asset,
		Symbol:   info.Symbol,
		Decimals: info.Decimals,
	}
}
