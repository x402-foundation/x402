import { generateKeyPairSigner } from "@solana/kit";
import type { SettleResponse } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";

import { BatchChannelManager } from "../../src/batch-settlement/server/channelManager";
import { REDEMPTION_TIMEOUT_SECONDS } from "../../src/batch-settlement/server/constants";
import { BatchSvmScheme } from "../../src/batch-settlement/server/scheme";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import type { ChannelState } from "../../src/batch-settlement/server/types";
import {
  SOLANA_DEVNET_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const RECEIVER = USDC_MAINNET_ADDRESS;
const receiverAuthorizer = await generateKeyPairSigner();
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
      network: SOLANA_DEVNET_CAIP2,
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
        network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
      settle: pending.settle,
      store,
    }).redeem();
    expect((await store.get("chan-a"))?.settled).toBe(0n);

    const retry = recorder();
    const result = await new BatchChannelManager({
      readPayoutWatermark: async () => 3000n,
      receiverAuthorizer,
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
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
      network: SOLANA_DEVNET_CAIP2,
      settle,
      store,
    });
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [], sealed: [id] });
    expect(submitted.map(s => s.type)).toEqual(["seal"]);
    expect((await store.get(id))?.status).toBe("distributed");
  });

  describe("per-channel redemption terms", () => {
    type Submitted = { type: string; channels: string[]; accepted: PaymentRequirements };

    /** Records each request with the requirements it was authored against. */
    function termsRecorder() {
      const submitted: Submitted[] = [];
      const settle = async (
        request: { payload: unknown; accepted: PaymentRequirements },
        requirements: PaymentRequirements,
      ): Promise<SettleResponse> => {
        const raw = request.payload as RedemptionPayload;
        expect(request.accepted).toBe(requirements);
        submitted.push({
          accepted: requirements,
          channels: (raw.claims ?? [])
            .map(c => c.voucher.channelId)
            .concat((raw.channels ?? []).map(c => c.channelId)),
          type: raw.type,
        });
        return recovered(raw);
      };
      return { settle, submitted };
    }

    it("redeems channels opened under different fee payers in one pass, one batch per fee payer", async () => {
      const store = new MemoryChannelStore();
      const otherFeePayer = USDC_DEVNET_ADDRESS;
      await store.put(channel("chan-a"));
      await store.put(channel("chan-b", { feePayer: otherFeePayer }));
      await store.put(channel("chan-c"));
      const { settle, submitted } = termsRecorder();

      const result = await new BatchChannelManager({
        network: SOLANA_DEVNET_CAIP2,
        readPayoutWatermark: async () => 3_000n,
        receiverAuthorizer,
        settle,
        store,
      }).redeem();

      expect(result.claimed.sort()).toEqual(["chan-a", "chan-b", "chan-c"]);
      expect(result.distributed.sort()).toEqual(["chan-a", "chan-b", "chan-c"]);
      const byType = (type: string) =>
        submitted
          .filter(entry => entry.type === type)
          .map(entry => ({ channels: entry.channels, feePayer: entry.accepted.extra?.feePayer }));
      for (const type of ["claim", "settle"]) {
        expect(byType(type)).toEqual([
          { channels: ["chan-a", "chan-c"], feePayer: RECEIVER },
          { channels: ["chan-b"], feePayer: otherFeePayer },
        ]);
      }
    });

    it.each([
      ["receiver", { receiver: TOKEN_PROGRAM_ADDRESS }, { payTo: TOKEN_PROGRAM_ADDRESS }],
      ["mint", { mint: USDC_MAINNET_ADDRESS }, { asset: USDC_MAINNET_ADDRESS }],
      [
        "token program",
        { tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
        { extra: { tokenProgram: TOKEN_2022_PROGRAM_ADDRESS } },
      ],
      ["withdraw delay", { withdrawDelay: 1_800 }, { extra: { withdrawDelay: 1_800 } }],
    ] as const)(
      "never mixes channels with a different %s in one batch",
      async (_name, override, expected) => {
        const store = new MemoryChannelStore();
        await store.put(channel("chan-a"));
        await store.put(channel("chan-b", override));
        const { settle, submitted } = termsRecorder();

        await new BatchChannelManager({
          network: SOLANA_DEVNET_CAIP2,
          readPayoutWatermark: async () => 3_000n,
          receiverAuthorizer,
          settle,
          store,
        }).redeem();

        const claims = submitted.filter(entry => entry.type === "claim");
        expect(claims.map(entry => entry.channels)).toEqual([["chan-a"], ["chan-b"]]);
        expect(claims[1]!.accepted).toMatchObject(expected);
      },
    );

    it("authors requirements from stored channel state", async () => {
      const store = new MemoryChannelStore();
      await store.put(channel("chan-a"));
      const { settle, submitted } = termsRecorder();

      await new BatchChannelManager({
        network: SOLANA_DEVNET_CAIP2,
        readPayoutWatermark: async () => 3_000n,
        receiverAuthorizer,
        settle,
        store,
      }).redeem();

      expect(submitted[0]!.accepted).toEqual({
        amount: "0",
        asset: USDC_DEVNET_ADDRESS,
        extra: {
          feePayer: RECEIVER,
          receiverAuthorizer: receiverAuthorizer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          withdrawDelay: 900,
        },
        maxTimeoutSeconds: REDEMPTION_TIMEOUT_SECONDS,
        network: SOLANA_DEVNET_CAIP2,
        payTo: RECEIVER,
        scheme: "batch-settlement",
      });
    });

    it("names the operator for a server-signed channel", async () => {
      const store = new MemoryChannelStore();
      await store.put(
        channel("chan-a", {
          channelConfig: { ...channel("chan-a").channelConfig, voucherSigner: "server" },
        }),
      );
      const { settle, submitted } = termsRecorder();

      await new BatchChannelManager({
        network: SOLANA_DEVNET_CAIP2,
        readPayoutWatermark: async () => 3_000n,
        receiverAuthorizer,
        settle,
        store,
      }).redeem();

      expect(submitted[0]!.accepted.extra).toMatchObject({
        operator: USDC_DEVNET_ADDRESS,
        voucherSigner: "server",
      });
    });

    it("sizes batches from the capacity the facilitator advertised to the scheme", async () => {
      const scheme = new BatchSvmScheme({ receiverAuthorizer, store: new MemoryChannelStore() });
      const { settle, submitted } = termsRecorder();
      const manager = scheme.createChannelManager({ settle } as never, SOLANA_DEVNET_CAIP2, {
        readPayoutWatermark: async () => 3_000n,
      });
      for (let index = 0; index < 5; index += 1) {
        await scheme.getChannelStore().put(channel(`chan-${index}`));
      }

      // Before the scheme sees `/supported`, the default of four applies.
      await manager.redeem();
      expect(
        submitted.filter(entry => entry.type === "claim").map(entry => entry.channels.length),
      ).toEqual([4, 1]);

      expect(
        scheme.validateFacilitatorSupport(
          SOLANA_DEVNET_CAIP2,
          {
            extra: { feePayer: RECEIVER, maxClaimChannels: 2, maxSettleChannels: 3 },
            network: SOLANA_DEVNET_CAIP2,
            scheme: "batch-settlement",
            x402Version: 2,
          },
          [],
        ),
      ).toBeUndefined();
      submitted.length = 0;
      const store = scheme.getChannelStore();
      for (let index = 0; index < 5; index += 1) {
        await store.update(`chan-${index}`, current => ({
          ...current!,
          payoutWatermark: 0n,
          settled: 0n,
        }));
      }
      await manager.redeem();
      const sizes = (type: string) =>
        submitted.filter(entry => entry.type === type).map(entry => entry.channels.length);
      expect(sizes("claim")).toEqual([2, 2, 1]);
      expect(sizes("settle")).toEqual([3, 2]);
    });
  });
});
