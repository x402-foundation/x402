import { JsonRpcProvider } from "@near-js/providers";
import { NEAR_RPC_URLS, isNearNetwork } from "../constants";

/**
 * Optional per-network RPC URL overrides, keyed by CAIP network id.
 */
export type RpcUrlOverrides = Partial<Record<string, string>>;

/**
 * Builds a memoized `network -> JsonRpcProvider` factory.
 *
 * Reads pin final finality at the call sites; this only resolves endpoints.
 *
 * @param overrides - Optional per-network endpoint overrides.
 * @returns A function returning a cached provider for a NEAR network.
 */
export function createProviderFactory(
  overrides?: RpcUrlOverrides,
): (network: string) => JsonRpcProvider {
  const cache = new Map<string, JsonRpcProvider>();

  return (network: string): JsonRpcProvider => {
    if (!isNearNetwork(network)) {
      throw new Error(`Unsupported NEAR network: ${network}`);
    }
    const existing = cache.get(network);
    if (existing) {
      return existing;
    }
    const url = overrides?.[network] ?? NEAR_RPC_URLS[network as keyof typeof NEAR_RPC_URLS];
    if (!url) {
      throw new Error(`No RPC URL configured for network: ${network}`);
    }
    const provider = new JsonRpcProvider({ url });
    cache.set(network, provider);
    return provider;
  };
}
