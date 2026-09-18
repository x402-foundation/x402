import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { MemoryChannelStore, type ChannelState } from "../../src/batch-settlement/server/storage";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const RECEIVER = USDC_MAINNET_ADDRESS;

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
    const options = { requirements: requirements(), settle, store };
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
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [] });
  });

  it("packs no more than four channels into one claim", async () => {
    const store = new MemoryChannelStore();
    for (let index = 0; index < 9; index += 1) {
      await store.put(channel(`chan-${index}`));
    }
    const { settle, submitted } = recorder();
    const manager = new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
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
      requirements: requirements(),
      settle: pending.settle,
      store,
    }).redeem();
    expect((await store.get("chan-a"))?.settled).toBe(0n);

    const retry = recorder();
    const result = await new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      requirements: requirements(),
      settle: retry.settle,
      store,
    }).redeem();
    expect(result).toEqual({ claimed: ["chan-a"], distributed: ["chan-a"] });
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
      requirements: requirements(),
      settle,
      store,
    }).redeem();

    expect(result).toEqual({ claimed: [], distributed: [] });
    expect((await store.get("chan-a"))?.settled).toBe(0n);
    expect(errors).toHaveLength(1);
  });

  it("skips channels that are closing", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", { status: "closing" }));
    const { settle, submitted } = recorder();
    const manager = new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      requirements: requirements(),
      settle,
      store,
    });
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [] });
    expect(submitted).toEqual([]);
  });
});
