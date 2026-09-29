/** Single-use server-mode request records, separate from channel accounting. */

export type BatchOperation =
  | {
      status: "reserved";
      channelId: string;
      requestId: string;
      ceiling: bigint;
    }
  | {
      status: "completed";
      channelId: string;
      requestId: string;
      ceiling: bigint;
      actual: bigint;
      cumulative: bigint;
    };

export interface BatchOperationStore {
  /** Fetch a reserved or completed request operation. */
  get(channelId: string, requestId: string): Promise<BatchOperation | undefined>;
  /** Atomically create a request reservation unless the operation already exists. */
  reserve(
    channelId: string,
    requestId: string,
    ceiling: bigint,
  ): Promise<{ created: boolean; operation: BatchOperation }>;
  /** Atomically mark a reservation completed so the request cannot be reused. */
  complete(operation: Extract<BatchOperation, { status: "completed" }>): Promise<void>;
  /** End failed or canceled work while retaining the consumed request id. */
  release(channelId: string, requestId: string): Promise<void>;
}

/** In-memory operation store used by the reference implementation. */
export class MemoryBatchOperationStore implements BatchOperationStore {
  private readonly operations = new Map<string, BatchOperation>();
  private readonly locks = new Map<string, Promise<unknown>>();

  /** @inheritdoc */
  get(channelId: string, requestId: string): Promise<BatchOperation | undefined> {
    return Promise.resolve(this.operations.get(operationKey(channelId, requestId)));
  }

  /** @inheritdoc */
  reserve(
    channelId: string,
    requestId: string,
    ceiling: bigint,
  ): Promise<{ created: boolean; operation: BatchOperation }> {
    return this.withLock(channelId, requestId, () => {
      const key = operationKey(channelId, requestId);
      const existing = this.operations.get(key);
      if (existing && existing.ceiling !== ceiling) {
        throw new Error("batch operation ceiling changed for a request id");
      }
      if (existing) return { created: false, operation: existing };
      const operation: BatchOperation = {
        status: "reserved",
        channelId,
        requestId,
        ceiling,
      };
      this.operations.set(key, operation);
      return { created: true, operation };
    });
  }

  /** @inheritdoc */
  complete(operation: Extract<BatchOperation, { status: "completed" }>): Promise<void> {
    return this.withLock(operation.channelId, operation.requestId, () => {
      const key = operationKey(operation.channelId, operation.requestId);
      const existing = this.operations.get(key);
      if (!existing || existing.status !== "reserved" || existing.ceiling !== operation.ceiling) {
        throw new Error("batch operation reservation changed");
      }
      this.operations.set(key, operation);
    });
  }

  /** @inheritdoc */
  release(channelId: string, requestId: string): Promise<void> {
    return this.withLock(channelId, requestId, () => {
      // The capacity reservation is released by the channel store. Keep this
      // record as a tombstone so a failed HTTP request cannot reuse its id.
    });
  }

  /**
   * Run one operation-key mutation at a time.
   *
   * @param channelId - Channel identifier
   * @param requestId - Request identifier
   * @param operation - Mutation to serialize
   * @returns The mutation result
   */
  private async withLock<T>(
    channelId: string,
    requestId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const key = operationKey(channelId, requestId);
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(operation);
    this.locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/**
 * Build the collision-free in-memory key for one request operation.
 *
 * @param channelId - Channel identifier
 * @param requestId - Request identifier
 * @returns Internal map key
 */
function operationKey(channelId: string, requestId: string): string {
  return `${channelId}\u0000${requestId}`;
}
