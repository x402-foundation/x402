import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import {
  MemoryDistributionJobStore,
  type DistributionJob,
  type DistributionJobStore,
} from "../../src/batch-settlement/server/distributionJobStore";
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
      receiverAuthorizer: receiverAuthorizer.address,
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
      receiverAuthorizer: receiverAuthorizer.address,
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

it("research: a stable distribution batch recovers on a later pass and reports the original transaction", async () => {
  const store = new MemoryChannelStore();
  await store.put(channel("chan-a", { settled: 3000n }));
  let confirmed = false;
  const onSettle = vi.fn();
  const { settle, submitted } = recorder(payload =>
    confirmed
      ? { ...recovered(payload), transaction: "original-payout" }
      : {
          success: false,
          network: SOLANA_DEVNET_CAIP2,
          errorReason: "settlement_pending",
          transaction: "original-payout",
        },
  );
  const options = {
    store,
    requirements: requirements(),
    settle,
    onSettle,
    readPayoutWatermark: async () => 3000n,
  };
  expect((await new BatchChannelManager(options).redeem()).distributed).toEqual([]);
  expect((await store.get("chan-a"))?.payoutWatermark).toBe(0n);
  expect(onSettle).not.toHaveBeenCalled();
  confirmed = true;
  expect((await new BatchChannelManager(options).redeem()).distributed).toEqual(["chan-a"]);
  expect((await store.get("chan-a"))?.payoutWatermark).toBe(3000n);
  expect(onSettle).toHaveBeenCalledExactlyOnceWith({ transaction: "original-payout" });
  expect((await new BatchChannelManager(options).redeem()).distributed).toEqual([]);
  expect(submitted.map(item => item.channels)).toEqual([["chan-a"], ["chan-a"]]);
});

describe("distribution journal recovery", () => {
  const ready = (id: string) =>
    channel(id, {
      highestVoucherSignature: undefined,
      signedMaxClaimable: 1000n,
      settled: 1000n,
      chargedCumulativeAmount: 1000n,
    });
  const job = (id: string, ids = ["chan-a"]): DistributionJob => ({
    version: 1,
    id,
    channels: ids.map(channelId => ({ channelId, channelConfig: ready(channelId).channelConfig })),
    requirements: requirements(),
  });
  const options = (
    store: ChannelStore,
    journal: DistributionJobStore,
    settle: (request: { payload: unknown }, terms: PaymentRequirements) => Promise<SettleResponse>,
  ) => ({
    store,
    distributionJobStore: journal,
    requirements: requirements(),
    settle,
    readPayoutWatermark: async () => 1000n,
  });

  it.each(["pending", "lost response"])(
    "restores serialized requests after %s with changed batching and weak channel enumeration",
    async mode => {
      const store = new MemoryChannelStore();
      await store.put(ready("chan-a"));
      await store.put(ready("chan-b"));
      const journal = new MemoryDistributionJobStore();
      const terms = requirements();
      terms.extra = { ...terms.extra, memo: "original", nested: { labels: ["original"] } };
      const first = new BatchChannelManager({
        ...options(store, journal, async () => {
          if (mode === "lost response") throw new Error("response lost");
          return {
            success: false,
            network: terms.network,
            transaction: "original",
            errorReason: "settlement_pending",
          };
        }),
        requirements: terms,
      });
      if (mode === "lost response") await expect(first.redeem()).rejects.toThrow("response lost");
      else await first.redeem();
      const saved = await journal.list();
      expect(saved).toHaveLength(1);
      terms.extra.memo = "changed";
      (terms.extra.nested as { labels: string[] }).labels[0] = "changed";
      const channelBytes = JSON.stringify(await store.list(), (_key, value) =>
        typeof value === "bigint" ? { bigint: value.toString() } : value,
      );
      const restoredChannels = JSON.parse(channelBytes, (_key, value) =>
        value && typeof value === "object" && "bigint" in value ? BigInt(value.bigint) : value,
      ) as ChannelState[];
      const restoredStore = new MemoryChannelStore();
      for (const state of restoredChannels) await restoredStore.put(state);
      const restoredJournal = new MemoryDistributionJobStore();
      for (const record of JSON.parse(JSON.stringify(saved)) as DistributionJob[])
        await restoredJournal.save(record);
      const weakStore: ChannelStore = {
        get: id => restoredStore.get(id),
        put: state => restoredStore.put(state),
        update: (id, updater) => restoredStore.update(id, updater),
        list: async () => [],
      };
      const calls: string[][] = [];
      const replay = new BatchChannelManager({
        ...options(weakStore, restoredJournal, async (request, accepted) => {
          const payload = request.payload as RedemptionPayload;
          calls.push(payload.channels!.map(item => item.channelId));
          expect(accepted.extra).toMatchObject({
            memo: "original",
            nested: { labels: ["original"] },
          });
          accepted.extra!.memo = "settler mutation";
          return recovered(payload);
        }),
        maxChannelsPerBatch: 1,
        requirements: { ...requirements(), amount: "999", maxTimeoutSeconds: 1 },
      });
      expect((await replay.redeem()).distributed).toEqual(["chan-a", "chan-b"]);
      expect(calls).toEqual([["chan-a", "chan-b"]]);
      expect(await restoredJournal.list()).toEqual([]);
      expect(saved[0]!.requirements.extra!.memo).toBe("original");
    },
  );

  it.each([false, true])("does not send after a failed save; committed=%s", async committed => {
    const store = new MemoryChannelStore();
    await store.put(ready("chan-a"));
    const memory = new MemoryDistributionJobStore();
    let fail = true;
    const journal: DistributionJobStore = {
      list: () => memory.list(),
      delete: id => memory.delete(id),
      save: async value => {
        if (committed || !fail) await memory.save(value);
        if (fail) throw new Error("save acknowledgement lost");
      },
    };
    const settle = vi.fn(async (request: { payload: unknown }) =>
      recovered(request.payload as RedemptionPayload),
    );
    const manager = new BatchChannelManager(options(store, journal, settle));
    await expect(manager.redeem()).rejects.toThrow("save acknowledgement lost");
    expect(settle).not.toHaveBeenCalled();
    expect(await memory.list()).toHaveLength(committed ? 1 : 0);
    fail = false;
    await manager.redeem();
    expect(settle).toHaveBeenCalledOnce();
    expect(await memory.list()).toEqual([]);
  });

  it.each([false, true])(
    "handles retirement acknowledgement loss without deleting a successor; committed=%s",
    async committed => {
      const store = new MemoryChannelStore();
      await store.put(ready("chan-a"));
      const memory = new MemoryDistributionJobStore();
      await memory.save(job("old"));
      let fail = true;
      const journal: DistributionJobStore = {
        list: () => memory.list(),
        save: value => memory.save(value),
        delete: async id => {
          if (committed || !fail) await memory.delete(id);
          if (fail) throw new Error("delete acknowledgement lost");
        },
      };
      const onSettle = vi.fn();
      const requests: string[][] = [];
      const manager = new BatchChannelManager({
        ...options(store, journal, async request => {
          const raw = request.payload as RedemptionPayload;
          requests.push(raw.channels!.map(item => item.channelId));
          return recovered(raw);
        }),
        onSettle,
      });
      await expect(manager.redeem()).rejects.toThrow("delete acknowledgement lost");
      expect(onSettle).not.toHaveBeenCalled();
      expect(await memory.list()).toHaveLength(committed ? 0 : 1);
      fail = false;
      await manager.redeem();
      expect(requests).toHaveLength(committed ? 1 : 2);
      const successor = job("successor");
      await memory.save(successor);
      await memory.delete("old");
      expect((await memory.list()).map(item => item.id)).toEqual(["successor"]);
    },
  );

  it.each(["absent", "read failure", "write failure", "newer claim"])(
    "retires accounted work despite %s",
    async mode => {
      const inner = new MemoryChannelStore();
      const state = ready("chan-a");
      if (mode === "newer claim") state.settled = 2000n;
      await inner.put(state);
      const journal = new MemoryDistributionJobStore();
      await journal.save(job("old"));
      const store: ChannelStore = {
        get: id => (mode === "absent" ? Promise.resolve(undefined) : inner.get(id)),
        put: value => inner.put(value),
        list: async () => [],
        update: (id, updater) =>
          mode === "write failure"
            ? Promise.reject(new Error("write failed"))
            : inner.update(id, updater),
      };
      const errors = vi.fn();
      const notify = vi.fn();
      const manager = new BatchChannelManager({
        ...options(store, journal, async request =>
          recovered(request.payload as RedemptionPayload),
        ),
        readPayoutWatermark: async () => {
          if (mode === "read failure") throw new Error("read failed");
          return 1000n;
        },
        onError: errors,
        onSettle: notify,
      });
      expect((await manager.redeem()).distributed).toEqual([]);
      expect(await journal.list()).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      if (mode !== "newer claim") expect(errors).toHaveBeenCalledOnce();
      const recorded = await inner.get("chan-a");
      expect(recorded!.payoutWatermark).toBe(mode === "newer claim" ? 1000n : 0n);
    },
  );

  it("clears before a throwing notification and permits later earnings", async () => {
    const store = new MemoryChannelStore();
    await store.put(ready("chan-a"));
    const journal = new MemoryDistributionJobStore();
    await journal.save(job("old"));
    const settle = vi.fn(async (request: { payload: unknown }) =>
      recovered(request.payload as RedemptionPayload),
    );
    const manager = new BatchChannelManager({
      ...options(store, journal, settle),
      onSettle: () => {
        throw new Error("notification failed");
      },
    });
    await expect(manager.redeem()).rejects.toThrow("notification failed");
    expect(await journal.list()).toEqual([]);
    await manager.redeem();
    expect(settle).toHaveBeenCalledOnce();
    await store.update("chan-a", current => ({ ...current!, settled: 2000n }));
    await manager.redeem();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(await journal.list()).toEqual([]);
  });

  it("continues independent payouts after a claim or recovery throws", async () => {
    const store = new MemoryChannelStore();
    await store.put(ready("chan-a"));
    await store.put(ready("chan-b"));
    await store.put(channel("claim-fails"));
    const journal = new MemoryDistributionJobStore();
    await journal.save(job("old"));
    const seen: string[] = [];
    const manager = new BatchChannelManager(
      options(store, journal, async request => {
        const raw = request.payload as RedemptionPayload;
        if (raw.type === "claim") throw new Error("claim unavailable");
        const id = raw.channels![0]!.channelId;
        seen.push(id);
        if (id === "chan-a") throw new Error("accounting unavailable");
        return recovered(raw);
      }),
    );
    await expect(manager.redeem()).rejects.toThrow("claim unavailable");
    expect(seen).toEqual(["chan-a", "chan-b"]);
    expect((await journal.list()).map(item => item.id)).toEqual(["old"]);
  });

  it.each(["list failure", "version", "duplicate member", "overlap", "scope rotation"])(
    "blocks sends for an incomplete or invalid journal: %s",
    async mode => {
      const store = new MemoryChannelStore();
      await store.put(ready("chan-b"));
      const records = [job("old")];
      if (mode === "version") records[0]!.version = 2 as 1;
      if (mode === "duplicate member") records[0]!.channels.push(records[0]!.channels[0]!);
      if (mode === "overlap") records.push(job("another"));
      if (mode === "scope rotation") records[0]!.requirements.extra!.feePayer = "rotated";
      const settle = vi.fn();
      const journal: DistributionJobStore = {
        list: async () => {
          if (mode === "list failure") throw new Error("journal unavailable");
          return records;
        },
        save: vi.fn(),
        delete: vi.fn(),
      };
      await expect(
        new BatchChannelManager(options(store, journal, settle)).redeem(),
      ).rejects.toThrow();
      expect(settle).not.toHaveBeenCalled();
      expect(journal.delete).not.toHaveBeenCalled();
    },
  );

  it("snapshots nested values and never replaces a saved generation", async () => {
    const journal = new MemoryDistributionJobStore();
    const original = job("old");
    original.requirements.extra!.nested = { values: ["original"] };
    await journal.save(original);
    original.channels[0]!.channelConfig.salt = "changed";
    const listed = await journal.list();
    (listed[0]!.requirements.extra!.nested as { values: string[] }).values[0] = "changed";
    expect((await journal.list())[0]!.channels[0]!.channelConfig.salt).toBe("0");
    expect((await journal.list())[0]!.requirements.extra!.nested).toEqual({ values: ["original"] });
    await expect(journal.save(original)).rejects.toThrow("already exists");
  });
  it("retires before a throwing local error hook", async () => {
    const store = new MemoryChannelStore();
    await store.put(ready("chan-a"));
    const journal = new MemoryDistributionJobStore();
    await journal.save(job("old"));
    const manager = new BatchChannelManager({
      ...options(store, journal, async request => recovered(request.payload as RedemptionPayload)),
      readPayoutWatermark: async () => {
        throw new Error("read failed");
      },
      onError: () => {
        throw new Error("error notification failed");
      },
    });
    await expect(manager.redeem()).rejects.toThrow("error notification failed");
    expect(await journal.list()).toEqual([]);
  });

  it.each(["claim", "seal"])(
    "journal discovery failure still permits time-critical %s",
    async kind => {
      const store = new MemoryChannelStore();
      await store.put(channel("urgent", { status: kind === "seal" ? "closing" : "open" }));
      const seen: string[] = [];
      const journal: DistributionJobStore = {
        list: async () => {
          throw new Error("journal unavailable");
        },
        save: vi.fn(),
        delete: vi.fn(),
      };
      const manager = new BatchChannelManager(
        options(store, journal, async request => {
          const raw = request.payload as RedemptionPayload;
          seen.push(raw.type);
          return recovered(raw);
        }),
      );
      await expect(manager.redeem()).rejects.toThrow("journal unavailable");
      expect(seen).toEqual([kind]);
    },
  );

  it.each(["closing", "distributed"] as const)(
    "replays a journal whose channel is now %s",
    async status => {
      const store = new MemoryChannelStore();
      await store.put({ ...ready("chan-a"), status });
      const journal = new MemoryDistributionJobStore();
      await journal.save(job("old"));
      const settle = vi.fn(async (request: { payload: unknown }) =>
        recovered(request.payload as RedemptionPayload),
      );
      expect(
        (await new BatchChannelManager(options(store, journal, settle)).redeem()).distributed,
      ).toEqual(["chan-a"]);
      expect(settle).toHaveBeenCalledOnce();
      expect(await journal.list()).toEqual([]);
    },
  );

  it("accepts an explicit default voucher mode without rewriting the snapshot", async () => {
    const store = new MemoryChannelStore();
    await store.put(ready("chan-a"));
    const journal = new MemoryDistributionJobStore();
    await journal.save(job("old"));
    const config = options(store, journal, async (request, accepted) => {
      expect(accepted.extra!.voucherSigner).toBeUndefined();
      return recovered(request.payload as RedemptionPayload);
    });
    config.requirements.extra!.voucherSigner = "client";
    config.requirements.extra!.operator = "irrelevant-to-client-mode";
    await new BatchChannelManager(config).redeem();
    expect(await journal.list()).toEqual([]);
  });

  it("rejects duplicate fresh rows before persisting or sending", async () => {
    const inner = new MemoryChannelStore();
    await inner.put(ready("chan-a"));
    const journal = new MemoryDistributionJobStore();
    const settle = vi.fn();
    const store: ChannelStore = {
      get: id => inner.get(id),
      put: value => inner.put(value),
      update: (id, updater) => inner.update(id, updater),
      list: async () => [ready("chan-a"), ready("chan-a")],
    };
    await expect(new BatchChannelManager(options(store, journal, settle)).redeem()).rejects.toThrow(
      "overlapping",
    );
    expect(settle).not.toHaveBeenCalled();
    expect(await journal.list()).toEqual([]);
  });

  it.each([1n, new Date(0), new Map(), NaN, Infinity, () => undefined])(
    "rejects non-wire journal values: %s",
    async value => {
      const journal = new MemoryDistributionJobStore();
      const record = job("old");
      record.requirements.extra!.invalid = value;
      await expect(journal.save(record)).rejects.toThrow("JSON-compatible");
      expect(await journal.list()).toEqual([]);
    },
  );
  it("retains a pending accounting job while unrelated channels settle", async () => {
    const store = new MemoryChannelStore();
    await store.put(ready("chan-a"));
    await store.put(ready("chan-b"));
    const journal = new MemoryDistributionJobStore();
    await journal.save(job("old"));
    let pending = true;
    const seen: string[] = [];
    const manager = new BatchChannelManager(
      options(store, journal, async request => {
        const raw = request.payload as RedemptionPayload;
        const id = raw.channels![0]!.channelId;
        seen.push(id);
        if (id === "chan-a" && pending)
          return {
            network: SOLANA_DEVNET_CAIP2,
            success: false,
            transaction: "original",
            errorReason: "settlement_pending",
          };
        return recovered(raw);
      }),
    );
    expect((await manager.redeem()).distributed).toEqual(["chan-b"]);
    expect((await journal.list()).map(record => record.id)).toEqual(["old"]);
    pending = false;
    expect((await manager.redeem()).distributed).toEqual(["chan-a"]);
    expect(seen).toEqual(["chan-a", "chan-b", "chan-a"]);
    expect(await journal.list()).toEqual([]);
  });
});
