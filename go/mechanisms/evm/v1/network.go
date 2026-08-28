package v1

import (
	"math/big"
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
	"stable-testnet":     big.NewInt(2201),
	"celo":               big.NewInt(42220),
	"flare":              big.NewInt(14),
}

// Networks is the list of all v1 network names.
var Networks []string

func init() {
	Networks = make([]string, 0, len(NetworkChainIDs))
	for name := range NetworkChainIDs {
		Networks = append(Networks, name)
	}
}
