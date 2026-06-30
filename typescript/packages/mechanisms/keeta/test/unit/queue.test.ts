import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { DuplicateBlockError, SettlementQueue } from "../../src/exact/facilitator/queue";
import type { FacilitatorKeetaSigner } from "../../src/signer";
import { KEETA_TESTNET_CAIP2 } from "../../src/constants";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { KeyPairKeyAlgorithm } from "@keetanetwork/keetanet-client/lib/account";
import type { Network } from "@x402/core/types";
import { getNewKeetaAccount } from "./utils";
import { KTA_TESTNET_ADDRESS } from "../../src/utils";

const PAYER_ACCOUNT = getNewKeetaAccount();
const RECIPIENT_ACCOUNT = getNewKeetaAccount();
const FEE_PAYER_1 = getNewKeetaAccount().publicKeyString.toString();
const FEE_PAYER_2 = getNewKeetaAccount().publicKeyString.toString();
const NETWORK: Network = KEETA_TESTNET_CAIP2;
const TESTNET_NETWORK_ID = BigInt(NETWORK.split(":")[1]);

async function buildSignedBlock(
  signerAccount: InstanceType<typeof KeetaNet.lib.Account<KeyPairKeyAlgorithm>>,
  networkId: bigint,
  operations: any[],
): Promise<InstanceType<typeof KeetaNet.lib.Block>> {
  const builder = new KeetaNet.lib.Block.Builder();
  builder.network = networkId;
  builder.account = signerAccount;
  builder.signer = signerAccount;
  builder.previous = KeetaNet.lib.Block.getAccountOpeningHash(signerAccount);
  builder.date = new Date();
  for (const op of operations) {
    builder.addOperation(op);
  }
  const block = await builder.seal();
  return block;
}

function createMockSigner(
  signerAccount: InstanceType<typeof KeetaNet.lib.Account<KeyPairKeyAlgorithm>>,
  submitBlock: FacilitatorKeetaSigner["submitBlock"],
): FacilitatorKeetaSigner {
  let client: KeetaNet.UserClient | undefined;
  const destroy = () => {
    if (client) return client.destroy();
    return Promise.resolve();
  };

  return {
    getAddresses: () => [FEE_PAYER_1, FEE_PAYER_2],
    getKeetaUserClient: (_feePayer: string, _network: Network) => {
      if (!client) client = KeetaNet.UserClient.fromNetwork("test", signerAccount);
      return client;
    },
    submitBlock,
    destroy,
    [Symbol.asyncDispose]: () => destroy(),
  };
}

describe("Keeta SettlementQueue", () => {
  let encodedBlockA: string;
  let encodedBlockB: string;
  let encodedBlockC: string;
  let hashA: string;
  let hashB: string;
  let hashC: string;

  let queue: SettlementQueue;
  let mockSubmitBlock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    // Three distinct blocks differentiated by amount
    const makeOp = (amount: string) =>
      new KeetaNet.lib.Block.Operation.SEND({
        type: KeetaNet.lib.Block.OperationType.SEND,
        to: RECIPIENT_ACCOUNT.publicKeyString.toString(),
        amount,
        token: KTA_TESTNET_ADDRESS,
      });

    const blockA = await buildSignedBlock(PAYER_ACCOUNT, TESTNET_NETWORK_ID, [makeOp("100")]);
    const blockB = await buildSignedBlock(PAYER_ACCOUNT, TESTNET_NETWORK_ID, [makeOp("200")]);
    const blockC = await buildSignedBlock(PAYER_ACCOUNT, TESTNET_NETWORK_ID, [makeOp("300")]);

    encodedBlockA = Buffer.from(blockA.toBytes(true)).toString("base64");
    encodedBlockB = Buffer.from(blockB.toBytes(true)).toString("base64");
    encodedBlockC = Buffer.from(blockC.toBytes(true)).toString("base64");

    hashA = blockA.hash.toString();
    hashB = blockB.hash.toString();
    hashC = blockC.hash.toString();
  });

  beforeEach(() => {
    mockSubmitBlock = vi.fn().mockResolvedValue(hashA);
    queue = new SettlementQueue(createMockSigner(PAYER_ACCOUNT, mockSubmitBlock));
  });

  describe("basic enqueue/resolve", () => {
    it("returns the block hash from submitBlock", async () => {
      const result = await queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK);
      expect(result).toBe(hashA);
    });

    it("calls submitBlock with correct arguments", async () => {
      await queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK);
      expect(mockSubmitBlock).toHaveBeenCalledWith(FEE_PAYER_1, encodedBlockA, NETWORK);
    });
  });

  describe("error propagation", () => {
    it("rejects when submitBlock throws", async () => {
      mockSubmitBlock.mockRejectedValue(new Error("Network error"));
      await expect(queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK)).rejects.toThrow(
        "Network error",
      );
    });

    it("rejects with an Error when submitBlock throws a non-Error", async () => {
      mockSubmitBlock.mockRejectedValue("string error");
      await expect(queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK)).rejects.toThrow(
        "string error",
      );
    });
  });

  describe("serialization per fee payer", () => {
    it("processes items sequentially for the same fee payer", async () => {
      const callOrder: string[] = [];
      let resolveFirst!: () => void;
      let resolveSecond!: () => void;

      mockSubmitBlock
        .mockImplementationOnce(
          () =>
            new Promise<string>(resolve => {
              callOrder.push("first_started");
              resolveFirst = () => {
                callOrder.push("first_resolved");
                resolve(hashA);
              };
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<string>(resolve => {
              callOrder.push("second_started");
              resolveSecond = () => {
                callOrder.push("second_resolved");
                resolve(hashB);
              };
            }),
        );

      const promise1 = queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK);
      const promise2 = queue.enqueue(FEE_PAYER_1, encodedBlockB, NETWORK);

      // Let microtasks run so the first item starts processing
      await new Promise(r => setTimeout(r, 50));

      // First should have started but second should not yet
      expect(callOrder).toContain("first_started");
      expect(callOrder).not.toContain("second_started");

      // Resolve first, second should then start
      resolveFirst();
      await promise1;
      await new Promise(r => setTimeout(r, 50));

      expect(callOrder).toContain("second_started");

      resolveSecond();
      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe(hashA);
      expect(result2).toBe(hashB);
      expect(callOrder).toEqual([
        "first_started",
        "first_resolved",
        "second_started",
        "second_resolved",
      ]);
    });

    it("processes three items in order for the same fee payer", async () => {
      const callOrder: string[] = [];

      mockSubmitBlock
        .mockImplementationOnce(() => {
          callOrder.push("A");
          return Promise.resolve(hashA);
        })
        .mockImplementationOnce(() => {
          callOrder.push("B");
          return Promise.resolve(hashB);
        })
        .mockImplementationOnce(() => {
          callOrder.push("C");
          return Promise.resolve(hashC);
        });

      const [r1, r2, r3] = await Promise.all([
        queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK),
        queue.enqueue(FEE_PAYER_1, encodedBlockB, NETWORK),
        queue.enqueue(FEE_PAYER_1, encodedBlockC, NETWORK),
      ]);

      expect([r1, r2, r3]).toEqual([hashA, hashB, hashC]);
      expect(callOrder).toEqual(["A", "B", "C"]);
    });
  });

  describe("parallelism across fee payers", () => {
    it("processes items for different fee payers concurrently", async () => {
      let resolveFirst!: () => void;
      let resolveSecond!: () => void;
      let firstStarted = false;
      let secondStarted = false;

      mockSubmitBlock.mockImplementation(
        (feePayer: string) =>
          new Promise<string>(resolve => {
            if (feePayer === FEE_PAYER_1) {
              firstStarted = true;
              resolveFirst = () => resolve(hashA);
            } else {
              secondStarted = true;
              resolveSecond = () => resolve(hashB);
            }
          }),
      );

      const promise1 = queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK);
      const promise2 = queue.enqueue(FEE_PAYER_2, encodedBlockB, NETWORK);

      await new Promise(r => setTimeout(r, 50));

      // Both should have started concurrently
      expect(firstStarted).toBe(true);
      expect(secondStarted).toBe(true);

      resolveFirst();
      resolveSecond();

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBe(hashA);
      expect(result2).toBe(hashB);
    });
  });

  describe("duplicate block rejection", () => {
    it("rejects when the same block is enqueued while still pending", async () => {
      let resolveFirst!: () => void;
      mockSubmitBlock.mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            resolveFirst = () => resolve(hashA);
          }),
      );

      const promise1 = queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK);

      // Let the first item reach the processor before trying to re-enqueue
      await new Promise(r => setTimeout(r, 50));

      await expect(queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK)).rejects.toThrow(
        DuplicateBlockError,
      );

      resolveFirst();
      await expect(promise1).resolves.toBe(hashA);
    });
  });

  describe("unknown fee payer", () => {
    it("rejects when enqueuing for a fee payer not in signer addresses", async () => {
      await expect(queue.enqueue("unknown_fee_payer", encodedBlockA, NETWORK)).rejects.toThrow(
        "No runner for unknown fee payer: unknown_fee_payer",
      );
    });
  });

  describe("destroy", () => {
    it("cleans up all runners - enqueueing after destroy throws", async () => {
      await queue.destroy();
      // runners.clear() was called, so no runner exists for any fee payer
      await expect(queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK)).rejects.toThrow(
        `No runner for unknown fee payer: ${FEE_PAYER_1}`,
      );
    });

    it("cleans up runners after a completed enqueue", async () => {
      await queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK);
      await queue.destroy();
      await expect(queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK)).rejects.toThrow(
        `No runner for unknown fee payer: ${FEE_PAYER_1}`,
      );
    });

    it("rejects queued-but-not-yet-started promises with 'Settlement queue destroyed'", async () => {
      // Hold the first item so a second enqueue is queued but not yet started
      let resolveFirst!: () => void;
      mockSubmitBlock
        .mockImplementationOnce(
          () =>
            new Promise<string>(resolve => {
              resolveFirst = () => resolve(hashA);
            }),
        )
        .mockImplementationOnce(() => Promise.resolve(hashB));

      const promise1 = queue.enqueue(FEE_PAYER_1, encodedBlockA, NETWORK);
      const promise2 = queue.enqueue(FEE_PAYER_1, encodedBlockB, NETWORK);

      // Let the first item start; the second is queued behind it
      await new Promise(r => setTimeout(r, 50));

      // Destroy rejects pending promises that haven't started yet
      const destroyPromise = queue.destroy();
      // unblock the first item so destroy() can finish
      resolveFirst();
      await destroyPromise;

      await expect(promise1).resolves.toBeDefined();
      await expect(promise2).rejects.toThrow("Settlement queue destroyed");
    });
  });
});
