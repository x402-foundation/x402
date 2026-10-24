package casper

import "time"

const SettlementTTL = 120 * time.Second

const (
	SchemeExact = "exact"

	// CAIP-2 network identifiers (V2)
	CasperMainnetCAIP2 = "casper:casper"
	CasperTestnetCAIP2 = "casper:casper-test"

	// csprUSD package address on Mainnet.
	CSPRUSDMainnetAsset = "23036be872bd574590a2c43d4a4eff76b18b4bca815790742841002fdab22cee"

	// csprUSD package address on Testnet.
	CSPRUSDTestnetAsset = "0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52"

	// csprUSD decimals.
	CSPRUSDDecimals = 6

	// csprUSD contract name.
	CSPRUSDName = "csprUSD"

	// csprUSD symbol.
	CSPRUSDSymbol = "csprUSD"
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
