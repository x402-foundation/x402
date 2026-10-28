package cardano

import (
	"fmt"
	"strings"
)

// DefaultAsset is a USD-pegged Cardano asset used for money strings and spend caps.
type DefaultAsset struct {
	Asset    string
	Decimals int
	Symbol   string
}

// DefaultAssets maps a canonical network to its USD-pegged assets; index 0 is the default.
var DefaultAssets = map[string][]DefaultAsset{
	CardanoMainnetCAIP2: {{Asset: USDMMainnetAsset, Decimals: USDMDefaultDecimals, Symbol: "USDM"}},
	CardanoPreprodCAIP2: {{Asset: USDMPreprodAsset, Decimals: USDMDefaultDecimals, Symbol: "USDM"}},
}

// GetDefaultAsset returns a copy of the network's default asset, or of the one
// matching symbol.
func GetDefaultAsset(network string, symbol string) (*DefaultAsset, error) {
	assets := DefaultAssets[NormalizeNetwork(network)]
	if len(assets) == 0 {
		return nil, fmt.Errorf("no default asset configured for network %s", network)
	}
	if symbol == "" {
		entry := assets[0]
		return &entry, nil
	}
	for _, entry := range assets {
		if strings.EqualFold(entry.Symbol, symbol) {
			return &entry, nil
		}
	}
	return nil, fmt.Errorf("no %s default asset configured for network %s", symbol, network)
}

// FindDefaultAsset returns a copy of the default asset entry for asset on
// network, or nil.
func FindDefaultAsset(asset string, network string) *DefaultAsset {
	assets := DefaultAssets[NormalizeNetwork(network)]
	for _, entry := range assets {
		if strings.EqualFold(entry.Asset, asset) {
			return &entry
		}
	}
	return nil
}
