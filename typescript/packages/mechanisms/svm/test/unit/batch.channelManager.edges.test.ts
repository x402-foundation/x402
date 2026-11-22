import { generateKeyPairSigner } from "@solana/kit";
import { HTTPFacilitatorClient } from "@x402/core/http";
import {
  SettleError,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("batch-settlement redemption worker when the facilitator refuses a channel", () => {
  const FLAGGED = "chan-flagged";
  const SANCTIONED = "Forbidden - Sanctioned address detected";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The channels a redemption payload names, in order.
   *
   * @param raw - A claim, distribute or seal payload
   * @returns Its channel IDs
   */
  function named(raw: Payload): string[] {
    return [
      ...(raw.claims ?? []).map(claim => claim.voucher.channelId),
      ...(raw.channels ?? []).map(entry => entry.channelId),
    ];
  }

  /**
   * A bound success for a claim or a distribute.
   *
   * @param raw - The payload being answered
   * @returns The success response
   */
  function bound(raw: Payload): SettleResponse {
    if (raw.type !== "claim") return boundDistribute(raw);
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

  /**
   * A failure the facilitator answers before broadcasting anything.
   *
   * @param errorReason - Why it refused
   * @returns The failed settle response
   */
  function refusal(errorReason: string = SANCTIONED): SettleResponse {
    return { errorReason, network: SOLANA_DEVNET_CAIP2, success: false, transaction: "" };
  }

  it("claims and pays out every other channel when one claim gets an HTTP 403", async () => {
    const store = new MemoryChannelStore();
    const ids = ["chan-a", FLAGGED, "chan-c", "chan-d", "chan-e", "chan-f"];
    for (const id of ids) await store.put(channel(id));
    const seen: Payload[] = [];
    // A facilitator policy hook refuses every request naming the flagged
    // channel with a 403, which HTTPFacilitatorClient.settle throws as a
    // SettleError.
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      const raw = (JSON.parse(init.body) as { paymentPayload: { payload: Payload } }).paymentPayload
        .payload;
      seen.push(raw);
      const refused = named(raw).includes(FLAGGED);
      return new Response(JSON.stringify(refused ? refusal() : bound(raw)), {
        headers: { "Content-Type": "application/json" },
        status: refused ? 403 : 200,
      });
    });
    const client = new HTTPFacilitatorClient({ url: "https://facilitator.example" });
    const errors: string[] = [];
    const result = await new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: (payload, accepted) => client.settle(payload as unknown as PaymentPayload, accepted),
      store,
    }).redeem();

    const clean = ["chan-a", "chan-c", "chan-d", "chan-e", "chan-f"];
    expect(result).toEqual({ claimed: clean, distributed: clean, sealed: [] });
    expect(errors).toEqual([`batch-settlement claim failed: ${SANCTIONED}`]);
    // The refused batch is retried one channel at a time; the next batch and
    // the payout still run.
    expect(seen.map(raw => [raw.type, named(raw)])).toEqual([
      ["claim", ["chan-a", FLAGGED, "chan-c", "chan-d"]],
      ["claim", ["chan-a"]],
      ["claim", [FLAGGED]],
      ["claim", ["chan-c"]],
      ["claim", ["chan-d"]],
      ["claim", ["chan-e", "chan-f"]],
      ["settle", ["chan-a", "chan-c", "chan-d", "chan-e"]],
      ["settle", ["chan-f"]],
    ]);
    expect((await store.get(FLAGGED))?.settled).toBe(0n);
  });

  it("claims a refused channel on its own on later passes until it is accepted", async () => {
    const store = new MemoryChannelStore();
    const ids = ["chan-a", FLAGGED, "chan-c", "chan-d", "chan-e"];
    for (const id of ids) await store.put(channel(id));
    let refusing = true;
    const seen: Payload[] = [];
    const errors: string[] = [];
    const manager = new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async id => (await store.get(id))?.settled,
      receiverAuthorizer,
      requirements: requirements(),
      // x402Facilitator answers a beforeSettle abort with `success: false`
      // and the hook's reason.
      settle: async ({ payload }) => {
        const raw = payload as Payload;
        seen.push(raw);
        return refusing && named(raw).includes(FLAGGED)
          ? refusal("ofac_sanctioned_address")
          : bound(raw);
      },
      store,
    });
    const claims = () => seen.filter(raw => raw.type === "claim").map(named);
    const newVouchers = async (amount: bigint) => {
      for (const id of ids) {
        await store.update(id, state => ({ ...state!, signedMaxClaimable: amount }));
      }
      seen.length = 0;
    };

    expect((await manager.redeem()).claimed).toEqual(["chan-a", "chan-c", "chan-d", "chan-e"]);
    expect(claims()).toEqual([
      ["chan-a", FLAGGED, "chan-c", "chan-d"],
      ["chan-a"],
      [FLAGGED],
      ["chan-c"],
      ["chan-d"],
      ["chan-e"],
    ]);

    // The next pass packs the others and sends the refused channel alone,
    // instead of letting it fail a batch again.
    await newVouchers(4_000n);
    expect((await manager.redeem()).claimed).toEqual(["chan-a", "chan-c", "chan-d", "chan-e"]);
    expect(claims()).toEqual([["chan-a", "chan-c", "chan-d", "chan-e"], [FLAGGED]]);
    expect(errors).toEqual(Array(2).fill("batch-settlement claim failed: ofac_sanctioned_address"));

    // Once the facilitator accepts it, it is packed with the others again.
    refusing = false;
    seen.length = 0;
    expect((await manager.redeem()).claimed).toEqual([FLAGGED]);
    expect(claims()).toEqual([[FLAGGED]]);
    await newVouchers(5_000n);
    await manager.redeem();
    expect(claims()).toEqual([["chan-a", FLAGGED, "chan-c", "chan-d"], ["chan-e"]]);
  });

  it("does not single out channels when the facilitator refuses every one of them", async () => {
    const store = new MemoryChannelStore();
    const ids = ["chan-a", "chan-b", "chan-c", "chan-d"];
    for (const id of ids) await store.put(channel(id));
    const seen: Payload[] = [];
    const errors: string[] = [];
    const manager = new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      // A refusal of the request as a whole, not of one channel.
      settle: async ({ payload }) => {
        seen.push(payload as Payload);
        return refusal(BatchError.FEE_PAYER_MISMATCH);
      },
      store,
    });

    for (let pass = 0; pass < 2; pass += 1) {
      seen.length = 0;
      errors.length = 0;
      expect(await manager.redeem()).toEqual({ claimed: [], distributed: [], sealed: [] });
      // Each pass still starts from the full batch.
      expect(seen.map(named)).toEqual([ids, ...ids.map(id => [id])]);
      expect(errors).toEqual(
        Array(4).fill(`batch-settlement claim failed: ${BatchError.FEE_PAYER_MISMATCH}`),
      );
    }
  });

  const unsplittable: [string, SettleResponse | Error][] = [
    ["a pending broadcast", { ...refusal("settlement_pending"), transaction: "claim-tx" }],
    ["a duplicate already in flight", refusal("duplicate_settlement")],
    [
      "a failure that names its transaction",
      { ...refusal(BatchError.SETTLEMENT_SIMULATION), transaction: "claim-tx" },
    ],
    [
      "a thrown pending broadcast",
      new SettleError(500, { ...refusal("settlement_pending"), transaction: "claim-tx" }),
    ],
    ["a transport failure", new Error("fetch failed")],
  ];

  it.each(unsplittable)(
    "keeps a batch whole after %s and still runs the rest of the pass",
    async (_label, outcome) => {
      const store = new MemoryChannelStore();
      for (const id of ["chan-a", "chan-b", "chan-c", "chan-d", "chan-e"]) {
        await store.put(channel(id));
      }
      const seen: Payload[] = [];
      const errors: unknown[] = [];
      const result = await new BatchChannelManager({
        onError: error => errors.push(error),
        readPayoutWatermark: async () => 3_000n,
        receiverAuthorizer,
        requirements: requirements(),
        settle: async ({ payload }) => {
          const raw = payload as Payload;
          seen.push(raw);
          if (raw.type === "claim" && named(raw).includes("chan-a")) {
            if (outcome instanceof Error) throw outcome;
            return outcome;
          }
          return bound(raw);
        },
        store,
      }).redeem();

      // Splitting would put the same vouchers into new requests while the
      // first one may still land, so the batch waits for the next pass whole.
      expect(seen.map(raw => [raw.type, named(raw)])).toEqual([
        ["claim", ["chan-a", "chan-b", "chan-c", "chan-d"]],
        ["claim", ["chan-e"]],
        ["settle", ["chan-e"]],
      ]);
      expect(result).toEqual({ claimed: ["chan-e"], distributed: ["chan-e"], sealed: [] });
      expect(errors).toHaveLength(1);
      expect((await store.get("chan-a"))?.settled).toBe(0n);
    },
  );

  it("keeps claiming and paying out when a seal is refused with a thrown error", async () => {
    const store = new MemoryChannelStore();
    // A real 32-byte key: the close authorization binds the channel PDA.
    const closing = (await generateKeyPairSigner()).address;
    await store.put(channel("chan-a"));
    await store.put(channel(closing, { status: "closing" }));
    await store.put(channel("chan-c"));
    const seen: string[] = [];
    const errors: string[] = [];
    const result = await new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: async ({ payload }) => {
        const raw = payload as Payload;
        seen.push(raw.type);
        if (raw.type === "seal") throw new SettleError(403, refusal());
        return bound(raw);
      },
      store,
    }).redeem();

    expect(result).toEqual({
      claimed: ["chan-a", "chan-c"],
      distributed: ["chan-a", "chan-c"],
      sealed: [],
    });
    expect(seen).toEqual(["claim", "seal", "settle"]);
    expect(errors).toEqual([`batch-settlement seal failed: ${SANCTIONED}`]);
    expect(await store.get(closing)).toMatchObject({ settled: 0n, status: "closing" });
  });

  it("pays out every other channel when one distribute is refused with a thrown error", async () => {
    const store = new MemoryChannelStore();
    const ids = ["chan-a", FLAGGED, "chan-c", "chan-d", "chan-e"];
    // Claimed before the refusal started; only the payout is left.
    for (const id of ids) {
      await store.put(channel(id, { highestVoucherSignature: undefined, settled: 3_000n }));
    }
    const seen: Payload[] = [];
    const errors: string[] = [];
    const manager = new BatchChannelManager({
      onError: error => errors.push((error as Error).message),
      readPayoutWatermark: async () => 3_000n,
      receiverAuthorizer,
      requirements: requirements(),
      settle: async ({ payload }) => {
        const raw = payload as Payload;
        seen.push(raw);
        if (named(raw).includes(FLAGGED)) throw new SettleError(403, refusal());
        return bound(raw);
      },
      store,
    });

    expect((await manager.redeem()).distributed).toEqual(["chan-a", "chan-c", "chan-d", "chan-e"]);
    expect(seen.map(named)).toEqual([
      ["chan-a", FLAGGED, "chan-c", "chan-d"],
      ["chan-a"],
      [FLAGGED],
      ["chan-c"],
      ["chan-d"],
      ["chan-e"],
    ]);
    expect(errors).toEqual([`batch-settlement distribute failed: ${SANCTIONED}`]);
    expect((await store.get(FLAGGED))?.payoutWatermark).toBe(0n);

    // The next pass sends the refused channel on its own.
    seen.length = 0;
    await manager.redeem();
    expect(seen.map(named)).toEqual([[FLAGGED]]);
  });
});
