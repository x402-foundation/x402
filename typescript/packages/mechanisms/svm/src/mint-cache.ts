import { fetchMint } from "@solana-program/token-2022";
import type { Address } from "@solana/kit";

type Mint = Awaited<ReturnType<typeof fetchMint>>;

export type MintMetadata = {
  decimals: Mint["data"]["decimals"];
  programAddress: Mint["programAddress"];
};

export type MintMetadataCache = Map<string, Promise<MintMetadata>>;

/**
 * Gets stable SPL mint metadata from cache, fetching it once per network and mint.
 *
 * @param rpc - Solana RPC client
 * @param network - Payment requirements network
 * @param asset - SPL mint address
 * @param cache - Per-client mint metadata cache
 * @returns Cached mint metadata
 */
export async function getCachedMintMetadata(
  rpc: Parameters<typeof fetchMint>[0],
  network: string,
  asset: Address,
  cache: MintMetadataCache,
): Promise<MintMetadata> {
  const key = `${network}:${asset}`;
  let metadata = cache.get(key);

  if (!metadata) {
    metadata = fetchMint(rpc, asset).then(mint => ({
      decimals: mint.data.decimals,
      programAddress: mint.programAddress,
    }));
    cache.set(key, metadata);
  }

  try {
    return await metadata;
  } catch (error) {
    if (cache.get(key) === metadata) {
      cache.delete(key);
    }
    throw error;
  }
}
