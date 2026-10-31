import { describe, it, expect } from "vitest";
import { applyClaimedTotals, selectClaimableVouchers } from "../../../src/batch-settlement/claims";
import {
  InMemoryChannelStorage,
  type Channel,
} from "../../../src/batch-settlement/storage/channel";
import { computeChannelId } from "../../../src/batch-settlement/utils";

const NETWORK = "eip155:84532";

function baseChannel(overrides: Partial<Channel> = {}): Channel {
  const channelConfig = {
    payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
    payerAuthorizer: "0x0000000000000000000000000000000000000000" as const,
    receiver: "0x9876543210987654321098765432109876543210" as const,
    receiverAuthorizer: "0x1111111111111111111111111111111111111111" as const,
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000" as const,
    ...(overrides.channelConfig ?? {}),
  };
  const channelId = computeChannelId(channelConfig, NETWORK);
  return {
    channelId,
    channelConfig,
    chargedCumulativeAmount: "5000",
    signedMaxClaimable: "5000",
    signature: "0xdeadbeef",
    balance: "10000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
    ...overrides,
  };
}

describe("selectClaimableVouchers", () => {
  it("returns nothing when charged amounts are already claimed onchain", () => {
    const channel = baseChannel({ chargedCumulativeAmount: "1000", totalClaimed: "1000" });
    expect(selectClaimableVouchers([channel])).toEqual([]);
  });

  it("includes channels regardless of recency when idleSecs is omitted", () => {
    const fresh = baseChannel({ lastRequestTimestamp: Date.now() });
    expect(selectClaimableVouchers([fresh])).toHaveLength(1);
    expect(selectClaimableVouchers([fresh])[0].totalClaimed).toBe(fresh.chargedCumulativeAmount);
  });

  it("skips channels that received a request within the idle window", () => {
    const now = 1_000_000;
    const fresh = baseChannel({ lastRequestTimestamp: now - 30_000 });
    const idle = baseChannel({
      salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
      lastRequestTimestamp: now - 120_000,
    });
    const claims = selectClaimableVouchers([fresh, idle], { now, idleSecs: 60 });
    expect(claims).toHaveLength(1);
    expect(claims[0].totalClaimed).toBe(idle.chargedCumulativeAmount);
  });
});

describe("applyClaimedTotals", () => {
  it("ignores claims for channels that are not in storage", async () => {
    const storage = new InMemoryChannelStorage();
    const channel = baseChannel();
    await applyClaimedTotals(
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
    );
    expect(await storage.get(channel.channelId)).toBeUndefined();
  });

  it("ignores claims that do not advance totalClaimed", async () => {
    const storage = new InMemoryChannelStorage();
    const channel = baseChannel({ totalClaimed: "5000", chargedCumulativeAmount: "5000" });
    await storage.updateChannel(channel.channelId, () => channel);
    await applyClaimedTotals(
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
    );
    expect((await storage.get(channel.channelId))?.totalClaimed).toBe("5000");
  });

  it("does not regress totalClaimed when the claim batch is stale", async () => {
    const storage = new InMemoryChannelStorage();
    const channel = baseChannel({ totalClaimed: "4000" });
    await storage.updateChannel(channel.channelId, () => channel);
    await applyClaimedTotals(
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "3000",
        },
      ],
      NETWORK,
    );
    expect((await storage.get(channel.channelId))?.totalClaimed).toBe("4000");
  });

  it("advances totalClaimed when a claim reports a higher watermark", async () => {
    const storage = new InMemoryChannelStorage();
    const channel = baseChannel({ totalClaimed: "1000" });
    await storage.updateChannel(channel.channelId, () => channel);
    await applyClaimedTotals(
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
    );
    expect((await storage.get(channel.channelId))?.totalClaimed).toBe("5000");
  });

  it("does not lower totalClaimed when storage advanced between read and update", async () => {
    const base = new InMemoryChannelStorage();
    const channel = baseChannel({ totalClaimed: "1000" });
    await base.updateChannel(channel.channelId, () => channel);
    const storage = {
      get: (id: string) => base.get(id),
      updateChannel: async (
        id: string,
        update: (current: Channel | undefined) => Channel | undefined,
      ) =>
        base.updateChannel(id, current =>
          update(current ? { ...current, totalClaimed: "6000" } : current),
        ),
    };

    await applyClaimedTotals(
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
    );
    expect((await base.get(channel.channelId))?.totalClaimed).toBe("6000");
  });
});
