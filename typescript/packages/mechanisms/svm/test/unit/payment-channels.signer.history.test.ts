import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMocks = vi.hoisted(() => ({
  getSignaturesForAddressSend: vi.fn(),
  getTransactionSend: vi.fn(),
}));

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: vi.fn(() => ({
      getSignaturesForAddress: () => ({ send: rpcMocks.getSignaturesForAddressSend }),
      getTransaction: () => ({ send: rpcMocks.getTransactionSend }),
    })),
  };
});

import {
  createReceiverBindingHistoryReader,
  receiverBindingHistoryReaderFromSigner,
} from "../../src/batch-settlement/facilitator/receiverBindingHistoryReader";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { channelHistoryReads } from "../../src/payment-channels/signer";

const CHANNEL = USDC_MAINNET_ADDRESS;
const SIGNATURE = USDC_DEVNET_ADDRESS;

describe("channelHistoryReads", () => {
  beforeEach(() => {
    rpcMocks.getSignaturesForAddressSend.mockReset();
    rpcMocks.getTransactionSend.mockReset();
  });

  it("pages signatures and reads base64 transaction bytes", async () => {
    rpcMocks.getSignaturesForAddressSend.mockResolvedValue([{ err: null, signature: "sig-1" }]);
    rpcMocks.getTransactionSend.mockResolvedValue({
      transaction: ["dGVzdA=="],
    });

    const reads = channelHistoryReads({ [SOLANA_DEVNET_CAIP2]: "https://history.example" });
    const page = await reads.getSignaturesForAddress(CHANNEL, SOLANA_DEVNET_CAIP2, {
      before: SIGNATURE,
      limit: 5,
    });
    expect(page).toEqual([{ err: null, signature: "sig-1" }]);

    await expect(reads.getTransaction(SIGNATURE, SOLANA_DEVNET_CAIP2)).resolves.toBe("dGVzdA==");
  });

  it("returns null when the transaction is missing or not base64 wire", async () => {
    const reads = channelHistoryReads();
    rpcMocks.getTransactionSend.mockResolvedValueOnce(null);
    await expect(reads.getTransaction(SIGNATURE, SOLANA_DEVNET_CAIP2)).resolves.toBeNull();

    rpcMocks.getTransactionSend.mockResolvedValueOnce({ transaction: [123] });
    await expect(
      reads.getTransaction(USDC_MAINNET_ADDRESS, SOLANA_DEVNET_CAIP2),
    ).resolves.toBeNull();
  });
});

describe("receiver binding history reader factories", () => {
  beforeEach(() => {
    rpcMocks.getSignaturesForAddressSend.mockReset();
    rpcMocks.getTransactionSend.mockReset();
  });

  it("returns undefined when the signer lacks history reads", () => {
    expect(receiverBindingHistoryReaderFromSigner({} as never)).toBeUndefined();
    expect(
      receiverBindingHistoryReaderFromSigner({ getSignaturesForAddress: vi.fn() } as never),
    ).toBeUndefined();
  });

  it("adapts signer history reads", async () => {
    const getSignaturesForAddress = vi.fn(async () => [{ err: null, signature: "s" }]);
    const getTransaction = vi.fn(async () => "wire");
    const historyReader = receiverBindingHistoryReaderFromSigner({
      getSignaturesForAddress,
      getTransaction,
    } as never);

    expect(historyReader).toBeDefined();
    await expect(
      historyReader!.getSignaturesForAddress(SOLANA_DEVNET_CAIP2, CHANNEL),
    ).resolves.toEqual([{ err: null, signature: "s" }]);
    expect(getSignaturesForAddress).toHaveBeenCalledWith(CHANNEL, SOLANA_DEVNET_CAIP2, undefined);

    await expect(historyReader!.getTransaction(SOLANA_DEVNET_CAIP2, "s")).resolves.toBe("wire");
    expect(getTransaction).toHaveBeenCalledWith("s", SOLANA_DEVNET_CAIP2);
  });

  it("createReceiverBindingHistoryReader reads through RPC history", async () => {
    rpcMocks.getSignaturesForAddressSend.mockResolvedValue([]);
    const historyReader = createReceiverBindingHistoryReader();
    await historyReader.getSignaturesForAddress(SOLANA_DEVNET_CAIP2, CHANNEL);
    expect(rpcMocks.getSignaturesForAddressSend).toHaveBeenCalled();
  });
});
