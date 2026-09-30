/**
 * CAIP-style network identifiers supported by the NEAR mechanism.
 */
export const NEAR_MAINNET_CAIP2 = "near:mainnet";
export const NEAR_TESTNET_CAIP2 = "near:testnet";

/**
 * List of canonical NEAR network identifiers.
 */
export const NEAR_NETWORKS = [NEAR_MAINNET_CAIP2, NEAR_TESTNET_CAIP2] as const;

/**
 * Default RPC endpoints for canonical NEAR networks.
 *
 * Defaults to FastNEAR's keyless public endpoints; the legacy `*.near.org`
 * public RPC has been deprecated. Override per network through the signer
 * configuration when a private/archival node is required.
 */
export const NEAR_RPC_URLS: Record<(typeof NEAR_NETWORKS)[number], string> = {
  [NEAR_MAINNET_CAIP2]: "https://rpc.mainnet.fastnear.com",
  [NEAR_TESTNET_CAIP2]: "https://rpc.testnet.fastnear.com",
};

/**
 * NEP-141 method names used by this scheme.
 */
export const FT_TRANSFER_METHOD = "ft_transfer";
export const FT_BALANCE_OF_METHOD = "ft_balance_of";

/**
 * NEP-145 storage-management view method.
 */
export const STORAGE_BALANCE_OF_METHOD = "storage_balance_of";

/**
 * NEP-141 requires exactly 1 yoctoNEAR attached to `ft_transfer`.
 */
export const ONE_YOCTO = 1n;

/**
 * Default gas for `ft_transfer` (30 TGas), expressed in gas units.
 */
export const DEFAULT_FT_TRANSFER_GAS = 30_000_000_000_000n;

/**
 * Conservative cap on sponsored gas to protect relayers (100 TGas).
 */
export const DEFAULT_MAX_SPONSORED_GAS = 100_000_000_000_000n;

/**
 * Deterministic timeout mapping (spec §5).
 *
 * `estimatedBlockSeconds = 1` for both `near:mainnet` and `near:testnet`, so
 * `timeoutBlocks = max(1, ceil(maxTimeoutSeconds / 1))`.
 */
export const ESTIMATED_BLOCK_SECONDS = 1;

/**
 * NEAR's delegate-action nonce upper-bound multiplier
 * (`ACCESS_KEY_NONCE_RANGE_MULTIPLIER`): a delegate action's nonce must be
 * strictly less than `current_block_height * NONCE_RANGE_MULTIPLIER`.
 */
export const NONCE_RANGE_MULTIPLIER = 1_000_000n;

/**
 * Base58 representation of an all-zero 32-byte code hash, returned by
 * `view_account` for an account that has no contract code deployed.
 */
export const EMPTY_CONTRACT_CODE_HASH = "11111111111111111111111111111111";

/**
 * Default decimal precision used for money conversion in server `parsePrice`.
 */
export const DEFAULT_TOKEN_DECIMALS = 6;

/**
 * Safety-net TTL for the in-memory duplicate-settlement cache (spec §10).
 *
 * The authoritative eviction triggers are `max_block_height` passing or the
 * inner `ft_transfer` receipt finishing; this TTL only bounds memory in the
 * event neither trigger fires (e.g. a settle that throws before submission).
 */
export const DEFAULT_SETTLEMENT_TTL_MS = 120_000;

/**
 * Checks whether a network belongs to the NEAR CAIP family.
 *
 * @param network - The network identifier
 * @returns True when network is one of the canonical NEAR network identifiers
 */
export function isNearNetwork(network: string): boolean {
  return (NEAR_NETWORKS as readonly string[]).includes(network);
}
