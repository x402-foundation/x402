package v1

import (
	"math/big"

	"github.com/coinbase/x402/go/mechanisms/evm"
)

// NetworkChainIDs maps v1 legacy network names to their chain IDs.
var NetworkChainIDs = map[string]*big.Int{
	"ethereum":           big.NewInt(1),
	"sepolia":            big.NewInt(11155111),
	"abstract":           big.NewInt(2741),
	"abstract-testnet":   big.NewInt(11124),
	"base-sepolia":       big.NewInt(84532),
	"base":               big.NewInt(8453),
	"avalanche-fuji":     big.NewInt(43113),
	"avalanche":          big.NewInt(43114),
	"iotex":              big.NewInt(4689),
	"sei":                big.NewInt(1329),
	"sei-testnet":        big.NewInt(1328),
	"polygon":            big.NewInt(137),
	"polygon-amoy":       big.NewInt(80002),
	"peaq":               big.NewInt(3338),
	"story":              big.NewInt(1514),
	"educhain":           big.NewInt(41923),
	"skale-base-sepolia": big.NewInt(324705682),
	"megaeth":            big.NewInt(4326),
	"monad":              big.NewInt(143),
	"stable":             big.NewInt(988),
}

// NetworkConfigs maps v1 legacy network names to their full configuration.
// Only networks that have a known default asset are included here.
var NetworkConfigs = map[string]evm.NetworkConfig{
	"base": {
		ChainID: big.NewInt(8453),
		DefaultAsset: evm.AssetInfo{
			Address:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			Name:     "USD Coin",
			Version:  "2",
			Decimals: evm.DefaultDecimals,
		},
	},
	"base-sepolia": {
		ChainID: big.NewInt(84532),
		DefaultAsset: evm.AssetInfo{
			Address:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Name:     "USDC",
			Version:  "2",
			Decimals: evm.DefaultDecimals,
		},
	},
	"megaeth": {
		ChainID: big.NewInt(4326),
		DefaultAsset: evm.AssetInfo{
			Address:  "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
			Name:     "MegaUSD",
			Version:  "1",
			Decimals: 18,
		},
	},
	"monad": {
		ChainID: big.NewInt(143),
		DefaultAsset: evm.AssetInfo{
			Address:  "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
			Name:     "USD Coin",
			Version:  "2",
			Decimals: evm.DefaultDecimals,
		},
	},
	"stable": {
		ChainID: big.NewInt(988),
		DefaultAsset: evm.AssetInfo{
			Address:  "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
			Name:     "USDT0",
			Version:  "1",
			Decimals: evm.DefaultDecimals,
		},
	},
	"polygon": {
		ChainID: big.NewInt(137),
		DefaultAsset: evm.AssetInfo{
			Address:  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
			Name:     "USD Coin",
			Version:  "2",
			Decimals: evm.DefaultDecimals,
		},
	},
}

// Networks is the list of all v1 network names.
var Networks []string

func init() {
	Networks = make([]string, 0, len(NetworkChainIDs))
	for name := range NetworkChainIDs {
		Networks = append(Networks, name)
	}
}
