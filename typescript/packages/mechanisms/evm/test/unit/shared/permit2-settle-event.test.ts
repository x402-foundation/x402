import { describe, it, expect } from "vitest";
import { encodeAbiParameters, keccak256, padHex, toBytes, toHex } from "viem";
import type { TransactionReceipt } from "viem";
import { PaymentPayload } from "@x402/core/types";
import { waitAndReturnSettleResponse } from "../../../src/shared/permit2";
import {
  ErrInvalidTransactionState,
  ErrTransferEventMismatch,
} from "../../../src/exact/facilitator/errors";

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));

function makeTransferLog(opts: {
  address: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
}) {
  return {
    address: opts.address,
    topics: [TRANSFER_TOPIC, padHex(opts.from, { size: 32 }), padHex(opts.to, { size: 32 })] as [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [opts.value]),
    blockHash: padHex("0x1", { size: 32 }),
    blockNumber: 1n,
    transactionHash: padHex("0x2", { size: 32 }),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

function makeReceipt(
  status: "success" | "reverted",
  logs: ReturnType<typeof makeTransferLog>[],
): TransactionReceipt {
  return {
    status,
    logs,
    blockHash: padHex("0x1", { size: 32 }),
    blockNumber: 1n,
    transactionHash: padHex("0x2", { size: 32 }),
    transactionIndex: 0,
    cumulativeGasUsed: 0n,
    gasUsed: 0n,
    contractAddress: null,
    from: "0x0000000000000000000000000000000000000000",
    to: "0x0000000000000000000000000000000000000000",
    logsBloom: toHex(new Uint8Array(256)),
    type: "eip1559",
    effectiveGasPrice: 0n,
  } as unknown as TransactionReceipt;
}

const TOKEN: `0x${string}` = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const PAYER: `0x${string}` = "0x1111111111111111111111111111111111111111";
const RECEIVER: `0x${string}` = "0x2222222222222222222222222222222222222222";
const ATTACKER: `0x${string}` = "0x3333333333333333333333333333333333333333";
const TX: `0x${string}` = padHex("0xabc", { size: 32 });

const PAYLOAD = {
  accepted: { network: "eip155:8453" },
} as unknown as PaymentPayload;

const EXPECTED = { asset: TOKEN, from: PAYER, to: RECEIVER, value: 1000n };

function signerWith(receipt: TransactionReceipt) {
  return { waitForTransactionReceipt: async () => receipt };
}

describe("waitAndReturnSettleResponse transfer-event verification", () => {
  it("returns success when the receipt contains the expected Transfer event", async () => {
    const receipt = makeReceipt("success", [
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    const res = await waitAndReturnSettleResponse(
      signerWith(receipt),
      TX,
      PAYLOAD,
      PAYER,
      EXPECTED,
    );
    expect(res.success).toBe(true);
    expect(res.transaction).toBe(TX);
  });

  it("fails with ErrTransferEventMismatch when no Transfer event is emitted", async () => {
    const receipt = makeReceipt("success", []);
    const res = await waitAndReturnSettleResponse(
      signerWith(receipt),
      TX,
      PAYLOAD,
      PAYER,
      EXPECTED,
    );
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(ErrTransferEventMismatch);
  });

  it("fails when the token moved less than the expected value (deflationary token)", async () => {
    const receipt = makeReceipt("success", [
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 999n }),
    ]);
    const res = await waitAndReturnSettleResponse(
      signerWith(receipt),
      TX,
      PAYLOAD,
      PAYER,
      EXPECTED,
    );
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(ErrTransferEventMismatch);
  });

  it("fails when funds went to a different recipient", async () => {
    const receipt = makeReceipt("success", [
      makeTransferLog({ address: TOKEN, from: PAYER, to: ATTACKER, value: 1000n }),
    ]);
    const res = await waitAndReturnSettleResponse(
      signerWith(receipt),
      TX,
      PAYLOAD,
      PAYER,
      EXPECTED,
    );
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(ErrTransferEventMismatch);
  });

  it("ignores Transfer events emitted by a different token contract", async () => {
    const receipt = makeReceipt("success", [
      makeTransferLog({ address: ATTACKER, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    const res = await waitAndReturnSettleResponse(
      signerWith(receipt),
      TX,
      PAYLOAD,
      PAYER,
      EXPECTED,
    );
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(ErrTransferEventMismatch);
  });

  it("still reports reverted receipts as ErrInvalidTransactionState", async () => {
    const receipt = makeReceipt("reverted", []);
    const res = await waitAndReturnSettleResponse(
      signerWith(receipt),
      TX,
      PAYLOAD,
      PAYER,
      EXPECTED,
    );
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(ErrInvalidTransactionState);
  });
});
