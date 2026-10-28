import { describe, expect, it } from "vitest";
import {
  isCryptoTransferPayload,
  isTransferExecutorPayload,
  type ExactHederaPayload,
  type ExactHederaPayloadV2,
  type HederaTransferEntry,
  type InspectedHederaTransaction,
} from "../../src";

describe("Hedera types", () => {
  it("accepts exact payload", () => {
    const payload: ExactHederaPayloadV2 = { transaction: "dGVzdA==" };
    expect(payload.transaction).toBe("dGVzdA==");
  });

  it("tells the two ExactHederaPayload shapes apart with the guards", () => {
    const payloads: ExactHederaPayload[] = [
      { transaction: "dGVzdA==" },
      { payer: "0.0.9001", executor: "0.0.7000", authorization: "0xabcdef" },
    ];

    const described = payloads.map(payload => {
      if (isTransferExecutorPayload(payload)) {
        return `transferExecutor via ${payload.executor}`;
      }
      return isCryptoTransferPayload(payload) ? `cryptoTransfer ${payload.transaction}` : "neither";
    });

    expect(described).toEqual(["cryptoTransfer dGVzdA==", "transferExecutor via 0.0.7000"]);
  });

  it("accepts transfer entries", () => {
    const entry: HederaTransferEntry = { accountId: "0.0.1001", amount: "-10" };
    expect(entry.accountId).toBe("0.0.1001");
  });

  it("accepts inspected transaction shape", () => {
    const tx: InspectedHederaTransaction = {
      transactionType: "TransferTransaction",
      transactionId: "0.0.10@1700000000.000000000",
      transactionIdAccountId: "0.0.10",
      hasNonTransferOperations: false,
      hbarTransfers: [],
      tokenTransfers: {},
    };
    expect(tx.transactionType).toBe("TransferTransaction");
  });
});
