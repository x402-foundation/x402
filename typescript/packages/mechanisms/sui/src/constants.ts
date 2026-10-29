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
 * Circle USDC on Sui mainnet.
 */
export const USDC_MAINNET =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/**
 * Circle USDC on Sui testnet.
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
 * Largest server nonce (`extra.nonce`), in bytes, that keeps a payment eligible
 * for gasless execution. Gasless requires every `Pure` input, used or not, to be
 * at most 32 bytes, and allows at most one unused `Pure` input. Not enforced by
 * the facilitator.
 */
export const NONCE_GASLESS_PURE_BYTES = 32;

/**
 * Default cap, in MIST, on the gas budget of a sponsored payment (0.01 SUI).
 * A sponsored `send_funds` budgets about 2,000 gas units times the gas price:
 * roughly 200,000 MIST on mainnet and 2,000,000 MIST on testnet.
 */
export const DEFAULT_MAX_SPONSORED_GAS_BUDGET = 10_000_000n;

/**
 * Most `extra.splits` entries any facilitator accepts (9 recipients with
 * `payTo`), the same as Solana. Sui allows 10 balance withdrawals per
 * transaction, counting gas paid from an address balance, so one withdrawal per
 * recipient fits 9 recipients.
 */
export const MAX_SPLITS = 8;

/**
 * Largest `extra.splits[].memo`, in UTF-8 bytes, the same as Solana.
 */
export const MAX_SPLIT_MEMO_BYTES = 566;
