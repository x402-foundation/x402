import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import {
  type ChannelState,
  type ChannelStore,
  MemoryChannelStore,
} from "../../src/batch-settlement/server/storage";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const RECEIVER = USDC_MAINNET_ADDRESS;

function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: { feePayer: RECEIVER, tokenProgram: TOKEN_PROGRAM_ADDRESS, withdrawDelay: 900 },
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

type Payload = {
  type: string;
  claims?: { voucher: { channelId: string; expiresAt: number; maxClaimableAmount: string } }[];
  channels?: { channelId: string }[];
};

function ok(): SettleResponse {
  return { network: SOLANA_DEVNET_CAIP2, success: true, transaction: "sig" };
}

/** Answers claims with a bound success and settles per `distribute`. */
function settler(distribute: (payload: Payload) => SettleResponse) {
  const payloads: Payload[] = [];
  const settle = async ({ payload }: { payload: unknown }): Promise<SettleResponse> => {
    const raw = payload as Payload;
    payloads.push(raw);
    if (raw.type === "claim") {
      return {
        ...ok(),
        extra: {
          accepts: (raw.claims ?? []).map(({ voucher }) => ({
            channelId: voucher.channelId,
            totalClaimed: voucher.maxClaimableAmount,
          })),
        },
      };
    }
    return distribute(raw);
  };
  return { payloads, settle };
}

function boundDistribute(raw: Payload): SettleResponse {
  return { ...ok(), extra: { channels: (raw.channels ?? []).map(c => c.channelId) } };
}

describe("batch-settlement redemption worker edge cases", () => {
  it("refuses a store that cannot enumerate its channels", async () => {
    const store: ChannelStore = {
      get: async () => undefined,
      put: async () => undefined,
      update: async () => channel("x"),
    };
    const manager = new BatchChannelManager({ requirements: requirements(), settle: ok, store });
    await expect(manager.redeem()).rejects.toThrow(/can list its channels/);
  });

  it("claims a voucher without an expiry as a non-expiring one", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", { highestVoucherExpiresAt: undefined }));
    const { payloads, settle } = settler(boundDistribute);
    await new BatchChannelManager({
      readPayoutWatermark: async () => 3_000n,
      requirements: requirements(),
      settle,
      store,
    }).redeem();
    expect(payloads[0]?.claims?.[0]?.voucher.expiresAt).toBe(0);
  });

  it("reports unknown reasons and leaves the work for the next pass", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    await store.put(channel("chan-b", { settled: 3_000n, highestVoucherSignature: undefined }));
    const errors: string[] = [];
    const settle = async (): Promise<SettleResponse> => ({
      network: SOLANA_DEVNET_CAIP2,
      success: false,
    });
    const result = await new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      requirements: requirements(),
      settle,
      store,
    }).redeem();
    expect(result).toEqual({ claimed: [], distributed: [] });
    expect(errors).toEqual([
      "batch-settlement claim failed: unknown",
      "batch-settlement distribute failed: unknown",
    ]);
    expect((await store.get("chan-a"))?.settled).toBe(0n);
  });

  it("does not record a distribution whose response is unbound or malformed", async () => {
    const answers: SettleResponse[] = [
      { ...ok(), extra: { channels: ["chan-a"] }, network: "solana:other" },
      { ...ok(), extra: { channels: "chan-a" } },
      { ...ok(), extra: { channels: ["chan-a", "chan-a"] } },
      { ...ok(), extra: { channels: ["chan-b"] } },
      { ...ok() },
    ];
    for (const answer of answers) {
      const store = new MemoryChannelStore();
      await store.put(channel("chan-a", { settled: 3_000n, highestVoucherSignature: undefined }));
      const errors: string[] = [];
      const result = await new BatchChannelManager({
        onError: error => errors.push((error as Error).message),
        readPayoutWatermark: async () => 3_000n,
        requirements: requirements(),
        settle: async () => answer,
        store,
      }).redeem();
      expect(result.distributed).toEqual([]);
      expect(errors).toEqual(["batch-settlement distribute response channel mismatch"]);
      expect((await store.get("chan-a"))?.payoutWatermark).toBe(0n);
    }
  });

  it("never lowers watermarks the store already advanced past", async () => {
    // Another writer moves the channel further between the snapshot and the
    // record; the worker keeps the higher value rather than rewinding it.
    const inner = new MemoryChannelStore();
    const store: ChannelStore = {
      get: id => inner.get(id),
      list: () => inner.list(),
      put: state => inner.put(state),
      update: (id, updater) =>
        inner.update(id, current =>
          updater(current && { ...current, payoutWatermark: 2_500n, settled: 5_000n }),
        ),
    };
    await store.put(channel("chan-a", { payoutWatermark: 1_000n }));
    const { settle } = settler(boundDistribute);
    const result = await new BatchChannelManager({
      readPayoutWatermark: async () => 2_000n,
      requirements: requirements(),
      settle,
      store,
    }).redeem();
    expect(result.claimed).toEqual(["chan-a"]);
    // The read paid 2000 covers the snapshot's settled 3000? No: it stays payable.
    expect(result.distributed).toEqual([]);
    const state = await store.get("chan-a");
    expect(state?.settled).toBe(5_000n);
    expect(state?.payoutWatermark).toBe(2_500n);
  });

  it("surfaces a channel that vanished between the snapshot and the record", async () => {
    const inner = new MemoryChannelStore();
    const store: ChannelStore = {
      get: id => inner.get(id),
      list: () => inner.list(),
      put: state => inner.put(state),
      update: (id, updater) => inner.update(id, () => updater(undefined)),
    };
    await store.put(channel("chan-a"));
    const { settle } = settler(boundDistribute);
    await expect(
      new BatchChannelManager({ requirements: requirements(), settle, store }).redeem(),
    ).rejects.toThrow(/vanished mid-redemption/);
  });
});
