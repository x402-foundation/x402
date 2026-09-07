import type { Network } from "@x402/core/types";

/**
 * CAIP-2 network identifier for Sui Mainnet.
 */
export const SUI_MAINNET_CAIP2 = "sui:mainnet";

/**
 * CAIP-2 network identifier for Sui Testnet.
 */
export const SUI_TESTNET_CAIP2 = "sui:testnet";

/**
 * CAIP-2 network identifier for Sui Devnet.
 */
export const SUI_DEVNET_CAIP2 = "sui:devnet";

/**
 * Native Circle USDC on Sui mainnet (CCTP).
 */
export const USDC_MAINNET =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/**
 * Circle native USDC on Sui testnet.
 */
export const USDC_TESTNET =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

/**
 * USDC decimal places.
 */
export const USDC_DECIMALS = 6;

/**
 * Default fullnode URLs, keyed by CAIP-2 network id.
 */
export const SUI_FULLNODE_URLS: Record<string, string> = {
  [SUI_MAINNET_CAIP2]: "https://fullnode.mainnet.sui.io:443",
  [SUI_TESTNET_CAIP2]: "https://fullnode.testnet.sui.io:443",
  [SUI_DEVNET_CAIP2]: "https://fullnode.devnet.sui.io:443",
};

/**
 * Recommended maximum byte length of the optional server nonce (`extra.nonce`)
 * for gasless eligibility: a gasless transaction may carry one unused `Pure`
 * input of at most 32 bytes. A recommendation, not a facilitator-enforced cap.
 */
export const NONCE_GASLESS_PURE_BYTES = 32;

/**
 * Get the default USDC coin type for a network. Devnet has no canonical USDC:
 * prices there must be passed as an explicit AssetAmount.
 *
 * @param network - CAIP-2 network identifier
 * @returns USDC coin type string
 */
export function getUsdcCoinType(network: Network): string {
  switch (network) {
    case SUI_MAINNET_CAIP2:
      return USDC_MAINNET;
    case SUI_TESTNET_CAIP2:
      return USDC_TESTNET;
    default:
      throw new Error(`No default USDC coin type configured for network: ${network}`);
  }
}
