import { describe, it, expect } from "vitest";
import {
  advertisedVoucherManagers,
  channelStateExtra,
  commitVoucherCharge,
  defaultOnchainStateTtlMs,
  isFacilitatorManaged,
  paymentResponseExtra,
  pendingTtlMs,
  voucherStoreMode,
} from "../../../src/batch-settlement/voucherStore";
import {
  InMemoryChannelStorage,
  type Channel,
  type ChannelStorage,
} from "../../../src/batch-settlement/storage/channel";
import type { PaymentRequirements } from "@x402/core/types";

const CHANNEL_ID = "0xabc1230000000000000000000000000000000000000000000000000000000001";

function baseChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: CHANNEL_ID,
    channelConfig: {
      payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      payerAuthorizer: "0x0000000000000000000000000000000000000000",
      receiver: "0x9876543210987654321098765432109876543210",
      receiverAuthorizer: "0x1111111111111111111111111111111111111111",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      withdrawDelay: 900,
      salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
    chargedCumulativeAmount: "2000",
    signedMaxClaimable: "3000",
    signature: "0xaaa",
    balance: "10000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: 1,
    ...overrides,
  };
}

describe("voucherStore helpers — pendingTtlMs", () => {
  it("clamps a zero timeout to the minimum admission lock TTL", () => {
    expect(pendingTtlMs(0)).toBe(5_000);
  });

  it("clamps an oversized timeout to ten minutes", () => {
    expect(pendingTtlMs(3600)).toBe(600_000);
  });

  it("honours a mid-range timeout in milliseconds", () => {
    expect(pendingTtlMs(120)).toBe(120_000);
  });

  it("treats an undefined timeout like zero before clamping", () => {
    expect(pendingTtlMs(undefined)).toBe(5_000);
  });
});

describe("voucherStore helpers — defaultOnchainStateTtlMs", () => {
  it("clamps a short withdraw delay to 30 seconds", () => {
    expect(defaultOnchainStateTtlMs(30)).toBe(30_000);
  });

  it("uses one third of a mid-range withdraw delay", () => {
    expect(defaultOnchainStateTtlMs(180)).toBe(60_000);
  });

  it("clamps a long withdraw delay to five minutes", () => {
    expect(defaultOnchainStateTtlMs(900)).toBe(300_000);
  });
});

describe("voucherStore helpers — mode detection", () => {
  it('treats only voucherManager "facilitator" as facilitator-managed', () => {
    expect(isFacilitatorManaged({ extra: { voucherManager: "facilitator" } })).toBe(true);
    expect(isFacilitatorManaged({ extra: { voucherManager: "server" } })).toBe(false);
    expect(isFacilitatorManaged({ extra: { voucherManager: ["facilitator"] } })).toBe(false);
    expect(isFacilitatorManaged({ extra: { voucherStore: true } })).toBe(false);
    expect(isFacilitatorManaged({ extra: {} })).toBe(false);
    expect(isFacilitatorManaged({})).toBe(false);
    expect(
      voucherStoreMode({ extra: { voucherManager: "facilitator" } } as PaymentRequirements),
    ).toBe("facilitator");
    expect(voucherStoreMode({ extra: { voucherManager: "server" } } as PaymentRequirements)).toBe(
      "self",
    );
    expect(voucherStoreMode({ extra: {} } as PaymentRequirements)).toBe("self");
  });
});

describe("voucherStore helpers — advertisedVoucherManagers", () => {
  it("defaults to server, filters unknown values, and rejects non-arrays", () => {
    expect(advertisedVoucherManagers(undefined)).toEqual(["server"]);
    expect(advertisedVoucherManagers({ voucherManager: ["facilitator", "bogus", 1] })).toEqual([
      "facilitator",
    ]);
    expect(advertisedVoucherManagers({ voucherManager: "facilitator" })).toEqual([]);
  });
});

describe("voucherStore helpers — commitVoucherCharge", () => {
  it("returns missing when there is no row and no snapshot", async () => {
    const storage = new InMemoryChannelStorage();
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 1000n,
      signedCap: 5000n,
      voucher: { maxClaimableAmount: "5000", signature: "0xbbb" },
    });
    expect(result).toEqual({ status: "missing" });
  });

  it("returns cap_exceeded without mutating storage", async () => {
    const storage = new InMemoryChannelStorage();
    await storage.updateChannel(CHANNEL_ID, () => baseChannel());
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 2000n,
      signedCap: 3000n,
      voucher: { maxClaimableAmount: "3000", signature: "0xbbb" },
    });
    expect(result).toEqual({ status: "cap_exceeded", charged: "4000" });
    expect(await storage.get(CHANNEL_ID)).toMatchObject({ chargedCumulativeAmount: "2000" });
  });

  it("returns watermark_mismatch without mutating storage when expectedCharged differs", async () => {
    const storage = new InMemoryChannelStorage();
    await storage.updateChannel(CHANNEL_ID, () => baseChannel());
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 500n,
      signedCap: 3000n,
      expectedCharged: 1500n,
      voucher: { maxClaimableAmount: "2500", signature: "0xbbb" },
    });
    expect(result).toEqual({ status: "watermark_mismatch", charged: "2000" });
    expect(await storage.get(CHANNEL_ID)).toMatchObject({ chargedCumulativeAmount: "2000" });
  });

  it("commits when expectedCharged equals the stored watermark", async () => {
    const storage = new InMemoryChannelStorage();
    await storage.updateChannel(CHANNEL_ID, () => baseChannel());
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 500n,
      signedCap: 3000n,
      expectedCharged: 2000n,
      voucher: { maxClaimableAmount: "2500", signature: "0xbbb" },
    });
    expect(result.status).toBe("committed");
    expect(await storage.get(CHANNEL_ID)).toMatchObject({ chargedCumulativeAmount: "2500" });
  });

  it("applies map after a successful commit", async () => {
    const storage = new InMemoryChannelStorage();
    await storage.updateChannel(CHANNEL_ID, () => baseChannel());
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 500n,
      signedCap: 3000n,
      voucher: { maxClaimableAmount: "2500", signature: "0xccc" },
      map: channel => ({ ...channel, chargedCumulativeAmount: "9999" }),
    });
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.current.chargedCumulativeAmount).toBe("9999");
    }
  });

  it("creates a channel row from snapshot when storage is empty", async () => {
    const storage = new InMemoryChannelStorage();
    const snapshot = baseChannel({ chargedCumulativeAmount: "1000", balance: "9000" });
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 500n,
      signedCap: 5000n,
      voucher: { maxClaimableAmount: "5000", signature: "0xbbb" },
      snapshot,
    });
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.current.chargedCumulativeAmount).toBe("1500");
      expect(result.current.balance).toBe("9000");
    }
    expect(await storage.get(CHANNEL_ID)).toBeDefined();
  });

  it("returns conflict when storage does not apply the charge update", async () => {
    const storage: ChannelStorage = {
      get: async () => undefined,
      list: async () => [],
      updateChannel: async () => ({ channel: baseChannel(), status: "unchanged" }),
    };
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 500n,
      signedCap: 5000n,
      voucher: { maxClaimableAmount: "5000", signature: "0xbbb" },
      snapshot: baseChannel(),
    });
    expect(result).toEqual({ status: "conflict" });
  });

  it("keeps stored escrow fields when localVerify is true even if a snapshot is provided", async () => {
    const storage = new InMemoryChannelStorage();
    await storage.updateChannel(CHANNEL_ID, () =>
      baseChannel({ balance: "7777", totalClaimed: "3" }),
    );
    const snapshot = baseChannel({
      balance: "10000",
      totalClaimed: "0",
    });
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 100n,
      signedCap: 5000n,
      voucher: { maxClaimableAmount: "5000", signature: "0xbbb" },
      snapshot,
      localVerify: true,
    });
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.current.balance).toBe("7777");
      expect(result.current.totalClaimed).toBe("3");
    }
  });

  it("refreshes escrow fields from a facilitator snapshot when not in local verify mode", async () => {
    const storage = new InMemoryChannelStorage();
    await storage.updateChannel(CHANNEL_ID, () =>
      baseChannel({ balance: "1", totalClaimed: "9", refundNonce: 1, withdrawRequestedAt: 2 }),
    );
    const snapshot = baseChannel({
      balance: "10000",
      totalClaimed: "0",
      refundNonce: 0,
      withdrawRequestedAt: 0,
    });
    const result = await commitVoucherCharge(storage, CHANNEL_ID, {
      increment: 1000n,
      signedCap: 5000n,
      voucher: { maxClaimableAmount: "5000", signature: "0xbbb" },
      snapshot,
    });
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.current.balance).toBe("10000");
      expect(result.current.totalClaimed).toBe("0");
      expect(result.current.chargedCumulativeAmount).toBe("3000");
    }
  });
});

describe("voucherStore helpers — response extras", () => {
  it("omits chargedCumulativeAmount from channelStateExtra when not provided", () => {
    expect(channelStateExtra(baseChannel())).not.toHaveProperty("chargedCumulativeAmount");
  });

  it("includes chargeCount only for facilitator-managed paid responses", () => {
    const snapshot = channelStateExtra(baseChannel(), "2500");
    const channelOnly = paymentResponseExtra({ channelState: snapshot });
    expect(Object.keys(channelOnly)).toEqual(["channelState"]);
    const paid = paymentResponseExtra({
      channelState: snapshot,
      chargedAmount: "500",
      chargeCount: 2,
    });
    expect(Object.keys(paid)).toEqual(["channelState", "chargedAmount", "chargeCount"]);
    const refund = paymentResponseExtra({ channelState: snapshot, chargeCount: 0 });
    expect(refund.chargedAmount).toBeUndefined();
    expect(refund.chargeCount).toBe(0);
  });
});
