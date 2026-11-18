import { describe, it, expect, beforeEach } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { FacilitatorEvmSigner } from "../../src/signer";
import { verifyEIP3009 } from "../../src/exact/facilitator/eip3009";
import {
  ErrAssetNotDeployedContract,
  ErrInvalidSignature,
  ErrPermit2InvalidSpender,
} from "../../src/exact/facilitator/errors";
import { verifyPermit2 } from "../../src/exact/facilitator/permit2";
import { verifyUptoPermit2 } from "../../src/upto/facilitator/permit2";
import { x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from "../../src/constants";
import type { ExactEIP3009Payload, ExactPermit2Payload, UptoPermit2Payload } from "../../src/types";
import {
  DEFAULT_ASSET_CONTRACT_CACHE_TTL_MS,
  MAX_ASSET_CONTRACT_CACHE_ENTRIES,
  globalAssetContractCache,
  resetAssetContractCache,
  startAssetContractCheck,
  validateAssetIsContract,
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

  it("wraps eth_getCode failures", async () => {
    const signer: FacilitatorEvmSigner = {
      getAddresses: () => [],
      readContract: async () => 0n,
      verifyTypedData: async () => false,
      writeContract: async () => "0x",
      sendTransaction: async () => "0x",
      waitForTransactionReceipt: async () => ({ status: "success" }),
      getCode: async () => {
        throw "rpc down";
      },
    };

    await expect(validateAssetIsContract(signer, "eip155:84532", cacheTestAsset)).rejects.toThrow(
      "failed to check whether asset is a contract: rpc down",
    );
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

const PAYER = "0xabcA8d06A3925a6C06D142788a1A90ae431ccB00" as const;
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const FACILITATOR = "0xFAC11174700123456789012345678901234aBCDe" as const;
const ASSET_RPC_FAILURE = "HTTP request failed.";
const ASSET_CHECK_FAILURE = `failed to check whether asset is a contract: ${ASSET_RPC_FAILURE}`;
const LOW_S_SIGNATURE = `0x${"11".repeat(32)}${"00".repeat(31)}011b` as `0x${string}`;

type CodeGate = {
  promise: Promise<`0x${string}`>;
  resolve: (value: `0x${string}`) => void;
  reject: (reason: unknown) => void;
};

function codeGate(): CodeGate {
  let resolve: (value: `0x${string}`) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<`0x${string}`>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

function requirements(scheme: "exact" | "upto"): PaymentRequirements {
  return {
    scheme,
    network: "eip155:84532",
    asset: cacheTestAsset,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USDC",
      version: "2",
      assetTransferMethod: scheme === "exact" ? "eip3009" : "permit2",
    },
  };
}

function payment(req: PaymentRequirements): PaymentPayload {
  return { x402Version: 2, accepted: req, payload: {} };
}

function eip3009Payload(): ExactEIP3009Payload {
  return {
    signature: LOW_S_SIGNATURE,
    authorization: {
      from: PAYER,
      to: PAY_TO,
      value: "10000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"11".repeat(32)}`,
    },
  };
}

function exactPermit2(spender: `0x${string}`): ExactPermit2Payload {
  return {
    signature: LOW_S_SIGNATURE,
    permit2Authorization: {
      from: PAYER,
      permitted: { token: cacheTestAsset, amount: "10000" },
      spender,
      nonce: "1",
      deadline: "9999999999",
      witness: { to: PAY_TO, validAfter: "0" },
    },
  };
}

function uptoPermit2(spender: `0x${string}`): UptoPermit2Payload {
  return {
    signature: LOW_S_SIGNATURE,
    permit2Authorization: {
      from: PAYER,
      permitted: { token: cacheTestAsset, amount: "10000" },
      spender,
      nonce: "1",
      deadline: "9999999999",
      witness: { to: PAY_TO, facilitator: FACILITATOR, validAfter: "0" },
    },
  };
}

function openCodeSigner(): { signer: FacilitatorEvmSigner; asset: CodeGate; payer: CodeGate } {
  const asset = codeGate();
  const payer = codeGate();
  const signer: FacilitatorEvmSigner = {
    getAddresses: () => [FACILITATOR],
    readContract: async () => 0n,
    verifyTypedData: async () => false,
    writeContract: async () => "0x",
    sendTransaction: async () => "0x",
    waitForTransactionReceipt: async () => ({ status: "success" }),
    getCode: ({ address }) => {
      if (address.toLowerCase() === cacheTestAsset.toLowerCase()) return asset.promise;
      if (address.toLowerCase() === PAYER.toLowerCase()) return payer.promise;
      return Promise.resolve("0x");
    },
  };
  return { signer, asset, payer };
}

function failAssetLookup(asset: CodeGate): void {
  asset.reject(new Error(ASSET_RPC_FAILURE));
}

describe("failed asset-contract checks", () => {
  beforeEach(() => {
    resetAssetContractCache();
  });

  async function expectNoUnhandledRejection(
    gates: { asset: CodeGate; payer: CodeGate },
    run: () => Promise<void>,
  ): Promise<void> {
    const reasons: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      reasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await run();
      await nextTurn();
      expect(reasons).toEqual([]);
    } finally {
      gates.payer.resolve("0x");
      failAssetLookup(gates.asset);
      await nextTurn();
      process.off("unhandledRejection", onUnhandled);
    }
  }

  it("verifyEIP3009 returns an invalid signature when the asset lookup rejects after verify returns", async () => {
    const { signer, asset, payer } = openCodeSigner();
    const req = requirements("exact");
    const pending = verifyEIP3009(signer, payment(req), req, eip3009Payload());

    await expectNoUnhandledRejection({ asset, payer }, async () => {
      payer.resolve("0x");
      const { response } = await pending;
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: ErrInvalidSignature,
        payer: PAYER,
      });
      failAssetLookup(asset);
      await nextTurn();
    });
  });

  it("verifyEIP3009 does not leak the asset lookup when it fails before the payer lookup resolves", async () => {
    const { signer, asset, payer } = openCodeSigner();
    const req = requirements("exact");
    const pending = verifyEIP3009(signer, payment(req), req, eip3009Payload());

    await expectNoUnhandledRejection({ asset, payer }, async () => {
      failAssetLookup(asset);
      await nextTurn();
      payer.resolve("0x");
      const { response } = await pending;
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: ErrInvalidSignature,
        payer: PAYER,
      });
    });
  });

  it("verifyPermit2 returns an invalid spender when the asset lookup rejects after verify returns", async () => {
    const { signer, asset, payer } = openCodeSigner();
    const req = requirements("exact");
    const wrongSpender = "0x0000000000000000000000000000000000000001" as const;
    const pending = verifyPermit2(signer, payment(req), req, exactPermit2(wrongSpender));

    await expectNoUnhandledRejection({ asset, payer }, async () => {
      await expect(pending).resolves.toMatchObject({
        isValid: false,
        invalidReason: ErrPermit2InvalidSpender,
        payer: PAYER,
      });
      failAssetLookup(asset);
      await nextTurn();
    });
  });

  it("verifyPermit2 still rejects when the asset lookup fails during the signature check", async () => {
    const { signer, asset, payer } = openCodeSigner();
    const req = requirements("exact");
    const pending = verifyPermit2(
      signer,
      payment(req),
      req,
      exactPermit2(x402ExactPermit2ProxyAddress),
    );

    await expectNoUnhandledRejection({ asset, payer }, async () => {
      failAssetLookup(asset);
      await nextTurn();
      payer.resolve("0x");
      await expect(pending).rejects.toThrow(ASSET_CHECK_FAILURE);
    });
  });

  it("verifyUptoPermit2 returns an invalid spender when the asset lookup rejects after verify returns", async () => {
    const { signer, asset, payer } = openCodeSigner();
    const req = requirements("upto");
    const wrongSpender = "0x0000000000000000000000000000000000000001" as const;
    const pending = verifyUptoPermit2(signer, payment(req), req, uptoPermit2(wrongSpender));

    await expectNoUnhandledRejection({ asset, payer }, async () => {
      await expect(pending).resolves.toMatchObject({
        isValid: false,
        invalidReason: ErrPermit2InvalidSpender,
        payer: PAYER,
      });
      failAssetLookup(asset);
      await nextTurn();
    });
  });

  it("verifyUptoPermit2 still rejects when the asset lookup fails during the signature check", async () => {
    const { signer, asset, payer } = openCodeSigner();
    const req = requirements("upto");
    const pending = verifyUptoPermit2(
      signer,
      payment(req),
      req,
      uptoPermit2(x402UptoPermit2ProxyAddress),
    );

    await expectNoUnhandledRejection({ asset, payer }, async () => {
      failAssetLookup(asset);
      await nextTurn();
      payer.resolve("0x");
      await expect(pending).rejects.toThrow(ASSET_CHECK_FAILURE);
    });
  });
});
