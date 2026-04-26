/**
 * CAIP-2 network identifier for Hedera Mainnet.
 */
export const HEDERA_MAINNET_CAIP2 = "hedera:mainnet";

/**
 * CAIP-2 network identifier for Hedera Testnet.
 */
export const HEDERA_TESTNET_CAIP2 = "hedera:testnet";

/**
 * Asset id used by x402 to represent native HBAR.
 */
export const HBAR_ASSET_ID = "0.0.0";

/**
 * Regex for Hedera account and token IDs.
 * Example: 0.0.1234
 */
export const HEDERA_ENTITY_ID_REGEX = /^\d+\.\d+\.\d+$/;

/**
 * USDC token id on Hedera Mainnet (issued by Circle).
 */
export const HEDERA_MAINNET_USDC = "0.0.456858";

/**
 * USDC token id on Hedera Testnet.
 */
export const HEDERA_TESTNET_USDC = "0.0.429274";

/**
 * USDC decimals on Hedera.
 */
export const HEDERA_USDC_DECIMALS = 6;

/**
 * Supported Hedera CAIP-2 networks for this mechanism.
 */
export const SUPPORTED_HEDERA_NETWORKS = [HEDERA_MAINNET_CAIP2, HEDERA_TESTNET_CAIP2] as const;
