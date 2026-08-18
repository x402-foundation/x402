package svm

import (
	"fmt"
	"strings"
)

// SvmDefaultAsset is a USD-pegged SVM asset used for money strings and spend caps.
type SvmDefaultAsset struct {
	Asset        string
	Decimals     int
	Symbol       string
	TokenProgram string
}

// DefaultAssets maps CAIP-2 network to USD-pegged assets; index 0 is the "$0.10" default.
var DefaultAssets = map[string][]SvmDefaultAsset{
	SolanaMainnetCAIP2: {
		{Asset: USDCMainnetAddress, Decimals: 6, Symbol: "USDC", TokenProgram: TokenProgramAddress},
		{Asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", Decimals: 6, Symbol: "USDT", TokenProgram: TokenProgramAddress},
		{Asset: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", Decimals: 6, Symbol: "USDG", TokenProgram: Token2022ProgramAddress},
		{Asset: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", Decimals: 6, Symbol: "PYUSD", TokenProgram: Token2022ProgramAddress},
		{Asset: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", Decimals: 6, Symbol: "CASH", TokenProgram: Token2022ProgramAddress},
	},
	SolanaDevnetCAIP2: {
		{Asset: USDCDevnetAddress, Decimals: 6, Symbol: "USDC", TokenProgram: TokenProgramAddress},
		{Asset: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7", Decimals: 6, Symbol: "USDG", TokenProgram: Token2022ProgramAddress},
		{Asset: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM", Decimals: 6, Symbol: "PYUSD", TokenProgram: Token2022ProgramAddress},
	},
	SolanaTestnetCAIP2: {
		{Asset: USDCTestnetAddress, Decimals: 6, Symbol: "USDC", TokenProgram: TokenProgramAddress},
		{Asset: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7", Decimals: 6, Symbol: "USDG", TokenProgram: Token2022ProgramAddress},
		{Asset: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM", Decimals: 6, Symbol: "PYUSD", TokenProgram: Token2022ProgramAddress},
	},
}

func resolveNetworkKey(network string) (string, error) {
	return NormalizeNetwork(network)
}

// GetDefaultAsset looks up a default asset by network and optional ticker.
// Empty symbol returns the network default (index 0).
func GetDefaultAsset(network string, symbol string) (*SvmDefaultAsset, error) {
	key, err := resolveNetworkKey(network)
	if err != nil {
		return nil, fmt.Errorf("no default asset configured for network %s", network)
	}
	assets := DefaultAssets[key]
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

// FindDefaultAsset reverse-looks up by mint address and network.
func FindDefaultAsset(asset string, network string) *SvmDefaultAsset {
	key, err := resolveNetworkKey(network)
	if err != nil {
		return nil
	}
	assets := DefaultAssets[key]
	if len(assets) == 0 {
		return nil
	}
	for i := range assets {
		if assets[i].Asset == asset {
			entry := assets[i]
			return &entry
		}
	}
	return nil
}

func defaultAssetToAssetInfo(info *SvmDefaultAsset) *AssetInfo {
	return &AssetInfo{
		Address:  info.Asset,
		Symbol:   info.Symbol,
		Decimals: info.Decimals,
	}
}
