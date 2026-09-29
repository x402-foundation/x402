import {
  DEFAULT_SETTLEMENT_BATCH_FLUSH_INTERVAL_SECONDS,
  DEFAULT_SETTLEMENT_BATCH_FLUSH_SIZE,
  DEFAULT_SETTLEMENT_BATCH_MAX_SIZE,
  DEFAULT_TRACE_CONFIRMATION_TIMEOUT_SECONDS,
  ERR_EXACT_TVM_TRANSACTION_FAILED,
} from "../constants";
import type { SettlementCache } from "../settlement-cache";
import type { FacilitatorTvmSigner } from "../signer";
import type { ParsedTvmSettlement, TvmRelayRequest } from "../types";

export interface BatchResult {
  success: boolean;
  transaction?: string;
  errorReason?: string;
  errorMessage?: string;
}

export interface QueuedSettlement {
  network: string;
  settlementHash: string;
  settlement: ParsedTvmSettlement;
  relayRequest: TvmRelayRequest;
}

type PendingSettlement = QueuedSettlement & {
  resolve: (result: BatchResult) => void;
};

export class SettlementBatcher {
  private readonly queues = new Map<string, PendingSettlement[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly signer: FacilitatorTvmSigner,
    private readonly settlementCache: SettlementCache,
    private readonly options: {
      flushIntervalSeconds?: number;
      batchFlushSize?: number;
      confirmationTimeoutSeconds?: number;
      settlementVerifier: (
        traceData: Record<string, unknown>,
        settlement: ParsedTvmSettlement,
        relayRequest: TvmRelayRequest,
      ) => string;
    },
  ) {}

  enqueue(queuedSettlement: QueuedSettlement): Promise<BatchResult> {
    return new Promise(resolve => {
      const queue = this.queues.get(queuedSettlement.network) ?? [];
      queue.push({ ...queuedSettlement, resolve });
      this.queues.set(queuedSettlement.network, queue);

      if (queue.length >= (this.options.batchFlushSize ?? DEFAULT_SETTLEMENT_BATCH_FLUSH_SIZE)) {
        this.clearTimer(queuedSettlement.network);
        void this.flushNetwork(queuedSettlement.network);
        return;
      }

      if (!this.timers.has(queuedSettlement.network)) {
        const timer = setTimeout(
          () => void this.flushNetwork(queuedSettlement.network),
          (this.options.flushIntervalSeconds ?? DEFAULT_SETTLEMENT_BATCH_FLUSH_INTERVAL_SECONDS) *
            1000,
        );
        this.timers.set(queuedSettlement.network, timer);
      }
    });
  }

  private async flushNetwork(network: string): Promise<void> {
    this.clearTimer(network);
    const queue = this.queues.get(network) ?? [];
    if (!queue.length) return;
    const batch = queue.splice(0, DEFAULT_SETTLEMENT_BATCH_MAX_SIZE);
    if (queue.length) {
      this.queues.set(network, queue);
      const timer = setTimeout(() => void this.flushNetwork(network), 0);
      this.timers.set(network, timer);
    } else {
      this.queues.delete(network);
    }

    let traceExternalHashNorm = "";
    try {
      const externalBoc = await this.signer.buildRelayExternalBocBatch(
        network,
        batch.map(item => item.relayRequest),
      );
      traceExternalHashNorm = await this.signer.sendExternalMessage(network, externalBoc);
    } catch (error) {
      this.failBatch(batch, {
        errorReason: ERR_EXACT_TVM_TRANSACTION_FAILED,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let finalizedTrace: Record<string, unknown>;
    try {
      finalizedTrace = await this.signer.waitForTraceConfirmation(network, traceExternalHashNorm, {
        timeoutSeconds:
          this.options.confirmationTimeoutSeconds ?? DEFAULT_TRACE_CONFIRMATION_TIMEOUT_SECONDS,
      });
    } catch (error) {
      this.failBatch(batch, {
        errorReason: ERR_EXACT_TVM_TRANSACTION_FAILED,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const queued of batch) {
      try {
        const transaction = this.options.settlementVerifier(
          finalizedTrace,
          queued.settlement,
          queued.relayRequest,
        );
        queued.resolve({ success: true, transaction });
        this.settlementCache.release(queued.settlementHash);
      } catch (error) {
        queued.resolve({
          success: false,
          transaction: "",
          errorReason: ERR_EXACT_TVM_TRANSACTION_FAILED,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        this.settlementCache.release(queued.settlementHash);
      }
    }
  }

  private failBatch(batch: PendingSettlement[], failure: Omit<BatchResult, "success">): void {
    for (const queued of batch) {
      queued.resolve({
        success: false,
        transaction: "",
        ...failure,
      });
      this.settlementCache.release(queued.settlementHash);
    }
  }

  private clearTimer(network: string): void {
    const timer = this.timers.get(network);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(network);
    }
  }
}
