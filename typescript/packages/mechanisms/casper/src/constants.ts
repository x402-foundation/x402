/**
 * Casper mainnet CAIP-2 network identifier.
 */
export const NETWORK_CASPER_MAINNET = "casper:casper";

/**
 * Casper testnet CAIP-2 network identifier.
 */
export const NETWORK_CASPER_TESTNET = "casper:casper-test";

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
 * Configuration for a Casper network.
 */
export type NetworkConfig = {
  /** Chain name used in transaction payloads, e.g. "casper" or "casper-test". */
  chainName: string;
  /** Default JSON-RPC endpoint for the network. */
  rpcUrl: string;
};

/**
 * Default network configurations keyed by CAIP-2 network identifier.
 */
export const NetworkConfigs: Record<string, NetworkConfig> = {
  [NETWORK_CASPER_MAINNET]: {
    chainName: "casper",
    rpcUrl: "https://node.mainnet.casper.network/rpc",
  },
  [NETWORK_CASPER_TESTNET]: {
    chainName: "casper-test",
    rpcUrl: "https://node.testnet.casper.network/rpc",
  },
};
