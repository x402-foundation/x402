import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { buildOpenPaymentChannelTransaction } from "../../src/payment-channels/open";
import {
  assertBindingSource,
  assertDelegatedReceiverAuth,
  isDelegatedAuthorizer,
  readReceiverAuthorizer,
  resolveDelegatedIdentity,
} from "../../src/batch-settlement/facilitator/bindingSource";
import { InMemoryBatchDelegatedAuthStore } from "../../src/batch-settlement/facilitator/delegatedAuthStore";
import {
  BatchReceiverAuthorizerConflictError,
  InMemoryBatchReceiverAuthorizerStore,
} from "../../src/batch-settlement/facilitator/receiverAuthorizerStore";
import type { BatchReceiverBindingHistoryReader } from "../../src/batch-settlement/facilitator/types";
import { BatchError } from "../../src/batch-settlement/errors";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import {
  encodeReceiverBindingMemo,
  readReceiverBindingFromOpen,
} from "../../src/batch-settlement/receiverBinding";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let server: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  server = await generateKeyPairSigner();
});

function openArgs(overrides: { bindingMemo?: string; memo?: string } = {}) {
  return {
    authorizedSigner: payer.address,
    bindingMemo: encodeReceiverBindingMemo(server.address),
    blockhash: { blockhash: RECEIVER, lastValidBlockHeight: 1n },
    deposit: 10_000n,
    feePayer: feePayer.address,
    gracePeriod: 900,
    mint: MINT,
    openSlot: 123n,
    payee: feePayer.address,
    payer,
    recipients: [{ bps: 10_000, recipient: RECEIVER }],
    salt: 0n,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  };
}

function signer() {
  return {
    getAccountInfo: vi.fn(),
    getAddresses: () => [feePayer.address],
    getLatestBlockhash: vi.fn(),
    getSigner: () => feePayer,
    getSlot: vi.fn(),
  };
}

describe("readReceiverBindingFromOpen", () => {
  it("reads the single binding memo on the channel's open", async () => {
    const open = await buildOpenPaymentChannelTransaction(openArgs());
    expect(readReceiverBindingFromOpen(open.transaction, open.channelId)).toBe(server.address);
    expect(readReceiverBindingFromOpen(open.transaction, payer.address)).toBeUndefined();
    expect(readReceiverBindingFromOpen("not-a-transaction", open.channelId)).toBeUndefined();
  });

  it("returns undefined when the open has no binding memo or more than one", async () => {
    const missing = await buildOpenPaymentChannelTransaction(openArgs({ bindingMemo: undefined }));
    expect(readReceiverBindingFromOpen(missing.transaction, missing.channelId)).toBeUndefined();
    const doubled = await buildOpenPaymentChannelTransaction(
      openArgs({ memo: encodeReceiverBindingMemo(payer.address) }),
    );
    expect(readReceiverBindingFromOpen(doubled.transaction, doubled.channelId)).toBeUndefined();
  });
});

describe("batch-settlement binding source", () => {
  it("rejects a facilitator with neither a store nor a history reader", () => {
    expect(() => new BatchSvmScheme(signer() as never)).toThrow(/receiverAuthorizerStore/);
    expect(
      () =>
        new BatchSvmScheme({
          ...signer(),
          getSignaturesForAddress: vi.fn(),
          getTransaction: vi.fn(),
        } as never),
    ).toThrow(/receiverAuthorizerStore/);
    expect(
      () =>
        new BatchSvmScheme(signer() as never, {
          receiverBindingHistoryReader: {
            getSignaturesForAddress: vi.fn(),
          } as unknown as BatchReceiverBindingHistoryReader,
        }),
    ).toThrow(/getTransaction/);
  });

  it("resolves an open from history, skips a failed transaction, and writes the store back", async () => {
    const open = await buildOpenPaymentChannelTransaction(openArgs());
    const store = new InMemoryBatchReceiverAuthorizerStore();
    const fetched: string[] = [];
    const historyReader: BatchReceiverBindingHistoryReader = {
      getSignaturesForAddress: async (_network, _address, options) => {
        if (options?.before === undefined) {
          return [
            ...Array.from({ length: 999 }, (_, index) => ({
              err: { InstructionError: [0, "Custom"] },
              signature: `failed-${index}`,
            })),
            { err: null, signature: "not-the-open" },
          ];
        }
        expect(options.before).toBe("not-the-open");
        return [{ err: null, signature: "the-open" }];
      },
      getTransaction: async (_network, signature) => {
        fetched.push(signature);
        if (signature === "not-the-open") return missingMemo();
        return open.transaction;
      },
    };
    await expect(
      readReceiverAuthorizer(store, historyReader, NETWORK, open.channelId),
    ).resolves.toBe(server.address);
    expect(fetched).toEqual(["the-open"]);
    expect((await store.get(NETWORK, open.channelId))?.receiverAuthorizer).toBe(server.address);
  });

  it("does not write a store row when the open has no single binding memo", async () => {
    const missing = await buildOpenPaymentChannelTransaction(openArgs({ bindingMemo: undefined }));
    const doubled = await buildOpenPaymentChannelTransaction(
      openArgs({ memo: encodeReceiverBindingMemo(payer.address) }),
    );
    let wire = missing.transaction;
    const store = new InMemoryBatchReceiverAuthorizerStore();
    const historyReader: BatchReceiverBindingHistoryReader = {
      getSignaturesForAddress: async () => [{ err: null, signature: "only" }],
      getTransaction: async () => wire,
    };

    await expect(
      readReceiverAuthorizer(store, historyReader, NETWORK, missing.channelId),
    ).resolves.toBeUndefined();
    wire = doubled.transaction;
    await expect(
      readReceiverAuthorizer(store, historyReader, NETWORK, doubled.channelId),
    ).resolves.toBeUndefined();
    expect(await store.get(NETWORK, missing.channelId)).toBeUndefined();
    expect(await store.get(NETWORK, doubled.channelId)).toBeUndefined();
  });

  it("returns a store hit without consulting history", async () => {
    const store = new InMemoryBatchReceiverAuthorizerStore();
    const channelId = "stored-channel";
    await store.bind({ channelId, network: NETWORK, receiverAuthorizer: server.address });
    const historyReader: BatchReceiverBindingHistoryReader = {
      getSignaturesForAddress: vi.fn(async () => {
        throw new Error("history should not run");
      }),
      getTransaction: vi.fn(),
    };

    await expect(readReceiverAuthorizer(store, historyReader, NETWORK, channelId)).resolves.toBe(
      server.address,
    );
    expect(historyReader.getSignaturesForAddress).not.toHaveBeenCalled();
  });

  it("maps a write-back conflict to RECEIVER_AUTHORIZER_MISMATCH and rethrows other bind errors", async () => {
    const open = await buildOpenPaymentChannelTransaction(openArgs());
    const historyReader: BatchReceiverBindingHistoryReader = {
      getSignaturesForAddress: async () => [{ err: null, signature: "open" }],
      getTransaction: async () => open.transaction,
    };
    const conflictStore = {
      bind: vi.fn(async () => {
        throw new BatchReceiverAuthorizerConflictError();
      }),
      delete: vi.fn(),
      get: vi.fn(async () => undefined),
    };
    await expect(
      readReceiverAuthorizer(conflictStore, historyReader, NETWORK, open.channelId),
    ).rejects.toThrow(BatchError.RECEIVER_AUTHORIZER_MISMATCH);

    const failingStore = {
      bind: vi.fn(async () => {
        throw new Error("disk full");
      }),
      delete: vi.fn(),
      get: vi.fn(async () => undefined),
    };
    await expect(
      readReceiverAuthorizer(failingStore, historyReader, NETWORK, open.channelId),
    ).rejects.toThrow(/disk full/);
  });

  it("validates binding-source and delegated-auth configuration", () => {
    expect(assertDelegatedReceiverAuth(undefined)).toBeUndefined();
    const identityStore = new InMemoryBatchDelegatedAuthStore();
    const delegated = {
      identityStore,
      receiverAuthorizer: server.address,
      resolveCallerIdentity: async () => "caller",
    };
    expect(assertDelegatedReceiverAuth(delegated)).toBe(delegated);

    expect(() =>
      assertDelegatedReceiverAuth({
        ...delegated,
        receiverAuthorizer: "not-a-key",
      }),
    ).toThrow(/receiverAuthorizer address/);
    expect(() =>
      assertDelegatedReceiverAuth({
        ...delegated,
        identityStore: { bind: vi.fn() } as never,
      }),
    ).toThrow(/identityStore must implement/);

    expect(() =>
      assertBindingSource({
        receiverAuthorizerStore: { bind: vi.fn() } as never,
      }),
    ).toThrow(/receiverAuthorizerStore must implement/);
    expect(() =>
      assertBindingSource({
        receiverBindingHistoryReader: { getSignaturesForAddress: vi.fn() } as never,
      }),
    ).toThrow(/receiverBindingHistoryReader must implement/);
  });

  it("resolves delegated identity and recognizes the delegated authorizer key", async () => {
    const delegated = {
      identityStore: new InMemoryBatchDelegatedAuthStore(),
      receiverAuthorizer: server.address,
      resolveCallerIdentity: vi.fn(),
    };
    delegated.resolveCallerIdentity.mockResolvedValueOnce("caller-a");
    await expect(
      resolveDelegatedIdentity(delegated, {
        channelId: "ch",
        network: NETWORK,
        payer: payer.address,
        step: "deposit",
      }),
    ).resolves.toBe("caller-a");

    delegated.resolveCallerIdentity.mockRejectedValueOnce(new Error("auth down"));
    await expect(
      resolveDelegatedIdentity(delegated, {
        channelId: "ch",
        network: NETWORK,
        payer: payer.address,
        step: "seal",
      }),
    ).resolves.toBeUndefined();

    delegated.resolveCallerIdentity.mockResolvedValueOnce("");
    await expect(
      resolveDelegatedIdentity(delegated, {
        channelId: "ch",
        network: NETWORK,
        payer: payer.address,
        step: "refund",
      }),
    ).resolves.toBeUndefined();

    expect(isDelegatedAuthorizer(delegated, server.address)).toBe(true);
    expect(isDelegatedAuthorizer(delegated, payer.address)).toBe(false);
    expect(isDelegatedAuthorizer(undefined, server.address)).toBe(false);
  });
});

function missingMemo(): Promise<string> {
  return buildOpenPaymentChannelTransaction(openArgs({ bindingMemo: undefined })).then(
    open => open.transaction,
  );
}
