/**
 * CAIP-2 network identifier for Hedera Mainnet.
 */
export const HEDERA_MAINNET_CAIP2 = "hedera:mainnet";

/**
 * CAIP-2 network identifier for Hedera Testnet.
 */
export const HEDERA_TESTNET_CAIP2 = "hedera:testnet";

/**
 * Hedera Mirror Node REST API base URL for Mainnet.
 */
export const HEDERA_MAINNET_MIRROR_NODE_URL = "https://mainnet-public.mirrornode.hedera.com";

/**
 * Hedera Mirror Node REST API base URL for Testnet.
 */
export const HEDERA_TESTNET_MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";

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

/**
 * Asset transfer method in which the payer signs a `TransferTransaction`.
 */
export const HEDERA_CRYPTO_TRANSFER_METHOD = "cryptoTransfer";

/**
 * Asset transfer method in which the facilitator calls `executeTransfer`
 * on an admitted `ITransferExecutor` contract.
 */
export const HEDERA_TRANSFER_EXECUTOR_METHOD = "transferExecutor";

/**
 * Every `extra.assetTransferMethod` value this mechanism defines.
 */
export const HEDERA_ASSET_TRANSFER_METHODS = [
  HEDERA_CRYPTO_TRANSFER_METHOD,
  HEDERA_TRANSFER_EXECUTOR_METHOD,
] as const;

/**
 * Method used when `extra.assetTransferMethod` is absent.
 */
export const HEDERA_DEFAULT_ASSET_TRANSFER_METHOD = HEDERA_CRYPTO_TRANSFER_METHOD;

/**
 * Executor list entry that admits any executor. It is never implied.
 */
export const HEDERA_TRANSFER_EXECUTOR_WILDCARD = "*";

/**
 * Selector of `executeTransfer(address,address,address,uint256,bytes)`.
 */
export const HEDERA_EXECUTE_TRANSFER_SELECTOR = "0xea8f19fd";

/**
 * EVM address that denotes HBAR as the `executeTransfer` asset.
 */
export const HEDERA_HBAR_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Highest gas a Mirror Node contract call simulation accepts.
 */
export const HEDERA_MAX_CONTRACT_CALL_GAS = 15_000_000;

/**
 * Hedera account that pays staking rewards.
 */
export const HEDERA_STAKING_REWARD_ACCOUNT = "0.0.800";

/**
 * How long a pending `transferExecutor` settlement keeps its in-flight key.
 * Covers Hedera's maximum transaction valid duration of 180 seconds, counted
 * from just before submission, so the key outlives any submission that can
 * still reach consensus.
 */
export const HEDERA_TRANSFER_EXECUTOR_IN_FLIGHT_TTL_MS = 180_000;
