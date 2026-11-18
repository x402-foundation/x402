import * as KeetaNet from "@keetanetwork/keetanet-client";
import {
  KeetaAnchorQueueRunnerJSON,
  KeetaAnchorQueueStorageDriverMemory,
  type KeetaAnchorQueueEntry,
  type KeetaAnchorQueueRequestID,
  type KeetaAnchorQueueStorageDriver,
} from "@keetanetwork/anchor/lib/queue/index.js";
import type { JSONSerializable } from "@keetanetwork/keetanet-client/lib/utils/conversion";
import type { Network } from "@x402/core/types";
import type { FacilitatorKeetaSigner } from "../../signer";
import { Logger } from "@keetanetwork/keetanet-client/lib/log";

type SettlementRequest = {
  feePayer: string;
  encodedBlock: string;
  network: Network;
};

type SettlementResult = {
  blockHash: string;
};

type PendingSettlement = {
  resolve: (blockHash: string) => void;
  reject: (error: Error) => void;
};

type RunnerEntry = {
  runner: SettlementQueueRunner;
  isRunning: boolean;
};

/**
 * Thrown when a block is submitted while an identical block is still in flight.
 */
export class DuplicateBlockError extends Error {
  /**
   * Creates a new DuplicateBlockError.
   */
  constructor() {
    super("duplicate_block");
    this.name = "DuplicateBlockError";
  }
}

/**
 * Queue runner that processes settlement requests by submitting blocks to the Keeta network.
 */
class SettlementQueueRunner extends KeetaAnchorQueueRunnerJSON<
  SettlementRequest,
  SettlementResult
> {
  /**
   * Creates a new SettlementQueueRunner instance.
   *
   * @param queue - The queue storage driver to use
   * @param signer - The Keeta client for facilitator operations
   * @param pendingPromises - Shared map of pending promise callbacks keyed by queue entry ID
   */
  constructor(
    queue: KeetaAnchorQueueStorageDriver<JSONSerializable, JSONSerializable>,
    private readonly signer: FacilitatorKeetaSigner,
    private readonly pendingPromises: Map<KeetaAnchorQueueRequestID, PendingSettlement>,
  ) {
    super({ queue });
    this.setConfiguration({
      maxRetries: 0,
      batchSize: 1,
      processTimeout: 60_000,
    });
  }

  /**
   * Processes a settlement request by submitting the block to the Keeta network.
   *
   * @param entry - The queue entry containing the settlement request
   * @returns Promise resolving to the processing result with status and block hash output
   */
  protected async processor(
    entry: KeetaAnchorQueueEntry<SettlementRequest, SettlementResult>,
  ): Promise<{
    status: "completed" | "failed_permanently";
    output: SettlementResult | null;
    error?: string;
  }> {
    const pending = this.pendingPromises.get(entry.id);
    if (!pending) {
      throw new Error(`Tried to process a block that's not pending anymore: ${String(entry.id)}`);
    }

    try {
      const blockHash = await this.signer.submitBlock(
        entry.request.feePayer,
        entry.request.encodedBlock,
        entry.request.network,
      );
      // Remove the pending promise after the block has been processed to allow for the duplicate check.
      this.pendingPromises.delete(entry.id);
      pending.resolve(blockHash);
      return { status: "completed", output: { blockHash } };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.pendingPromises.delete(entry.id);
      pending.reject(error);
      return { status: "failed_permanently", output: null, error: error.message };
    }
  }
}

/**
 * A per-fee-payer settlement queue that serializes block submissions to the Keeta network.
 *
 * Each fee payer account gets its own queue runner, ensuring that blocks are submitted
 * sequentially per account DAG while allowing parallelism across different fee payers.
 */
export class SettlementQueue {
  private readonly runners = new Map<string, Promise<RunnerEntry>>();
  private readonly pendingPromises = new Map<KeetaAnchorQueueRequestID, PendingSettlement>();
  private readonly storage = new KeetaAnchorQueueStorageDriverMemory();
  private readonly logger: Logger | undefined;

  /**
   * Creates a new SettlementQueue instance.
   * A queue runner is eagerly created for every fee payer address reported by the signer.
   *
   * @param signer - The Keeta client for facilitator operations
   * @param logger - Optional logger
   */
  constructor(signer: FacilitatorKeetaSigner, logger?: Logger) {
    for (const address of signer.getAddresses()) {
      this.runners.set(address, this.createRunner(address, signer));
    }
    this.logger = logger;
  }

  /**
   * Enqueues a block for settlement via the specified fee payer.
   * The block is processed sequentially with respect to other blocks for the same fee payer.
   *
   * Submitting the same block twice while it is still pending will throw a `duplicate_block` error.
   * Re-submitting an already-settled block will result in an error once the block is attempted to
   * be submitted to the network as blocks are required to be unique.
   *
   * @param feePayer - The fee payer address to use
   * @param encodedBlock - The Base64-encoded signed block
   * @param network - The network identifier
   * @returns The block hash from the submitted transaction
   */
  async enqueue(feePayer: string, encodedBlock: string, network: Network): Promise<string> {
    const blockId = new KeetaNet.lib.Block(
      encodedBlock,
    ).hash.toString() as unknown as KeetaAnchorQueueRequestID;

    if (this.pendingPromises.has(blockId)) {
      throw new DuplicateBlockError();
    }

    const runnerEntry = await this.getRunner(feePayer);

    let resolve!: (blockHash: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // Add block to pending promises before enqueuing the job to ensure that a runner that's
    // currently processing can immediately find this promise and doesn't think that
    // the job is not pending anymore.
    this.pendingPromises.set(blockId, { resolve, reject });
    try {
      await runnerEntry.runner.add({ feePayer, encodedBlock, network }, { id: blockId });
    } catch (error) {
      this.pendingPromises.delete(blockId);
      throw error;
    }

    this.triggerDrain(runnerEntry);

    return promise;
  }

  /**
   * Destroys all queue runners and rejects any pending promises.
   */
  async destroy(): Promise<void> {
    for (const [, entryPromise] of this.runners) {
      const entry = await entryPromise;
      await entry.runner.destroy();
    }
    this.runners.clear();

    for (const [id, pending] of this.pendingPromises) {
      pending.reject(new Error("Settlement queue destroyed"));
      this.pendingPromises.delete(id);
    }
  }

  /**
   * Returns the queue runner for the specified fee payer account.
   *
   * @param feePayer - The fee payer Keeta account public key
   * @returns RunnerEntry for the fee payer
   * @throws If no runner exists for the given fee payer
   */
  private getRunner(feePayer: string): Promise<RunnerEntry> {
    const entry = this.runners.get(feePayer);
    if (!entry) {
      throw new Error(`No runner for unknown fee payer: ${feePayer}`);
    }
    return entry;
  }

  /**
   * Creates a runner for the specified fee payer by partitioning the shared storage.
   *
   * @param feePayer - The fee payer Keeta account public key
   * @param signer - The Keeta client for facilitator operations
   * @returns Promise resolving to the new RunnerEntry instance
   */
  private async createRunner(
    feePayer: string,
    signer: FacilitatorKeetaSigner,
  ): Promise<RunnerEntry> {
    const partition = await this.storage.partition(feePayer);
    const runner = new SettlementQueueRunner(partition, signer, this.pendingPromises);
    return { runner, isRunning: false };
  }

  /**
   * Triggers a drain loop for the given runner entry if one is not already running.
   * The loop calls `run()` repeatedly until no more pending items remain.
   *
   * @param entry - The runner entry to drain
   */
  private triggerDrain(entry: RunnerEntry): void {
    if (entry.isRunning) {
      return;
    }
    entry.isRunning = true;

    void (async () => {
      try {
        while (await entry.runner.run()) {
          // continue draining
        }
      } catch (err) {
        this.logger?.error("Settlement queue drain error:", err);
      } finally {
        entry.isRunning = false;
      }
    })();
  }
}
