import { getAddress } from "viem";
import { ErrAssetNotDeployedContract } from "./exact/facilitator/errors";
import type { FacilitatorEvmSigner } from "./signer";

/** Bounds how long a positive asset-contract check is reused. */
export const DEFAULT_ASSET_CONTRACT_CACHE_TTL_MS = 15 * 60 * 1000;

export const MAX_ASSET_CONTRACT_CACHE_ENTRIES = 4096;

export type AssetContractCacheKey = {
  network: string;
  asset: string;
};

type AssetContractCache = {
  ttl: number;
  expiries: Map<string, number>;
  isFresh(key: AssetContractCacheKey, now: number): boolean;
  record(key: AssetContractCacheKey, now: number): void;
};

const cacheKey = (key: AssetContractCacheKey): string => `${key.network}\0${key.asset}`;

const normalizeAsset = (asset: string): string => getAddress(asset).toLowerCase();

/**
 * Process-wide memo of "this asset address has bytecode" per network.
 * Only positive results are stored: a negative result may be a token observed mid-deployment,
 * which has to self-heal on the next request.
 */
export const globalAssetContractCache: AssetContractCache = {
  ttl: DEFAULT_ASSET_CONTRACT_CACHE_TTL_MS,
  // Node's event loop is single-threaded, so a plain Map is enough; Go needs RWMutex.
  expiries: new Map<string, number>(),

  isFresh(key: AssetContractCacheKey, now: number): boolean {
    // An empty network is never cached, since entries would otherwise collide
    // across chains where one address can hold bytecode on one chain and nothing
    // on another.
    if (key.network === "") {
      return false;
    }

    const expiry = this.expiries.get(cacheKey(key));
    return expiry !== undefined && now < expiry;
  },

  record(key: AssetContractCacheKey, now: number): void {
    if (key.network === "") {
      return;
    }

    for (const [existing, expiry] of this.expiries) {
      if (now > expiry) {
        this.expiries.delete(existing);
      }
    }

    const serialized = cacheKey(key);
    if (!this.expiries.has(serialized) && this.expiries.size >= MAX_ASSET_CONTRACT_CACHE_ENTRIES) {
      return;
    }
    this.expiries.set(serialized, now + this.ttl);
  },
};

/**
 * Clears the process-wide asset-contract cache, for tests that assert
 * on eth_getCode call counts across cases sharing an asset address.
 */
export function resetAssetContractCache(): void {
  globalAssetContractCache.expiries = new Map();
}

/**
 * Checks whether the payment asset is a deployed contract.
 * Returns {@link ErrAssetNotDeployedContract} for an EOA/empty address,
 * `""` for a deployed contract, or throws if eth_getCode itself fails.
 *
 * `network` identifies the chain the signer is bound to. It must be accurate, since it scopes the
 * cache that serves positive results; an empty network disables caching for the call. Only
 * {@link AssetContractCheck.await} populates that cache, so calling this directly always hits the RPC
 * on a miss.
 *
 * @param signer - Facilitator signer used to call eth_getCode on the asset.
 * @param network - CAIP-2 network id that scopes the cache; empty disables caching.
 * @param asset - Payment token address.
 * @returns An empty string when the asset is a contract, or {@link ErrAssetNotDeployedContract}.
 */
export async function validateAssetIsContract(
  signer: FacilitatorEvmSigner,
  network: string,
  asset: string,
): Promise<string> {
  const normalizedAsset = normalizeAsset(asset);
  if (globalAssetContractCache.isFresh({ network, asset: normalizedAsset }, Date.now())) {
    return "";
  }

  let code: `0x${string}` | undefined;
  try {
    code = await signer.getCode({ address: getAddress(asset) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to check whether asset is a contract: ${message}`);
  }

  if (!code || code === "0x") {
    return ErrAssetNotDeployedContract;
  }
  return "";
}

/**
 * An asset-contract check running in the background.
 */
export class AssetContractCheck {
  /**
   * Resolves with the check result. Reading this does not populate the cache;
   * only {@link await} does.
   */
  readonly results: Promise<string>;
  private readonly network: string;
  private readonly asset: string;

  /**
   * Starts {@link validateAssetIsContract} immediately. Cache recording waits for {@link AssetContractCheck.await}.
   *
   * @param signer - Facilitator signer used to call eth_getCode on the asset.
   * @param network - CAIP-2 network id that scopes the cache; empty disables caching.
   * @param asset - Payment token address.
   */
  constructor(signer: FacilitatorEvmSigner, network: string, asset: string) {
    this.network = network;
    this.asset = asset;
    this.results = validateAssetIsContract(signer, network, asset);
  }

  /**
   * Returns the check's result, caching a positive one for {@link DEFAULT_ASSET_CONTRACT_CACHE_TTL_MS}.
   * Recording on await rather than when the Promise settles keeps cache contents independent of
   * scheduling: a check abandoned by an early return cannot publish a result.
   *
   * @returns An empty string when the asset is a contract, or {@link ErrAssetNotDeployedContract}.
   */
  async await(): Promise<string> {
    const reason = await this.results;
    if (reason === "") {
      globalAssetContractCache.record(
        { network: this.network, asset: normalizeAsset(this.asset) },
        Date.now(),
      );
    }
    return reason;
  }
}

/**
 * Runs {@link validateAssetIsContract} in the background so callers can overlap
 * it with signature verification. The result is delivered by {@link AssetContractCheck.await}.
 *
 * @param signer - Facilitator signer used to call eth_getCode on the asset.
 * @param network - CAIP-2 network id that scopes the cache; empty disables caching.
 * @param asset - Payment token address.
 * @returns A check whose {@link AssetContractCheck.await} delivers the result.
 */
export function startAssetContractCheck(
  signer: FacilitatorEvmSigner,
  network: string,
  asset: string,
): AssetContractCheck {
  return new AssetContractCheck(signer, network, asset);
}
