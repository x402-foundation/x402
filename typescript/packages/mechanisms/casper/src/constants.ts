/**
 * Casper mainnet CAIP-2 network identifier.
 */
export const CASPER_MAINNET_CAIP2 = "casper:casper";

/**
 * Casper testnet CAIP-2 network identifier.
 */
export const CASPER_TESTNET_CAIP2 = "casper:casper-test";

/**
 * Casper CAIP-2 family wildcard.
 */
export const CASPER_CAIP2_FAMILY = "casper:*";

/**
 * Exact payment scheme identifier.
 */
export const SCHEME_EXACT = "exact";

/**
 * Default Casper payment amount, in motes, for settlement transactions.
 */
export const DEFAULT_PAYMENT_MOTES = 2_500_000_000;

/**
 * Default network configurations keyed by CAIP-2 network identifier.
 */
export const NetworkConfigs: Record<string, NetworkConfig> = {
  [CASPER_MAINNET_CAIP2]: {
    chainName: "casper",
    rpcUrl: "https://node.mainnet.casper.network/rpc",
  },
  [CASPER_TESTNET_CAIP2]: {
    chainName: "casper-test",
    rpcUrl: "https://node.testnet.casper.network/rpc",
  },
};

/**
 * csprUSD package address on Mainnet.
 */
export const CSPR_USDC_MAINNET_ASSET =
  "23036be872bd574590a2c43d4a4eff76b18b4bca815790742841002fdab22cee";

/**
 * csprUSD package address on Testnet.
 */
export const CSPR_USDC_TESTNET_ASSET =
  "0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52";

/**
 * csprUSD decimals.
 */
export const CSPR_USDC_DECIMALS = 6;

/**
 * csprUSD contract name.
 */
export const CSPR_USDC_NAME = "csprUSD";

/**
 * csprUSD symbol.
 */
export const CSPR_USDC_SYMBOL = "csprUSD";

/**
 * Configuration for a Casper network.
 */
export type NetworkConfig = {
  /** Chain name used in transaction payloads, e.g. "casper" or "casper-test". */
  chainName: string;
  /** Default JSON-RPC endpoint for the network. */
  rpcUrl: string;
};
