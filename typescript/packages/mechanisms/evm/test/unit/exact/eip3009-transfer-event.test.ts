import { describe, it, expect } from "vitest";
import { encodeAbiParameters, keccak256, padHex, toBytes, toHex } from "viem";
import type { TransactionReceipt } from "viem";
import { verifyEip3009TransferEvent } from "../../../src/exact/facilitator/eip3009-utils";

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

function makeReceipt(logs: ReturnType<typeof makeTransferLog>[]): TransactionReceipt {
  return {
    status: "success",
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
const OTHER_TOKEN: `0x${string}` = "0x0000000000000000000000000000000000000bad";
const PAYER: `0x${string}` = "0x1111111111111111111111111111111111111111";
const RECEIVER: `0x${string}` = "0x2222222222222222222222222222222222222222";
const ATTACKER: `0x${string}` = "0x3333333333333333333333333333333333333333";

describe("verifyEip3009TransferEvent", () => {
  it("matches a canonical Transfer event", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(true);
  });

  it("matches even when other unrelated logs are present", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: OTHER_TOKEN, from: ATTACKER, to: RECEIVER, value: 999n }),
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(true);
  });

  it("rejects when value differs", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: RECEIVER, value: 1n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when recipient differs", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: PAYER, to: ATTACKER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when sender differs", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: TOKEN, from: ATTACKER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when the only Transfer log is from a different token contract", () => {
    const receipt = makeReceipt([
      makeTransferLog({ address: OTHER_TOKEN, from: PAYER, to: RECEIVER, value: 1000n }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("rejects when receipt has no logs at all", () => {
    const receipt = makeReceipt([]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(false);
  });

  it("address comparison is case-insensitive", () => {
    const receipt = makeReceipt([
      makeTransferLog({
        address: TOKEN.toLowerCase() as `0x${string}`,
        from: PAYER.toUpperCase().replace("0X", "0x") as `0x${string}`,
        to: RECEIVER,
        value: 1000n,
      }),
    ]);
    expect(
      verifyEip3009TransferEvent(receipt.logs, TOKEN, {
        from: PAYER,
        to: RECEIVER,
        value: 1000n,
      }),
    ).toBe(true);
  });
});
