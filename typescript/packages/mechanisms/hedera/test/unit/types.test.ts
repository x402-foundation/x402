import { describe, expect, it } from "vitest";
import type {
  ExactHederaPayloadV2,
  HederaTransferEntry,
  InspectedHederaTransaction,
} from "../../src";

describe("Hedera types", () => {
  it("accepts exact payload", () => {
    const payload: ExactHederaPayloadV2 = { transaction: "dGVzdA==" };
    expect(payload.transaction).toBe("dGVzdA==");
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
