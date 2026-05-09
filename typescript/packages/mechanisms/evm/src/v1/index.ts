export { ExactEvmSchemeV1 } from "../exact/v1";

export const EVM_NETWORK_CHAIN_ID_MAP = {
  ethereum: 1,
  sepolia: 11155111,
  abstract: 2741,
  "abstract-testnet": 11124,
  "base-sepolia": 84532,
  base: 8453,
  "avalanche-fuji": 43113,
  avalanche: 43114,
  iotex: 4689,
  sei: 1329,
  "sei-testnet": 1328,
  polygon: 137,
  "polygon-amoy": 80002,
  peaq: 3338,
  story: 1514,
  educhain: 41923,
  "skale-base-sepolia": 324705682,
  megaeth: 4326,
  monad: 143,
  stable: 988,
  "stable-testnet": 2201,
} as const;

export type EvmNetworkV1 = keyof typeof EVM_NETWORK_CHAIN_ID_MAP;

export const NETWORKS: string[] = Object.keys(EVM_NETWORK_CHAIN_ID_MAP);

/**
 * Extract chain ID from a v1 legacy network name.
 *
 * @param network - The v1 network name (e.g., "base-sepolia", "polygon")
 * @returns The numeric chain ID
 * @throws Error if the network name is not a known v1 network
 */
export function getEvmChainIdV1(network: string): number {
  const chainId = EVM_NETWORK_CHAIN_ID_MAP[network as EvmNetworkV1];
  if (!chainId) {
    throw new Error(`Unsupported v1 network: ${network}`);
  }
  return chainId;
}
