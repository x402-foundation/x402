import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { describe, expect, it } from "vitest";

import { verifyCloseAuthorization } from "../../src/batch-settlement/closeAuthorization";
import { BatchError } from "../../src/batch-settlement/errors";
import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import type { ChannelState, ChannelStore } from "../../src/batch-settlement/server/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const RECEIVER = USDC_MAINNET_ADDRESS;
const receiverAuthorizer = await generateKeyPairSigner();
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
    const manager = new BatchChannelManager({
      receiverAuthorizer,
      requirements: requirements(),
      settle: ok,
      store,
    });
    await expect(manager.redeem()).rejects.toThrow(/can list its channels/);
  });

  it("claims a voucher without an expiry as a non-expiring one", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", { highestVoucherExpiresAt: undefined }));
    const { payloads, settle } = settler(boundDistribute);
    await new BatchChannelManager({
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
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
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    }).redeem();
    expect(result).toEqual({ claimed: [], distributed: [], sealed: [] });
    expect(errors).toEqual([
      "batch-settlement claim failed: unknown",
      "batch-settlement distribute failed: unknown",
    ]);
    expect((await store.get("chan-a"))?.settled).toBe(0n);
  });

  it("does not record a distribution whose response is unbound or malformed", async () => {
    const mismatch = "batch-settlement distribute response channel mismatch";
    const answers: [SettleResponse, string][] = [
      [
        { ...ok(), extra: { channels: ["chan-a"] }, network: "solana:other" },
        "batch-settlement distribute response bound to another network",
      ],
      [{ ...ok(), extra: { channels: "chan-a" } }, mismatch],
      [{ ...ok(), extra: { channels: ["chan-a", "chan-a"] } }, mismatch],
      [{ ...ok(), extra: { channels: ["chan-b"] } }, mismatch],
    ];
    for (const [answer, expected] of answers) {
      const store = new MemoryChannelStore();
      await store.put(channel("chan-a", { settled: 3_000n, highestVoucherSignature: undefined }));
      const errors: string[] = [];
      const result = await new BatchChannelManager({
        onError: error => errors.push((error as Error).message),
        readPayoutWatermark: async () => 3_000n,
        receiverAuthorizer,
        requirements: requirements(),
        settle: async () => answer,
        store,
      }).redeem();
      expect(result.distributed).toEqual([]);
      expect(errors).toEqual([expected]);
      expect((await store.get("chan-a"))?.payoutWatermark).toBe(0n);
    }
  });

  it("reconciles from the chain when a facilitator answers with the spec's bare responses", async () => {
    // Spec 4.5 defines only success/transaction/network/amount for claim and
    // settle. The reference facilitator's `extra.accepts` / `extra.channels`
    // are optional enrichment, never a requirement on the server.
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const errors: unknown[] = [];
    const result = await new BatchChannelManager({
      onError: error => errors.push(error),
      readPayoutWatermark: async () => 3_000n,
      readSettledWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: async () => ok(),
      store,
    }).redeem();
    expect(errors).toEqual([]);
    expect(result).toEqual({ claimed: ["chan-a"], distributed: ["chan-a"], sealed: [] });
    const state = await store.get("chan-a");
    expect(state?.settled).toBe(3_000n);
    expect(state?.payoutWatermark).toBe(3_000n);
  });

  it("leaves a bare-response claim unrecorded until the chain shows the watermark", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    const errors: string[] = [];
    const result = await new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async () => 0n,
      readSettledWatermark: async () => 2_999n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: async () => ok(),
      store,
    }).redeem();
    expect(result.claimed).toEqual([]);
    expect(errors).toEqual(["confirmed settled watermark unavailable or behind the claim"]);
    expect((await store.get("chan-a"))?.settled).toBe(0n);
  });

  it("caps a configured batch size at the spec's four channels", async () => {
    const store = new MemoryChannelStore();
    for (const id of ["a", "b", "c", "d", "e"]) await store.put(channel(`chan-${id}`));
    const { payloads, settle } = settler(boundDistribute);
    await new BatchChannelManager({
      maxChannelsPerBatch: 8,
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    }).redeem();
    const claims = payloads.filter(payload => payload.type === "claim");
    expect(claims.map(payload => payload.claims?.length)).toEqual([4, 1]);
  });

  it("seals a closing channel with its latest voucher when a claim reports channel_closing", async () => {
    const store = new MemoryChannelStore();
    // Real 32-byte keys: the close authorization binds the channel PDA.
    const OPEN_ID = TOKEN_PROGRAM_ADDRESS;
    const CLOSING_ID = USDC_DEVNET_ADDRESS;
    await store.put(channel(OPEN_ID));
    await store.put(channel(CLOSING_ID));
    const seen: Payload[] = [];
    const settle = async (request: { payload: unknown }): Promise<SettleResponse> => {
      const raw = request.payload as Payload;
      seen.push(raw);
      if (raw.type === "claim") {
        // chan-b's payer started a forced close; the facilitator refuses the
        // whole batch, then the single chan-a claim lands.
        return raw.claims?.some(claim => claim.voucher.channelId === CLOSING_ID)
          ? {
              network: SOLANA_DEVNET_CAIP2,
              success: false,
              errorReason: BatchError.CHANNEL_CLOSING,
            }
          : ok();
      }
      return raw.type === "seal" ? { ...ok(), amount: "3000" } : boundDistribute(raw);
    };
    const result = await new BatchChannelManager({
      readPayoutWatermark: async () => 3_000n,
      readSettledWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle,
      store,
    }).redeem();
    expect(result.claimed).toEqual([OPEN_ID]);
    expect(result.sealed).toEqual([CLOSING_ID]);
    expect(seen.map(payload => payload.type)).toEqual([
      "claim",
      "claim",
      "claim",
      "seal",
      "settle",
    ]);
    const seal = seen.find(payload => payload.type === "seal") as
      | (Payload & {
          channelId: string;
          voucher: { maxClaimableAmount: string; signature: string; expiresAt: number };
          closeAuthorization: { validBefore: number; signature: string };
        })
      | undefined;
    expect(seal).toMatchObject({
      channelId: CLOSING_ID,
      voucher: { expiresAt: 0, maxClaimableAmount: "3000", signature: `sig-${CLOSING_ID}` },
    });
    // The authorization binds this channel, voucher and sponsor for the
    // receiver authorizer the server advertises.
    await expect(
      verifyCloseAuthorization(
        seal!.closeAuthorization,
        {
          channelId: CLOSING_ID,
          feePayer: RECEIVER,
          maxClaimableAmount: 3_000n,
          network: SOLANA_DEVNET_CAIP2,
          voucherExpiresAt: 0n,
        },
        receiverAuthorizer.address,
        300,
      ),
    ).resolves.toBe(true);
    expect(await store.get(CLOSING_ID)).toMatchObject({
      payoutWatermark: 3_000n,
      settled: 3_000n,
      status: "distributed",
    });
    expect((await store.get(OPEN_ID))?.status).toBe("open");
  });

  it("marks a channel closing and retries its seal after a transient failure", async () => {
    const store = new MemoryChannelStore();
    const id = (await generateKeyPairSigner()).address;
    await store.put(channel(id));
    const errors: string[] = [];
    const seen: string[] = [];
    let sealAnswer: SettleResponse = {
      errorReason: "settlement_pending",
      network: SOLANA_DEVNET_CAIP2,
      success: false,
    };
    const manager = new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: async (request: { payload: unknown }) => {
        const type = (request.payload as Payload).type;
        seen.push(type);
        if (type === "seal") return sealAnswer;
        return {
          network: SOLANA_DEVNET_CAIP2,
          success: false,
          errorReason: BatchError.CHANNEL_CLOSING,
        };
      },
      store,
    });
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [], sealed: [] });
    expect(errors).toEqual(["batch-settlement seal failed: settlement_pending"]);
    expect((await store.get(id))?.status).toBe("closing");

    sealAnswer = ok();
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [], sealed: [id] });
    expect(seen).toEqual(["claim", "seal", "seal"]);
    expect(await store.get(id)).toMatchObject({ settled: 3_000n, status: "distributed" });
  });

  it("does not seal once the grace period has elapsed", async () => {
    const store = new MemoryChannelStore();
    const id = (await generateKeyPairSigner()).address;
    const closeRequestedAt = Math.floor(Date.now() / 1000) - 900;
    await store.put(channel(id, { closeRequestedAt, status: "closing" }));
    const errors: string[] = [];
    const seen: string[] = [];
    const manager = new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async () => 0n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: async (request: { payload: unknown }) => {
        seen.push((request.payload as Payload).type);
        return ok();
      },
      store,
    });
    await manager.redeem();
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [], sealed: [] });
    expect(seen).toEqual([]);
    expect(errors).toEqual([expect.stringMatching(/grace period elapsed/)]);
    expect(await store.get(id)).toMatchObject({ settled: 0n, status: "closing" });
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
      receiverAuthorizer,
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
      new BatchChannelManager({
        readPayoutWatermark: async () => 0n,
        receiverAuthorizer,
        requirements: requirements(),
        settle,
        store,
      }).redeem(),
    ).rejects.toThrow(/vanished mid-redemption/);
  });

  it("seals a closing channel without closeAuthorization when no signer is configured", async () => {
    const store = new MemoryChannelStore();
    const id = (await generateKeyPairSigner()).address;
    await store.put(channel(id, { status: "closing" }));
    const seen: Record<string, unknown>[] = [];
    const result = await new BatchChannelManager({
      readPayoutWatermark: async () => 3_000n,
      readSettledWatermark: async () => 3_000n,
      requirements: requirements(),
      settle: async request => {
        seen.push(request.payload as Record<string, unknown>);
        return ok();
      },
      store,
    }).redeem();
    expect(result.sealed).toEqual([id]);
    const seal = seen.find(payload => payload.type === "seal");
    expect(seal).toMatchObject({ channelId: id, type: "seal" });
    expect(seal).not.toHaveProperty("closeAuthorization");
  });
});
