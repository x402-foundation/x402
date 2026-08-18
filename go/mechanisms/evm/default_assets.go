package evm

import (
	"fmt"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// DefaultAssetInfo is a USD-pegged EVM asset used for money strings and spend caps.
type DefaultAssetInfo struct {
	Asset               string
	Name                string
	Version             string
	Decimals            int
	Symbol              string
	AssetTransferMethod AssetTransferMethod
	SupportsEip2612     bool
}

// DefaultAssets maps CAIP-2 network to USD-pegged assets; index 0 is the "$0.10" default.
var DefaultAssets = map[string][]DefaultAssetInfo{
	"eip155:8453": {
		{Asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", Name: "USD Coin", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:84532": {
		{Asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", Name: "USDC", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:4326": {
		{Asset: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7", Name: "MegaUSD", Version: "1", Decimals: 18, Symbol: "MegaUSD", AssetTransferMethod: AssetTransferMethodPermit2, SupportsEip2612: true},
	},
	"eip155:143": {
		{Asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", Name: "USDC", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:988": {
		{Asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", Name: "USDT0", Version: "1", Decimals: 6, Symbol: "USDT0"},
	},
	"eip155:2201": {
		{Asset: "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9", Name: "USDT0", Version: "1", Decimals: 6, Symbol: "USDT0"},
	},
	"eip155:137": {
		{Asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", Name: "USD Coin", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:42161": {
		{Asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", Name: "USD Coin", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:421614": {
		{Asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", Name: "USD Coin", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:31612": {
		{Asset: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186", Name: "Mezo USD", Version: "1", Decimals: 18, Symbol: "mUSD", AssetTransferMethod: AssetTransferMethodPermit2, SupportsEip2612: true},
	},
	"eip155:31611": {
		{Asset: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", Name: "Mezo USD", Version: "1", Decimals: 18, Symbol: "mUSD", AssetTransferMethod: AssetTransferMethodPermit2, SupportsEip2612: true},
	},
	"eip155:723487": {
		{Asset: "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb", Name: "Stable Coin", Version: "1", Decimals: 6, Symbol: "SBC", AssetTransferMethod: AssetTransferMethodPermit2, SupportsEip2612: true},
	},
	"eip155:72344": {
		{Asset: "0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb", Name: "Stable Coin", Version: "1", Decimals: 6, Symbol: "SBC", AssetTransferMethod: AssetTransferMethodPermit2, SupportsEip2612: true},
	},
	"eip155:36900": {
		{Asset: "0x9cb8142aEBBcdc60AF7c97Af897A67A8f3CA71C2", Name: "USDC.e", Version: "2", Decimals: 6, Symbol: "USDC.e"},
	},
	"eip155:190415": {
		{Asset: "0x401eCb1D350407f13ba348573E5630B83638E30D", Name: "Bridged USDC", Version: "2", Decimals: 6, Symbol: "USDC.e"},
	},
	"eip155:181228": {
		{Asset: "0x401eCb1D350407f13ba348573E5630B83638E30D", Name: "Bridged USDC", Version: "2", Decimals: 6, Symbol: "USDC.e"},
	},
	"eip155:50": {
		{Asset: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1", Name: "USDC", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:51": {
		{Asset: "0xb5AB69F7bBada22B28e79C8FFAECe55eF1c771D4", Name: "USDC", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:38833": {
		{Asset: "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7", Name: "USDC", Version: "1", Decimals: 6, Symbol: "USDC", AssetTransferMethod: AssetTransferMethodPermit2},
	},
	"eip155:14": {
		{Asset: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", Name: "USD₮0", Version: "1", Decimals: 6, Symbol: "USDT0"},
	},
	"eip155:42220": {
		{Asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", Name: "USDC", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
	"eip155:11142220": {
		{Asset: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", Name: "USDC", Version: "2", Decimals: 6, Symbol: "USDC"},
	},
}

// legacyNetworkChainIDs maps v1 network names to chain IDs (mirrors v1.NetworkChainIDs).
var legacyNetworkChainIDs = map[string]int64{
	"ethereum":           1,
	"sepolia":            11155111,
	"abstract":           2741,
	"abstract-testnet":   11124,
	"base-sepolia":       84532,
	"base":               8453,
	"avalanche-fuji":     43113,
	"avalanche":          43114,
	"iotex":              4689,
	"sei":                1329,
	"sei-testnet":        1328,
	"polygon":            137,
	"polygon-amoy":       80002,
	"peaq":               3338,
	"story":              1514,
	"educhain":           41923,
	"skale-base-sepolia": 324705682,
	"megaeth":            4326,
	"monad":              143,
	"stable":             988,
	"stable-testnet":     2201,
	"celo":               42220,
	"flare":              14,
}

func resolveNetworkKey(network string) string {
	if _, ok := DefaultAssets[network]; ok {
		return network
	}
	if chainID, ok := legacyNetworkChainIDs[network]; ok {
		return fmt.Sprintf("eip155:%d", chainID)
	}
	return network
}

// ConvertDefaultMoney looks up the network's default (or ticker-matched) asset
// and converts a decimal amount to token smallest units.
func ConvertDefaultMoney(amount string, network string, symbol string) (*DefaultAssetInfo, string, error) {
	assetInfo, err := GetDefaultAsset(network, symbol)
	if err != nil {
		return nil, "", err
	}
	tokenAmount, err := x402.ConvertToTokenAmount(amount, assetInfo.Decimals)
	if err != nil {
		return nil, "", fmt.Errorf("failed to convert amount: %w", err)
	}
	return assetInfo, tokenAmount, nil
}

// GetDefaultAsset looks up a default asset by network and optional ticker.
// Empty symbol returns the network default (index 0).
func GetDefaultAsset(network string, symbol string) (*DefaultAssetInfo, error) {
	key := resolveNetworkKey(network)
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

// FindDefaultAsset reverse-looks up by asset id (case-insensitive) and network.
func FindDefaultAsset(asset string, network string) *DefaultAssetInfo {
	key := resolveNetworkKey(network)
	assets := DefaultAssets[key]
	if len(assets) == 0 {
		return nil
	}
	normalized := strings.ToLower(asset)
	for i := range assets {
		if strings.ToLower(assets[i].Asset) == normalized {
			entry := assets[i]
			return &entry
		}
	}
	return nil
}

func defaultAssetToAssetInfo(info *DefaultAssetInfo) *AssetInfo {
	return &AssetInfo{
		Address:             info.Asset,
		Name:                info.Name,
		Version:             info.Version,
		Decimals:            info.Decimals,
		AssetTransferMethod: info.AssetTransferMethod,
		SupportsEip2612:     info.SupportsEip2612,
	}
}
