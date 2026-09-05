import { describe, it, expect, beforeEach } from "vitest";
import type { FacilitatorEvmSigner } from "../../src/signer";
import { ErrAssetNotDeployedContract } from "../../src/exact/facilitator/errors";
import {
  DEFAULT_ASSET_CONTRACT_CACHE_TTL_MS,
  MAX_ASSET_CONTRACT_CACHE_ENTRIES,
  globalAssetContractCache,
  resetAssetContractCache,
  startAssetContractCheck,
  type AssetContractCacheKey,
} from "../../src/assetCache";

const cacheTestAsset = "0x00000000000000000000000000000000000000bb";

function countingCodeSigner(): { signer: FacilitatorEvmSigner; calls: { count: number } } {
  const calls = { count: 0 };
  const signer: FacilitatorEvmSigner = {
    getAddresses: () => [],
    readContract: async () => 0n,
    verifyTypedData: async () => false,
    writeContract: async () => "0x",
    sendTransaction: async () => "0x",
    waitForTransactionReceipt: async () => ({ status: "success" }),
    getCode: async () => {
      calls.count += 1;
      return "0x6060";
    },
  };
  return { signer, calls };
}

describe("asset contract cache", () => {
  beforeEach(() => {
    resetAssetContractCache();
  });

  it("caches a positive result so only the first check reaches the RPC", async () => {
    const { signer, calls } = countingCodeSigner();
    for (let i = 0; i < 3; i++) {
      const reason = await startAssetContractCheck(signer, "eip155:84532", cacheTestAsset).await();
      expect(reason).toBe("");
    }

    expect(calls.count).toBe(1);
  });

  it("does not cache when the caller never awaits", async () => {
    const { signer, calls } = countingCodeSigner();
    const abandoned = startAssetContractCheck(signer, "eip155:84532", cacheTestAsset);
    await abandoned.results;

    const reason = await startAssetContractCheck(signer, "eip155:84532", cacheTestAsset).await();
    expect(reason).toBe("");
    expect(calls.count).toBe(2);
  });

  it("does not cache a negative result so a later deploy is visible", async () => {
    let code: `0x${string}` = "0x";
    const calls = { count: 0 };
    const signer: FacilitatorEvmSigner = {
      getAddresses: () => [],
      readContract: async () => 0n,
      verifyTypedData: async () => false,
      writeContract: async () => "0x",
      sendTransaction: async () => "0x",
      waitForTransactionReceipt: async () => ({ status: "success" }),
      getCode: async () => {
        calls.count += 1;
        return code;
      },
    };

    const first = await startAssetContractCheck(signer, "eip155:84532", cacheTestAsset).await();
    expect(first).toBe(ErrAssetNotDeployedContract);
    expect(calls.count).toBe(1);

    code = "0x6060";
    const second = await startAssetContractCheck(signer, "eip155:84532", cacheTestAsset).await();
    expect(second).toBe("");
    expect(calls.count).toBe(2);

    const third = await startAssetContractCheck(signer, "eip155:84532", cacheTestAsset).await();
    expect(third).toBe("");
    expect(calls.count).toBe(2);
  });

  it("skips the cache when the network is empty", async () => {
    const { signer, calls } = countingCodeSigner();
    for (let i = 0; i < 2; i++) {
      await startAssetContractCheck(signer, "", cacheTestAsset).await();
    }

    expect(calls.count).toBe(2);
    expect(
      globalAssetContractCache.isFresh({ network: "", asset: cacheTestAsset }, Date.now()),
    ).toBe(false);
  });

  it("expires entries after the TTL", () => {
    const key: AssetContractCacheKey = { network: "eip155:84532", asset: cacheTestAsset };
    const start = Date.now();
    globalAssetContractCache.record(key, start);

    expect(
      globalAssetContractCache.isFresh(key, start + DEFAULT_ASSET_CONTRACT_CACHE_TTL_MS - 1000),
    ).toBe(true);
    expect(
      globalAssetContractCache.isFresh(key, start + DEFAULT_ASSET_CONTRACT_CACHE_TTL_MS + 1000),
    ).toBe(false);
  });

  it("is bounded so many distinct deployed contracts cannot grow it without limit", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_ASSET_CONTRACT_CACHE_ENTRIES + 500; i++) {
      globalAssetContractCache.record(
        { network: "eip155:84532", asset: `0x${i.toString(16).padStart(40, "0")}` },
        now,
      );
    }

    expect(globalAssetContractCache.expiries.size).toBeLessThanOrEqual(
      MAX_ASSET_CONTRACT_CACHE_ENTRIES,
    );
  });
});
