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

/** Records what the worker submitted, answering however the test asks. */
function recorder(answer: (type: string) => SettleResponse = () => ok()) {
  const submitted: { type: string; channels: string[] }[] = [];
  const settle = async (payload: { payload: unknown }): Promise<SettleResponse> => {
    const raw = payload.payload as {
      type: string;
      claims?: { voucher: { channelId: string } }[];
      channels?: { channelId: string }[];
    };
    submitted.push({
      channels: (raw.claims ?? [])
        .map(c => c.voucher.channelId)
        .concat((raw.channels ?? []).map(c => c.channelId)),
      type: raw.type,
    });
    return answer(raw.type);
  };
  return { settle, submitted };
}

function ok(): SettleResponse {
  return { network: SOLANA_DEVNET_CAIP2, success: true, transaction: "sig" };
}

describe("batch-settlement redemption worker", () => {
  it("claims unclaimed vouchers, then distributes what they settled", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a"));
    // Already claimed to 3000 but never paid out.
    await store.put(channel("chan-b", { settled: 3_000n }));
    // Nothing owed: claimed and distributed.
    await store.put(channel("chan-c", { payoutWatermark: 3_000n, settled: 3_000n }));
    const { settle, submitted } = recorder();

    const manager = new BatchChannelManager({ requirements: requirements(), settle, store });
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
    const manager = new BatchChannelManager({ requirements: requirements(), settle, store });

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
    const { settle } = recorder(type =>
      type === "claim"
        ? {
            errorReason: "settlement_pending",
            network: SOLANA_DEVNET_CAIP2,
            success: false,
            transaction: "",
          }
        : ok(),
    );
    const manager = new BatchChannelManager({
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

  it("skips channels that are closing", async () => {
    const store = new MemoryChannelStore();
    await store.put(channel("chan-a", { status: "closing" }));
    const { settle, submitted } = recorder();
    const manager = new BatchChannelManager({ requirements: requirements(), settle, store });
    expect(await manager.redeem()).toEqual({ claimed: [], distributed: [] });
    expect(submitted).toEqual([]);
  });
});
