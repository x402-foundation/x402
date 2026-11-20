import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { BatchError } from "../../src/batch-settlement/errors";
import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import type { ChannelState } from "../../src/batch-settlement/server/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const RECEIVER = USDC_MAINNET_ADDRESS;
const receiverAuthorizer = await generateKeyPairSigner();
function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: {
      feePayer: RECEIVER,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: RECEIVER,
    scheme: "batch-settlement",
  };
}

function channel(id: string, overrides: Partial<ChannelState> = {}): ChannelState {
  return {
    channelConfig: {
      openSlot: 1,
      payer: USDC_DEVNET_ADDRESS,
      payerAuthorizer: USDC_DEVNET_ADDRESS,
      receiver: RECEIVER,
      salt: "0",
      token: USDC_DEVNET_ADDRESS,
      withdrawDelay: 900,
    },
    channelId: id,
    chargedCumulativeAmount: 3_000n,
    deposit: 10_000n,
    feePayer: RECEIVER,
    highestVoucherExpiresAt: 0,
    highestVoucherSignature: `sig-${id}`,
    mint: USDC_DEVNET_ADDRESS,
    openSlot: 1n,
    payer: USDC_DEVNET_ADDRESS,
    payerAuthorizer: USDC_DEVNET_ADDRESS,
    payoutWatermark: 0n,
    receiver: RECEIVER,
    salt: 0n,
    settled: 0n,
    signedMaxClaimable: 3_000n,
    status: "open",
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
    ...overrides,
  };
}

type RedemptionPayload = {
  type: string;
  claims?: { voucher: { channelId: string; maxClaimableAmount: string } }[];
  channels?: { channelId: string; payoutWatermark: string; settled: string }[];
};

/** Records what the worker submitted, answering however the test asks. */
function recorder(answer: (payload: RedemptionPayload) => SettleResponse = recovered) {
  const submitted: { type: string; channels: string[] }[] = [];
  const settle = async (payload: { payload: unknown }): Promise<SettleResponse> => {
    const raw = payload.payload as RedemptionPayload;
    submitted.push({
      channels: (raw.claims ?? [])
        .map(c => c.voucher.channelId)
        .concat((raw.channels ?? []).map(c => c.channelId)),
      type: raw.type,
    });
    return answer(raw);
  };
  return { settle, submitted };
}

function ok(): SettleResponse {
  return { network: SOLANA_DEVNET_CAIP2, success: true, transaction: "sig" };
}

function recovered(payload: RedemptionPayload): SettleResponse {
  return {
    ...ok(),
    extra:
      payload.type === "claim"
        ? {
            accepts: (payload.claims ?? []).map(({ voucher }) => ({
              channelId: voucher.channelId,
              totalClaimed: voucher.maxClaimableAmount,
            })),
          }
        : {
            channels: (payload.channels ?? []).map(channel => channel.channelId),
          },
  };
}

describe("batch-settlement redemption worker", () => {
  it("does not mark a newer claim paid when a retry recovers an older sweep", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", { settled: 3000n, payoutWatermark: 1000n }));
    const { settle } = recorder();
    const options = {
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    };
    const result = await new BatchChannelManager({
      ...options,
      readPayoutWatermark: async () => 1000n,
    }).redeem();
    expect(result.distributed).toEqual([]);
    expect((await store.get("chan-a"))?.payoutWatermark).toBe(1000n);
    // A recreated manager retries the unpaid balance and observes the real advance.
    const recovered = await new BatchChannelManager({
      ...options,
      readPayoutWatermark: async () => 3000n,
    }).redeem();
    expect(recovered.distributed).toEqual(["chan-a"]);
  });

  it("keeps payout work after an unavailable or missing account read", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", { settled: 3000n }));
    const { settle } = recorder();
    for (const reader of [
      async () => undefined,
      async () => {
        throw new Error("RPC unavailable");
      },
    ]) {
      await new BatchChannelManager({
        receiverAuthorizer,
        requirements: requirements(),
        settle,
        store,
        readPayoutWatermark: reader,
      }).redeem();
      expect((await store.get("chan-a"))?.payoutWatermark).toBe(0n);
    }
  });
  it("claims unclaimed vouchers, then distributes what they settled", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    // Already claimed to 3000 but never paid out.
    await store.put(channel("chan-b", { settled: 3_000n }));
    // Nothing owed: claimed and distributed.
    await store.put(channel("chan-c", { payoutWatermark: 3_000n, settled: 3_000n }));
    const { settle, submitted } = recorder();

    const manager = new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    });
    const result = await manager.redeem();

    // chan-a has a voucher above its watermark; the others do not.
    expect(result.claimed).toEqual(["chan-a"]);
    // chan-a's claim and chan-b's backlog both need paying out.
    expect(result.distributed.sort()).toEqual(["chan-a", "chan-b"]);
    expect(submitted.map(s => s.type)).toEqual(["claim", "settle"]);

    // The store now reflects what landed, so the next pass does nothing.
    expect((await store.get("chan-a"))?.settled).toBe(3_000n);
    expect((await store.get("chan-a"))?.payoutWatermark).toBe(3_000n);
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [], sealed: [] });
  });

  it("packs no more than four channels into one claim", async () => {
    const store = new MemoryChannelStore();
    for (let index = 0; index < 9; index += 1) {
      await store.put(channel(`chan-${index}`));
    }
    const { settle, submitted } = recorder();
    const manager = new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    });

    const result = await manager.redeem();
    expect(result.claimed).toHaveLength(9);
    const claims = submitted.filter(s => s.type === "claim");
    // Nine channels, four per transaction: 4 + 4 + 1, and none dropped.
    expect(claims.map(c => c.channels.length)).toEqual([4, 4, 1]);
    expect(claims.flatMap(c => c.channels).sort()).toEqual(
      Array.from({ length: 9 }, (_, i) => `chan-${i}`).sort(),
    );
  });

  it("leaves a failed batch for the next pass instead of recording it", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const errors: unknown[] = [];
    const { settle } = recorder(payload =>
      payload.type === "claim"
        ? {
            errorReason: "settlement_pending",
            network: SOLANA_DEVNET_CAIP2,
            success: false,
            transaction: "",
          }
        : recovered(payload),
    );
    const manager = new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      onError: error => errors.push(error),
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    });

    const result = await manager.redeem();
    expect(result.claimed).toEqual([]);
    expect(errors).toHaveLength(1);
    // The watermark is untouched, so the voucher is still there to claim.
    expect((await store.get("chan-a"))?.settled).toBe(0n);
  });

  it("repairs merchant state and finishes payout after a lost response and restart", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const pending = recorder(payload =>
      payload.type === "claim"
        ? {
            errorReason: "settlement_pending",
            network: SOLANA_DEVNET_CAIP2,
            success: false,
            transaction: "claim-tx",
          }
        : recovered(payload),
    );
    await new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: pending.settle,
      store,
    }).redeem();
    expect((await store.get("chan-a"))?.settled).toBe(0n);

    const retry = recorder();
    const result = await new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: retry.settle,
      store,
    }).redeem();
    expect(result).toEqual({ claimed: ["chan-a"], distributed: ["chan-a"], sealed: [] });
    expect((await store.get("chan-a"))?.settled).toBe(3_000n);
    expect((await store.get("chan-a"))?.payoutWatermark).toBe(3_000n);
  });

  it("does not advance local state from an unbound success response", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const errors: unknown[] = [];
    const { settle } = recorder(() => ok());
    const result = await new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      onError: error => errors.push(error),
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    }).redeem();

    expect(result).toEqual({ claimed: [], distributed: [], sealed: [] });
    expect((await store.get("chan-a"))?.settled).toBe(0n);
    expect(errors).toHaveLength(1);
  });

  it("stop with flush runs one final redeem pass", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const { settle, submitted } = recorder();
    const manager = new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    });
    manager.start(3600);
    await manager.stop({ flush: true });
    expect(submitted.map(entry => entry.type)).toEqual(["claim", "settle"]);
  });

  it("uses empty transaction in lifecycle callbacks when the facilitator omits it", async () => {
    const onClaim = vi.fn();
    const onSettle = vi.fn();
    const onSeal = vi.fn();
    const noTx = (payload: RedemptionPayload): SettleResponse => {
      const { transaction: _tx, ...rest } = recovered(payload);
      void _tx;
      return rest;
    };
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    await new BatchChannelManager({
      onClaim,
      onSettle,
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: recorder(noTx).settle,
      store,
    }).redeem();
    expect(onClaim).toHaveBeenCalledWith({ transaction: "", vouchers: 1 });
    expect(onSettle).toHaveBeenCalledWith({ transaction: "" });

    const id = (await generateKeyPairSigner()).address;
    await store.put(channel(id, { status: "closing" }));
    await new BatchChannelManager({
      onSeal,
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: recorder(noTx).settle,
      store,
    }).redeem();
    expect(onSeal).toHaveBeenCalledWith({ channel: id, transaction: "" });
  });

  it("fires onClaim, onSettle, and onSeal with facilitator transaction signatures", async () => {
    const onClaim = vi.fn();
    const onSettle = vi.fn();
    const onSeal = vi.fn();
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    await new BatchChannelManager({
      onClaim,
      onSettle,
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: recorder().settle,
      store,
    }).redeem();
    expect(onClaim).toHaveBeenCalledWith({ transaction: "sig", vouchers: 1 });
    expect(onSettle).toHaveBeenCalledWith({ transaction: "sig" });

    const id = (await generateKeyPairSigner()).address;
    await store.put(channel(id, { status: "closing" }));
    await new BatchChannelManager({
      onSeal,
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: recorder().settle,
      store,
    }).redeem();
    expect(onSeal).toHaveBeenCalledWith({ channel: id, transaction: "sig" });
  });

  it("seals a closing channel instead of claiming it", async () => {
    const store = new MemoryChannelStore();
    const id = (await generateKeyPairSigner()).address;
    await store.put(channel(id, { status: "closing" }));
    const { settle, submitted } = recorder();
    const manager = new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    });
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [], sealed: [id] });
    expect(submitted.map(s => s.type)).toEqual(["seal"]);
    expect((await store.get(id))?.status).toBe("distributed");
  });
});

function channelStateEntry(
  id: string,
  status: string,
  deposit: number,
  settled: number,
  payout: number,
) {
  return {
    balance: String(deposit),
    channelId: id,
    payoutWatermark: String(payout),
    status,
    totalClaimed: String(settled),
    withdrawRequestedAt: 0,
  };
}

function withChannelStates(response: SettleResponse, ...entries: unknown[]): SettleResponse {
  return { ...response, extra: { ...response.extra, channelStates: entries } };
}

function resyncFailure(reason: string, ...entries: unknown[]): SettleResponse {
  return withChannelStates(
    { errorReason: reason, network: SOLANA_DEVNET_CAIP2, success: false },
    ...entries,
  );
}

function claimsOf(submitted: { type: string; channels: string[] }[]): string[][] {
  return submitted.filter(s => s.type === "claim").map(s => s.channels.sort());
}

describe("batch-settlement redemption resync from the facilitator", () => {
  const settledOnly = { highestVoucherSignature: undefined, settled: 3_000n };

  function manager(
    store: MemoryChannelStore,
    settle: ReturnType<typeof recorder>["settle"],
    errors: string[] = [],
    extra: Partial<ConstructorParameters<typeof BatchChannelManager>[0]> = {},
  ) {
    return new BatchChannelManager({
      onError: error => errors.push(String(error instanceof Error ? error.message : error)),
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
      ...extra,
    });
  }

  it("adopts the facilitator's channel states on a successful distribute", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", settledOnly));
    await store.put(channel("chan-b", settledOnly));
    const onSettle = vi.fn();
    const settle = async (): Promise<SettleResponse> =>
      withChannelStates(
        { ...ok(), extra: { channels: ["chan-a", "chan-b"] } },
        channelStateEntry("chan-a", "open", 10_000, 3_500, 3_500),
        channelStateEntry("chan-b", "distributed", 10_000, 3_000, 3_000),
      );
    const result = await manager(store, settle, [], {
      onSettle,
      readPayoutWatermark: async () => {
        throw new Error("the chain must not be read when the facilitator reports state");
      },
    }).redeem();
    expect(result.distributed.sort()).toEqual(["chan-a", "chan-b"]);
    expect(onSettle).toHaveBeenCalledExactlyOnceWith({ transaction: "sig" });
    expect(await store.get("chan-a")).toMatchObject({
      payoutWatermark: 3_500n,
      settled: 3_500n,
      status: "open",
    });
    expect((await store.get("chan-b"))?.status).toBe("distributed");
  });

  it("re-claims only the channels that are behind after a mixed batch is rejected", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    await store.put(channel("chan-b"));
    const onClaim = vi.fn();
    const errors: string[] = [];
    const { settle, submitted } = recorder(payload =>
      payload.type === "claim" && payload.claims?.length === 2
        ? resyncFailure(
            BatchError.CUMULATIVE_AMOUNT_MISMATCH,
            channelStateEntry("chan-a", "open", 10_000, 3_000, 0),
            channelStateEntry("chan-b", "open", 10_000, 0, 0),
          )
        : recovered(payload),
    );
    const result = await manager(store, settle, errors, { onClaim }).redeem();
    expect(errors).toEqual([]);
    expect(claimsOf(submitted)).toEqual([["chan-a", "chan-b"], ["chan-b"]]);
    expect(result.claimed).toEqual(["chan-b"]);
    expect(onClaim).toHaveBeenCalledExactlyOnceWith({ transaction: "sig", vouchers: 1 });
    expect((await store.get("chan-a"))?.settled).toBe(3_000n);
    expect((await store.get("chan-b"))?.settled).toBe(3_000n);
  });

  it("resyncs a fully applied claim without resubmitting", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const onClaim = vi.fn();
    const errors: string[] = [];
    const { settle, submitted } = recorder(payload =>
      payload.type === "claim"
        ? resyncFailure(
            BatchError.CUMULATIVE_AMOUNT_MISMATCH,
            channelStateEntry("chan-a", "open", 10_000, 4_000, 0),
          )
        : {
            ...recovered(payload),
            extra: {
              channelStates: [channelStateEntry("chan-a", "open", 10_000, 4_000, 4_000)],
              channels: ["chan-a"],
            },
          },
    );
    const result = await manager(store, settle, errors, { onClaim }).redeem();
    expect(errors).toEqual([]);
    expect(onClaim).not.toHaveBeenCalled();
    expect(result.claimed).toEqual([]);
    expect(claimsOf(submitted)).toEqual([["chan-a"]]);
    expect((await store.get("chan-a"))?.settled).toBe(4_000n);
    expect(result.distributed).toEqual(["chan-a"]);
  });

  it("stops retrying when nothing resyncs", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    await store.put(channel("chan-b"));
    const errors: string[] = [];
    const { settle, submitted } = recorder(() =>
      resyncFailure(
        BatchError.CUMULATIVE_AMOUNT_MISMATCH,
        channelStateEntry("chan-a", "open", 10_000, 0, 0),
        channelStateEntry("chan-b", "open", 10_000, 2_999, 0),
      ),
    );
    await manager(store, settle, errors).redeem();
    expect(claimsOf(submitted)).toHaveLength(1);
    expect(errors).toEqual([
      `batch-settlement claim failed: ${BatchError.CUMULATIVE_AMOUNT_MISMATCH}`,
    ]);
  });

  it("re-claims at most once after a resync", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    await store.put(channel("chan-b"));
    const errors: string[] = [];
    const { settle, submitted } = recorder(payload => {
      if (payload.type !== "claim") return recovered(payload);
      return payload.claims?.length === 2
        ? resyncFailure(
            BatchError.CUMULATIVE_AMOUNT_MISMATCH,
            channelStateEntry("chan-a", "open", 10_000, 3_000, 0),
            channelStateEntry("chan-b", "open", 10_000, 0, 0),
          )
        : resyncFailure(
            BatchError.CUMULATIVE_AMOUNT_MISMATCH,
            channelStateEntry(payload.claims![0]!.voucher.channelId, "open", 10_000, 0, 0),
          );
    });
    await manager(store, settle, errors).redeem();
    expect(claimsOf(submitted)).toEqual([["chan-a", "chan-b"], ["chan-b"]]);
    expect(errors).toHaveLength(1);
  });

  const valid = channelStateEntry("chan-a", "open", 10_000, 3_000, 0);
  it.each<[string, unknown[]]>([
    ["another channel", [channelStateEntry("chan-z", "open", 10_000, 3_000, 0)]],
    ["an extra channel", [valid, channelStateEntry("chan-b", "open", 10_000, 3_000, 0)]],
    ["a duplicate", [valid, valid]],
    ["no entries", []],
    ["payout above settled", [channelStateEntry("chan-a", "open", 10_000, 3_000, 3_001)]],
    ["settled above the deposit", [channelStateEntry("chan-a", "open", 2_000, 3_000, 0)]],
    ["an unknown status", [{ ...valid, status: "frozen" }]],
    ["a malformed amount", [{ ...valid, totalClaimed: "30x0" }]],
    ["a numeric amount", [{ ...valid, totalClaimed: 3_000 }]],
    ["a missing amount", [{ ...valid, payoutWatermark: undefined }]],
  ])("ignores channel states that name %s or carry impossible values", async (_name, entries) => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const errors: string[] = [];
    const { settle, submitted } = recorder(() =>
      resyncFailure(BatchError.CUMULATIVE_AMOUNT_MISMATCH, ...entries),
    );
    await manager(store, settle, errors).redeem();
    expect(claimsOf(submitted)).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((await store.get("chan-a"))?.settled).toBe(0n);
  });

  it("ignores channel states bound to another network", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const errors: string[] = [];
    const { settle } = recorder(() => ({
      ...resyncFailure(BatchError.CUMULATIVE_AMOUNT_MISMATCH, valid),
      network: "solana:other" as SettleResponse["network"],
    }));
    await manager(store, settle, errors).redeem();
    expect(errors).toHaveLength(1);
    expect((await store.get("chan-a"))?.settled).toBe(0n);
  });

  it("resyncs the payout watermark when a distribute finds nothing left to sweep", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", settledOnly));
    const onSettle = vi.fn();
    const errors: string[] = [];
    const { settle } = recorder(() =>
      resyncFailure(
        BatchError.CUMULATIVE_AMOUNT_MISMATCH,
        channelStateEntry("chan-a", "open", 10_000, 3_000, 3_000),
      ),
    );
    const result = await manager(store, settle, errors, { onSettle }).redeem();
    expect(errors).toEqual([]);
    expect(onSettle).not.toHaveBeenCalled();
    expect(result.distributed).toEqual([]);
    expect((await store.get("chan-a"))?.payoutWatermark).toBe(3_000n);
  });

  it("reports a distribute rejection that carries no state and leaves local state alone", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", settledOnly));
    const errors: string[] = [];
    const { settle } = recorder(() => ({
      errorReason: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
      network: SOLANA_DEVNET_CAIP2,
      success: false,
    }));
    await manager(store, settle, errors, {
      readPayoutWatermark: async () => {
        throw new Error("a rejection without state must not read the chain");
      },
    }).redeem();
    expect(errors).toEqual([
      `batch-settlement distribute failed: ${BatchError.CUMULATIVE_AMOUNT_MISMATCH}`,
    ]);
    expect((await store.get("chan-a"))?.payoutWatermark).toBe(0n);
  });

  describe("seal", () => {
    async function closing() {
      const store = new MemoryChannelStore();
      const id = (await generateKeyPairSigner()).address;
      await store.put(channel(id, { status: "closing" }));
      return { id, store };
    }

    it("records a paid-out channel when a seal finds it distributed, without calling onSeal", async () => {
      const { id, store } = await closing();
      const onSeal = vi.fn();
      const errors: string[] = [];
      const { settle, submitted } = recorder(() =>
        resyncFailure(
          BatchError.CLOSE_STATE,
          channelStateEntry(id, "distributed", 10_000, 3_000, 3_000),
        ),
      );
      const redeemer = manager(store, settle, errors, { onSeal });
      const result = await redeemer.redeem();
      expect(errors).toEqual([]);
      expect(onSeal).not.toHaveBeenCalled();
      expect(result.sealed).toEqual([]);
      expect(await store.get(id)).toMatchObject({
        payoutWatermark: 3_000n,
        settled: 3_000n,
        status: "distributed",
      });

      await redeemer.redeem();
      expect(submitted.map(s => s.type)).toEqual(["seal"]);
    });

    it("records a sealed channel as sealed and distributes its unpaid settled amount", async () => {
      const { id, store } = await closing();
      const errors: string[] = [];
      const { settle, submitted } = recorder(payload =>
        payload.type === "settle"
          ? {
              ...ok(),
              extra: {
                channelStates: [channelStateEntry(id, "distributed", 10_000, 3_000, 3_000)],
                channels: [id],
              },
            }
          : resyncFailure(
              BatchError.CLOSE_STATE,
              channelStateEntry(id, "sealed", 10_000, 3_000, 0),
            ),
      );
      const result = await manager(store, settle, errors).redeem();
      expect(errors).toEqual([`batch-settlement seal failed: ${BatchError.CLOSE_STATE}`]);
      expect(result.distributed).toEqual([id]);
      expect(submitted.map(s => s.type)).toEqual(["seal", "settle"]);
      expect(await store.get(id)).toMatchObject({
        payoutWatermark: 3_000n,
        settled: 3_000n,
        status: "distributed",
      });
    });

    it("keeps a sealed channel sealed and payable until a distribute lands", async () => {
      const { id, store } = await closing();
      const { settle } = recorder(payload =>
        payload.type === "settle"
          ? { errorReason: "settlement_pending", network: SOLANA_DEVNET_CAIP2, success: false }
          : resyncFailure(
              BatchError.CLOSE_STATE,
              channelStateEntry(id, "sealed", 10_000, 3_000, 1_000),
            ),
      );
      await manager(store, settle, []).redeem();
      expect(await store.get(id)).toMatchObject({
        payoutWatermark: 1_000n,
        settled: 3_000n,
        status: "sealed",
      });
    });

    it("reports a seal rejection for a channel that is still closing without recording it", async () => {
      const { id, store } = await closing();
      const errors: string[] = [];
      const { settle } = recorder(() =>
        resyncFailure(BatchError.CLOSE_STATE, channelStateEntry(id, "closing", 10_000, 4_000, 0)),
      );
      await manager(store, settle, errors).redeem();
      expect(errors).toHaveLength(1);
      expect(await store.get(id)).toMatchObject({ settled: 0n, status: "closing" });
    });
  });
});
