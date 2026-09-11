import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  encodeBatchSettlementReceiptMessage,
  signBatchSettlementReceipt,
  verifyBatchSettlementReceipt,
} from "../../src/batch-settlement/receipt";
import { MemoryBatchOperationStore } from "../../src/batch-settlement/server/operationStore";
import type { BatchVoucher } from "../../src/batch-settlement/types";
import { USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { signVoucher } from "../../src/payment-channels/voucher";

async function fixture() {
  const operator = await generateKeyPairSigner();
  const channel = await generateKeyPairSigner();
  const voucher: BatchVoucher = {
    channelId: channel.address,
    expiresAt: 0,
    maxClaimableAmount: "500",
    signature: await signVoucher(operator, {
      channelId: channel.address,
      cumulativeAmount: 500n,
      expiresAt: 0n,
    }),
  };
  const receipt = await signBatchSettlementReceipt(operator, {
    authorizedAmount: 1_000n,
    channelId: channel.address,
    chargedAmount: 500n,
    cumulativeAmount: 500n,
    idempotencyKey: "request-1",
    priorCumulativeAmount: 0n,
    voucher,
  });
  return { channel, operator, receipt };
}

describe("batch server-mode receipts", () => {
  it("signs every itemized accounting field", async () => {
    const { operator, receipt } = await fixture();
    expect(await verifyBatchSettlementReceipt(receipt, operator.address)).toBe(true);

    for (const patch of [
      { channelId: USDC_MAINNET_ADDRESS },
      { idempotencyKey: "request-2" },
      { authorizedAmount: "999" },
      { chargedAmount: "499" },
      { priorCumulativeAmount: "1" },
      { cumulativeAmount: "501" },
      { signature: USDC_MAINNET_ADDRESS },
    ]) {
      expect(await verifyBatchSettlementReceipt({ ...receipt, ...patch }, operator.address)).toBe(
        false,
      );
    }
  });

  it("rejects invalid receipt encodings", () => {
    expect(() =>
      encodeBatchSettlementReceiptMessage({
        authorizedAmount: 1n,
        channelId: "bad",
        chargedAmount: 1n,
        cumulativeAmount: 1n,
        idempotencyKey: "request-1",
        priorCumulativeAmount: 0n,
      }),
    ).toThrow("channelId");
    expect(() =>
      encodeBatchSettlementReceiptMessage({
        authorizedAmount: 1n,
        channelId: USDC_MAINNET_ADDRESS,
        chargedAmount: 1n,
        cumulativeAmount: 1n,
        idempotencyKey: "",
        priorCumulativeAmount: 0n,
      }),
    ).toThrow("idempotencyKey");
  });
});

describe("MemoryBatchOperationStore", () => {
  it("atomically reserves one operation per idempotency key", async () => {
    const store = new MemoryBatchOperationStore();
    const [first, second] = await Promise.all([
      store.reserve("channel", "request", 1_000n, Date.now() + 10_000),
      store.reserve("channel", "request", 1_000n, Date.now() + 10_000),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    await expect(store.reserve("channel", "request", 999n, Date.now() + 10_000)).rejects.toThrow(
      "ceiling changed",
    );
  });

  it("releases failed work and replays completed work", async () => {
    const store = new MemoryBatchOperationStore();
    await store.reserve("channel", "request", 1_000n, Date.now() + 10_000);
    await store.release("channel", "request");
    expect((await store.reserve("channel", "request", 1_000n, Date.now() + 10_000)).created).toBe(
      true,
    );

    const { receipt } = await fixture();
    const response = {
      amount: "",
      network: "solana:devnet",
      success: true,
      transaction: "",
    } as const;
    await store.complete({
      actual: 500n,
      ceiling: 1_000n,
      channelId: "channel",
      cumulative: 500n,
      idempotencyKey: "request",
      receipt,
      response,
      status: "completed",
    });
    const replay = await store.reserve("channel", "request", 1_000n, Date.now() + 10_000);
    expect(replay).toMatchObject({ created: false, operation: { status: "completed", response } });
    await store.release("channel", "request");
    expect((await store.get("channel", "request"))?.status).toBe("completed");
  });
});
