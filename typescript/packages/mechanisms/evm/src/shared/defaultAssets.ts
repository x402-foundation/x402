import type { Network } from "@x402/core/types";

/**
 * Base stablecoin asset configuration shared across all EVM payment schemes.
 * Contains the core fields needed to identify and convert tokens.
 */
export type DefaultAssetInfo = {
  /** Token contract address */
  address: string;
  /** EIP-712 domain name (must match the token's domain separator) */
  name: string;
  /** EIP-712 domain version (must match the token's domain separator) */
  version: string;
  /** Token decimal places (typically 6 for USDC) */
  decimals: number;
};

/**
 * Extended asset configuration for the exact scheme.
 * Includes transfer method hints that control client-side behaviour.
 */
export type ExactDefaultAssetInfo = DefaultAssetInfo & {
  /**
   * Transfer method override: `"permit2"` for tokens that don't support EIP-3009.
   * Omit for EIP-3009 tokens (default behaviour).
   */
  assetTransferMethod?: string;
  /**
   * Set to `true` for permit2 tokens that implement EIP-2612 `permit()`.
   * Controls whether name/version are included in `extra` so the client can
   * sign a gasless EIP-2612 permit for Permit2 approval.
   */
  supportsEip2612?: boolean;
};

/**
 * Default stablecoins indexed by CAIP-2 network identifier.
 *
 * Each network has the right to determine its own default stablecoin that can
 * be expressed as a USD string by calling servers. See DEFAULT_ASSET.md in
 * exact/server/ for how to add new chains.
 */
export const DEFAULT_STABLECOINS: Record<string, ExactDefaultAssetInfo> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  }, // Base mainnet USDC
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
    decimals: 6,
  }, // Base Sepolia USDC
  "eip155:4326": {
    address: "0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7",
    name: "MegaUSD",
    version: "1",
    decimals: 18,
    assetTransferMethod: "permit2",
    supportsEip2612: true,
  }, // MegaETH mainnet MegaUSD (no EIP-3009, supports EIP-2612)
  "eip155:143": {
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  }, // Monad mainnet USDC
  "eip155:137": {
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  }, // Polygon mainnet USDC
  "eip155:42161": {
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  }, // Arbitrum One USDC
  "eip155:421614": {
    address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  }, // Arbitrum Sepolia USDC
};

/**
 * Look up the default stablecoin for a network.
 *
 * @param network - CAIP-2 network identifier (e.g. "eip155:8453")
 * @returns The default asset info
 * @throws If no default asset is configured for the network
 */
export function getDefaultAsset(network: Network): ExactDefaultAssetInfo {
  const info = DEFAULT_STABLECOINS[network];
  if (!info) {
    throw new Error(`No default asset configured for network ${network}`);
  }
  return info;
}
