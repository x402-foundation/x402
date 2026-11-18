package casper

import "time"

const SettlementTTL = 120 * time.Second

const (
	SchemeExact = "exact"

	CasperMainnetCAIP2 = "casper:casper"
	CasperTestnetCAIP2 = "casper:casper-test"

	CSPRUSDMainnetAsset = "23036be872bd574590a2c43d4a4eff76b18b4bca815790742841002fdab22cee"
	CSPRUSDTestnetAsset = "0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52"
	CSPRUSDDecimals     = 6
	CSPRUSDName         = "csprUSD"
	CSPRUSDSymbol       = "csprUSD"
)

var NetworkConfigs = map[string]NetworkConfig{
	CasperMainnetCAIP2: {
		ChainName: "casper",
		RPCURL:    "https://node.mainnet.casper.network/rpc",
	},
	CasperTestnetCAIP2: {
		ChainName: "casper-test",
		RPCURL:    "https://node.testnet.casper.network/rpc",
	},
}
