/**
 * Facilitator-side async rent cleanup for SVM `upto` channels.
 *
 * Driven entirely by verify-time {@link UptoChannelStorage}: each pass lists
 * stored channels, refetches live account status, then acts on whatever is
 * ready (abandon-close / distribute / reclaim). RPC is not used for discovery.
 *
 * Signs with the live channel `payee` / `rent_payer` (same key in this scheme)
 * from the facilitator's existing signer pool — no dedicated cleanup key.
 *
 * Policy note (spec §8): sealing abandoned Open channels before the server
 * settles freezes the watermark and refunds the unsettled remainder to the
 * client. Abandon timing uses `min(expiresAt + grace, firstSeenAt + max)` so
 * normal vouchers expire cleanly while misconfigured long timeouts are capped.
 */

import { address, type Address, type Signature } from "@solana/kit";
import type { Network } from "@x402/core/types";

import { discoverChannelsByRentPayer } from "../../payment-channels/discovery";
import { fetchMaybeChannel, type Channel } from "../../payment-channels/generated/accounts/channel";
import {
  buildDistributeInstruction,
  buildReclaimInstruction,
  buildSettleAndSealInstructions,
  ChannelStatus,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import { OPEN_SLOT_WINDOW } from "../../payment-channels/open";
import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../../signer";
import { BASIS_POINTS_DENOMINATOR, SLOT_COMMITMENT, STATE_COMMITMENT } from "../shared";
import type { UptoSvmSigner } from "./channel";
import { accountFetchRpc, reclaimComputeUnitLimit, submitSettle } from "./channel";
import type { UptoChannelRecord, UptoChannelStorage } from "./channelStorage";
import { assertUptoFacilitatorSigner, type UptoFacilitatorSigner } from "./signer";

/** Reclaim work item: storage key plus live rent_payer from the channel account. */
interface ReclaimCandidate {
  channelId: string;
  rentPayer: string;
}

/**
 * Ascending channel id, the scan's total order.
 *
 * @param a - First record
 * @param b - Second record
 * @returns Negative, zero, or positive per `Array.prototype.sort`
 */
function compareChannelId(a: UptoChannelRecord, b: UptoChannelRecord): number {
  if (a.channelId < b.channelId) return -1;
  if (a.channelId > b.channelId) return 1;
  return 0;
}

/**
 * Put records in scan order, resuming where the previous pass stopped.
 *
 * `UptoChannelStorage.list()` promises no ordering, so the manager imposes
 * one: without it the resume cursor would mean something different on every
 * storage implementation, and a backlog larger than the budget could revisit
 * the same records forever. Sorts by channel id, then rotates so `cursor`
 * comes first. An unknown or empty cursor (a closed channel, or the first
 * pass) scans from the beginning.
 *
 * @param records - Stored channel records in any order
 * @param cursor - Channel id to resume from, or "" to scan from the start
 * @returns Records sorted, then rotated so `cursor` (if present) comes first
 */
function orderForScan(records: UptoChannelRecord[], cursor: string): UptoChannelRecord[] {
  const sorted = [...records].sort(compareChannelId);
  if (!cursor) return sorted;
  const index = sorted.findIndex(record => record.channelId === cursor);
  if (index === -1) return sorted;
  return [...sorted.slice(index), ...sorted.slice(0, index)];
}

/**
 * Cancellation for one pass: the manager's own stop signal plus whatever the
 * caller passed. Mirrors the Go SDK, where `Stop` cancels the context that
 * `Cleanup` runs under.
 */
interface PassAbort {
  /** Throws the abort reason once any signal has fired. */
  throwIfAborted(): void;
  /** Reports whether any signal has fired. */
  aborted(): boolean;
}

/**
 * Combine the signals that can cancel a pass.
 *
 * @param signals - Manager and caller signals, either of which may be unset
 * @returns Checks the pass calls at its cancellation points
 */
function passAbort(...signals: (AbortSignal | undefined)[]): PassAbort {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return {
    throwIfAborted: () => {
      for (const signal of active) signal.throwIfAborted();
    },
    aborted: () => active.some(signal => signal.aborted),
  };
}

/**
 * Recognize the `AbortError` an aborted signal throws, so a requested stop is
 * not reported to the operator as a cleanup failure.
 *
 * @param error - Error thrown by a pass
 * @returns True when the pass ended because it was cancelled
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Resolve an operator-supplied numeric cleanup option. Non-positive, `NaN`,
 * or non-finite values fall back to `defaultValue`, matching the Go SDK's
 * `CleanupOptions.withDefaults`; a misconfigured `maxReclaimsPerTx` of `0`
 * would otherwise spin the batching loop forever instead of budgeting a
 * sane batch. The result is capped at `max` when given.
 *
 * @param value - Operator-supplied value, if any
 * @param defaultValue - Value used when `value` is absent or invalid
 * @param max - Optional upper bound the resolved value is clamped to
 * @returns The resolved, positive option value
 */
function resolveCleanupCount(
  value: number | undefined,
  defaultValue: number,
  max?: number,
): number {
  const resolved =
    value !== undefined && Number.isFinite(value) && value > 0 ? value : defaultValue;
  return max !== undefined ? Math.min(resolved, max) : resolved;
}

/** Default grace after voucher expiry before abandon-closing an Open channel. */
export const DEFAULT_ABANDON_GRACE_SECS = 120;

/** Default reclaim instructions per cleanup transaction. */
export const DEFAULT_MAX_RECLAIMS_PER_TX = 8;

/**
 * Largest reclaim batch proven, by the Go SDK's
 * `TestReclaimBatchFitsInOneTransaction`, to serialize under Solana's
 * `PACKET_DATA_SIZE` (1232 bytes) with every channel PDA distinct and one
 * shared fee payer. `maxReclaimsPerTx` is clamped to this so a misconfigured
 * operator value can never build a reclaim transaction that fails to
 * serialize or gets rejected on broadcast.
 */
export const MAX_SAFE_RECLAIMS_PER_TX = 16;

/** Default close/distribute transactions the storage scan may submit per call. */
export const DEFAULT_MAX_TXS_PER_RUN = 20;

/** Default reclaim transactions each rent payer may submit per call. */
export const DEFAULT_MAX_TXS_PER_SIGNER = 20;

/** Default abandon-close (settle+distribute) transactions per `cleanup` call. */
export const DEFAULT_MAX_CLOSES_PER_RUN = 10;

/** Result of a successful abandon-close or Sealed distribute. */
export interface RentCleanupCloseResult {
  channelId: string;
  transaction: string;
  action: "abandon_close" | "distribute";
}

/** Result of a successful reclaim batch transaction. */
export interface RentCleanupReclaimResult {
  channelIds: string[];
  transaction: string;
}

/** Options for one-shot and interval cleanup. */
export interface RentCleanupOptions {
  /** Seconds after `expiresAt` before abandon-close. Default 120. */
  abandonGraceSecs?: number;
  /** Max `reclaim` instructions packed into one transaction. */
  maxReclaimsPerTx?: number;
  /**
   * Transactions the storage scan may submit before it stops and saves a
   * resume cursor. Caps the scan, not the pass: reclaims are budgeted
   * separately by {@link maxTxsPerSigner}.
   */
  maxTxsPerRun?: number;
  /**
   * Reclaim transactions each rent payer may submit per call. Budgeted per
   * signer because rent-payer groups are independent: adding managed keys adds
   * throughput rather than dividing a fixed pool.
   */
  maxTxsPerSigner?: number;
  /** Max abandon-close / Sealed-distribute transactions per call. */
  maxClosesPerRun?: number;
  /**
   * Cancels the pass at its next scan / discovery / reclaim checkpoint. The
   * pass then rejects with an `AbortError`, matching the Go SDK's
   * `Cleanup(ctx, …)` returning `ctx.Err()`.
   */
  signal?: AbortSignal;
  onClose?: (result: RentCleanupCloseResult) => void;
  onReclaim?: (result: RentCleanupReclaimResult) => void;
  onError?: (error: unknown, context?: { channelId?: string }) => void;
}

/** Channels one discovery sweep added to storage. */
export interface RentDiscoveryResult {
  channelIds: string[];
}

/** Options for one-shot and interval discovery. */
export interface RentDiscoveryOptions {
  /**
   * Cancels the sweep between managed signers. The sweep then rejects with an
   * `AbortError`, matching the Go SDK's `Discover(ctx, …)` returning
   * `ctx.Err()`.
   */
  signal?: AbortSignal;
  onDiscover?: (result: RentDiscoveryResult) => void;
  onError?: (error: unknown, context?: { channelId?: string }) => void;
}

/** Interval runner configuration. */
export interface RentCleanupStartConfig extends RentCleanupOptions {
  /** Seconds between `cleanup` ticks. Required to start the loop. */
  intervalSecs: number;
  /**
   * Seconds between {@link UptoSvmRentCleanupManager.discover} sweeps. Omit to
   * leave discovery off. A sweep is a `getProgramAccounts` scan per managed
   * signer, so it belongs on a far longer interval than cleanup — daily is
   * typical.
   */
  discoveryIntervalSecs?: number;
  onDiscover?: (result: RentDiscoveryResult) => void;
}

export interface UptoSvmRentCleanupManagerConfig {
  signer: FacilitatorSvmSigner;
  storage: UptoChannelStorage;
  network: Network;
  /**
   * `SetComputeUnitPrice` (microlamports per compute unit) attached to cleanup
   * transactions; `0` omits the instruction. Defaults to
   * `DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (1).
   */
  computeUnitPriceMicroLamports?: number;
  /**
   * `SetComputeUnitLimit` for close/distribute cleanup transactions. Defaults
   * to `DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT` (100k, standard SPL Token
   * settlement); raise it for compute-heavy Token-2022 extension mints.
   * Reclaim batches instead derive their limit per channel
   * (`reclaimComputeUnitLimit`) and are mint-independent.
   */
  settleComputeUnitLimit?: number;
}

/**
 * Storage-driven rent cleanup worker for SVM `upto`.
 *
 * Operators opt in via {@link start} or an external cron calling
 * {@link cleanup}; the facilitator scheme never auto-starts this.
 */
export class UptoSvmRentCleanupManager {
  private readonly signer: UptoFacilitatorSigner;
  private readonly getKitSigner: (feePayer: Address) => FacilitatorSigningCapabilities;
  private readonly storage: UptoChannelStorage;
  private readonly network: Network;
  private readonly computeUnitPriceMicroLamports: number | undefined;
  private readonly settleComputeUnitLimit: number | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private tickInFlight = false;
  private discoveryTickInFlight = false;
  private startConfig: RentCleanupStartConfig | undefined;

  /**
   * Cancels passes the interval loop owns. Created by {@link start} and fired
   * by {@link stop}, which then waits for the pass to unwind.
   */
  private abortController: AbortController | undefined;

  /**
   * Tail of the queued pass chain. Cleanup and discovery passes run one at a
   * time so an operator's cron calling {@link cleanup} cannot race the
   * interval loop into submitting the same close or reclaim twice, and so a
   * discovery sweep cannot upsert a record cleanup is mid-way through
   * deleting.
   */
  private passQueue: Promise<void> = Promise.resolve();

  /**
   * Resumes scanning where the previous pass's budget ran out, so a
   * persistent close/reclaim backlog larger than maxTxsPerRun cannot starve
   * records ordered later in storage.list() forever. Empty string starts
   * from the beginning. Only ever read/written inside a queued pass.
   */
  private scanCursor = "";

  /**
   * Create a rent cleanup manager for one network.
   *
   * @param config - Signer pool, channel storage, and network/RPC
   */
  constructor(config: UptoSvmRentCleanupManagerConfig) {
    assertUptoFacilitatorSigner(config.signer, "UptoSvmRentCleanupManager");
    this.getKitSigner = config.signer.getSigner.bind(config.signer);
    this.signer = config.signer;
    this.storage = config.storage;
    this.network = config.network;
    this.computeUnitPriceMicroLamports = config.computeUnitPriceMicroLamports;
    this.settleComputeUnitLimit = config.settleComputeUnitLimit;
  }

  /**
   * Clean up whatever is ready: abandon-close timed-out Open channels,
   * distribute Sealed ones, batch-reclaim Distributed channels past the
   * open-slot gate. Defers Closing / too-early / still-active Open.
   *
   * @param opts - Work caps and callbacks
   * @returns A promise that resolves when this pass completes
   */
  async cleanup(opts: RentCleanupOptions = {}): Promise<void> {
    return this.enqueue(() => this.runPass(opts));
  }

  /**
   * Find Distributed channels this facilitator paid rent for that storage does
   * not know about, and add them so {@link cleanup} reclaims them on a later
   * pass. The spec §6 recovery path for a lost or incomplete work index.
   *
   * A sweep is a `getProgramAccounts` scan per managed signer key, which is
   * far more expensive than a cleanup pass — run it rarely (see
   * `discoveryIntervalSecs`), not on the cleanup interval.
   *
   * Discovered records carry only what the chain proves: `payTo`,
   * `tokenProgram`, and `expiresAt` are empty. That is safe because only the
   * Open and Sealed cleanup branches read them, and a Distributed channel
   * never returns to those states. Channel ids already in storage are left
   * alone so a full record is never overwritten with a partial one.
   *
   * @param opts - Cancellation and callbacks
   * @returns A promise that resolves when this sweep completes
   */
  async discover(opts: RentDiscoveryOptions = {}): Promise<void> {
    return this.enqueue(() => this.runDiscovery(opts));
  }

  /**
   * Start the interval loops: {@link cleanup} always, {@link discover} only
   * when `discoveryIntervalSecs` is set.
   *
   * @param config - Intervals and cleanup policy
   */
  start(config: RentCleanupStartConfig): void {
    if (this.running) return;
    this.running = true;
    this.startConfig = config;
    this.abortController = new AbortController();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.intervalSecs * 1_000);
    if (config.discoveryIntervalSecs !== undefined) {
      this.discoveryTimer = setInterval(() => {
        void this.discoveryTick();
      }, config.discoveryIntervalSecs * 1_000);
    }
  }

  /**
   * Stop the interval loops and wait for the pass they left in flight.
   *
   * Cancels at the pass's next scan / discovery / reclaim checkpoint rather
   * than mid-transaction, so a submitted settle is always awaited to its
   * signature and its storage entry updated. Resolves once nothing is running,
   * which makes it safe to await during shutdown.
   *
   * @returns A promise that resolves when the in-flight pass has unwound
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.discoveryTimer !== undefined) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
    this.abortController?.abort();
    // The tail already swallows rejections; this only waits for it to settle.
    await this.passQueue;
    this.abortController = undefined;
    this.startConfig = undefined;
  }

  /**
   * Queue a pass behind whatever is already running.
   *
   * @param pass - The pass to run once the queue drains
   * @returns The pass's own promise, rejection included
   */
  private enqueue(pass: () => Promise<void>): Promise<void> {
    const queued = this.passQueue.then(pass);
    // Swallow on the queue tail only: the caller still sees its own rejection.
    this.passQueue = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Run one cleanup pass. Callers go through {@link cleanup}, which serializes
   * passes.
   *
   * @param opts - Work caps and callbacks
   */
  private async runPass(opts: RentCleanupOptions): Promise<void> {
    const abandonGraceSecs = resolveCleanupCount(opts.abandonGraceSecs, DEFAULT_ABANDON_GRACE_SECS);
    const maxReclaimsPerTx = resolveCleanupCount(
      opts.maxReclaimsPerTx,
      DEFAULT_MAX_RECLAIMS_PER_TX,
      MAX_SAFE_RECLAIMS_PER_TX,
    );
    const maxTxsPerRun = resolveCleanupCount(opts.maxTxsPerRun, DEFAULT_MAX_TXS_PER_RUN);
    const maxTxsPerSigner = resolveCleanupCount(opts.maxTxsPerSigner, DEFAULT_MAX_TXS_PER_SIGNER);
    const maxClosesPerRun = resolveCleanupCount(opts.maxClosesPerRun, DEFAULT_MAX_CLOSES_PER_RUN);
    const abort = passAbort(this.abortController?.signal, opts.signal);

    const rpc = accountFetchRpc(this.signer, this.network);
    const records = orderForScan(await this.storage.list(), this.scanCursor);
    this.scanCursor = "";
    const nowSecs = Math.floor(Date.now() / 1_000);
    let currentSlot: bigint | undefined;
    let txsUsed = 0;
    let closesUsed = 0;
    const reclaimCandidates: ReclaimCandidate[] = [];
    const getCurrentSlot = async (): Promise<bigint> => {
      currentSlot ??= await this.signer.getSlot(this.network, SLOT_COMMITMENT);
      return currentSlot;
    };

    for (const record of records) {
      // Stop, not skip: the budget is spent, so nothing further in this pass
      // can act on a record. Resume here next pass instead of always
      // rescanning from the start.
      if (txsUsed >= maxTxsPerRun) {
        this.scanCursor = record.channelId;
        break;
      }
      abort.throwIfAborted();
      if (record.network !== this.network) continue;

      try {
        const maybe = await fetchMaybeChannel(rpc, address(record.channelId), {
          commitment: STATE_COMMITMENT,
        });
        if (!maybe.exists) {
          await this.storage.delete(record.channelId);
          continue;
        }

        const live = maybe.data;
        const status = live.status as ChannelStatus;

        if (status === ChannelStatus.Closing) {
          continue;
        }

        if (status === ChannelStatus.Open || status === ChannelStatus.Sealed) {
          if (status === ChannelStatus.Open) {
            if (record.expiresAt === 0) continue;
            const readyAt = record.expiresAt + abandonGraceSecs;
            if (nowSecs < readyAt) continue;
          }
          // Skip, not stop: later records may be reclaimable, and reclaims are
          // budgeted separately from closes.
          if (closesUsed >= maxClosesPerRun) continue;

          if (!record.payTo) {
            opts.onError?.(new Error(`channel ${record.channelId} missing payTo; skipping`), {
              channelId: record.channelId,
            });
            continue;
          }

          const feePayer = live.payee;
          const feePayerSigner = this.resolveFeePayer(feePayer);
          if (!feePayerSigner) {
            opts.onError?.(
              new Error(
                `channel ${record.channelId} feePayer ${feePayer} not in facilitator signer set`,
              ),
              { channelId: record.channelId },
            );
            continue;
          }

          const signature = await this.submitCloseOrDistribute(
            feePayerSigner,
            record,
            live,
            status,
          );
          closesUsed += 1;
          txsUsed += 1;
          opts.onClose?.({
            channelId: record.channelId,
            transaction: signature,
            action: status === ChannelStatus.Open ? "abandon_close" : "distribute",
          });
          await this.syncStorageAfterAction(record.channelId);
          continue;
        }

        if (status === ChannelStatus.Distributed) {
          const slot = await getCurrentSlot();
          if (slot > live.openSlot + OPEN_SLOT_WINDOW) {
            reclaimCandidates.push({
              channelId: record.channelId,
              rentPayer: live.rentPayer,
            });
          }
          continue;
        }

        // An unrecognized status has no cleanup path, and the record would
        // otherwise sit in storage forever without the operator knowing.
        opts.onError?.(
          new Error(`channel ${record.channelId} has unrecognized status ${String(status)}`),
          { channelId: record.channelId },
        );
      } catch (error) {
        opts.onError?.(error, { channelId: record.channelId });
      }
    }

    await this.submitReclaimBatches(reclaimCandidates, {
      maxReclaimsPerTx,
      maxTxsPerSigner,
      abort,
      onReclaim: opts.onReclaim,
      onError: opts.onError,
    });
  }

  /**
   * Run one discovery sweep. Callers go through {@link discover}, which
   * serializes it against cleanup passes.
   *
   * @param opts - Cancellation and callbacks
   */
  private async runDiscovery(opts: RentDiscoveryOptions): Promise<void> {
    const abort = passAbort(this.abortController?.signal, opts.signal);
    if (typeof this.signer.getProgramAccounts !== "function") {
      throw new Error(
        "UptoSvmRentCleanupManager.discover requires getProgramAccounts on the signer. " +
          "Use toFacilitatorSvmSigner() which provides all required methods.",
      );
    }

    const known = new Set((await this.storage.list()).map(record => record.channelId));
    const discovered: string[] = [];
    let currentSlot: bigint | undefined;

    for (const managed of this.signer.getAddresses()) {
      abort.throwIfAborted();
      let found;
      try {
        found = await discoverChannelsByRentPayer(this.signer, this.network, managed);
      } catch (error) {
        opts.onError?.(error);
        continue;
      }
      currentSlot ??= await this.signer.getSlot(this.network, SLOT_COMMITMENT);

      for (const { channelId, channel } of found) {
        if (known.has(channelId)) continue;
        known.add(channelId);
        if (channel.status !== ChannelStatus.Distributed) continue;
        if (currentSlot <= channel.openSlot + OPEN_SLOT_WINDOW) continue;

        try {
          await this.storage.upsert({
            channelId,
            payTo: "",
            tokenProgram: "",
            firstSeenAt: Date.now(),
            expiresAt: 0,
            network: this.network,
          });
          discovered.push(channelId);
        } catch (error) {
          opts.onError?.(error, { channelId });
        }
      }
    }

    if (discovered.length > 0) opts.onDiscover?.({ channelIds: discovered });
  }

  /**
   * Interval tick. Skips while a tick is outstanding so a pass slower than the
   * interval cannot pile up queued passes.
   */
  private async tick(): Promise<void> {
    const config = this.startConfig;
    if (!this.running || this.tickInFlight || !config) return;
    this.tickInFlight = true;
    try {
      await this.cleanup(config);
    } catch (error) {
      // A stop() mid-pass is a requested shutdown, not a cleanup failure.
      if (!isAbortError(error)) config.onError?.(error);
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Discovery tick. Skips while a sweep is outstanding, so a sweep slower than
   * its interval cannot pile up queued sweeps ahead of cleanup passes.
   */
  private async discoveryTick(): Promise<void> {
    const config = this.startConfig;
    if (!this.running || this.discoveryTickInFlight || !config) return;
    this.discoveryTickInFlight = true;
    try {
      await this.discover(config);
    } catch (error) {
      if (!isAbortError(error)) config.onError?.(error);
    } finally {
      this.discoveryTickInFlight = false;
    }
  }

  /**
   * Submit settle_and_seal(has_voucher=0)+distribute for Open, or distribute
   * alone for Sealed.
   *
   * @param feePayerSigner - Channel feePayer / payee signer
   * @param record - Stored channel (must include payTo + tokenProgram)
   * @param live - Refetched channel account
   * @param status - Live status that selected this path
   * @returns Broadcast signature
   */
  private async submitCloseOrDistribute(
    feePayerSigner: UptoSvmSigner,
    record: UptoChannelRecord,
    live: Channel,
    status: ChannelStatus,
  ): Promise<Signature> {
    const splits = [{ bps: BASIS_POINTS_DENOMINATOR, recipient: record.payTo }];
    const distribute = await buildDistributeInstruction({
      channelId: record.channelId,
      mint: live.mint,
      network: this.network,
      payee: live.payee,
      payer: live.payer,
      rentPayer: live.rentPayer,
      splits,
      tokenProgram: record.tokenProgram,
    });

    const instructions: ServerInstruction[] =
      status === ChannelStatus.Open
        ? [
            ...buildSettleAndSealInstructions({
              channelId: record.channelId,
              payeeSigner: feePayerSigner,
            }),
            distribute,
          ]
        : [distribute];

    return submitSettle(feePayerSigner, this.signer, this.network, instructions, {
      computeUnitLimit: this.settleComputeUnitLimit,
      computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
    });
  }

  /**
   * After a close/distribute, delete the storage entry if the PDA is gone.
   *
   * @param channelId - Channel PDA
   */
  private async syncStorageAfterAction(channelId: string): Promise<void> {
    const rpc = accountFetchRpc(this.signer, this.network);
    const maybe = await fetchMaybeChannel(rpc, address(channelId), {
      commitment: STATE_COMMITMENT,
    });
    if (!maybe.exists) {
      await this.storage.delete(channelId);
    }
  }

  /**
   * Group reclaim candidates by rent_payer and run each group's batched
   * reclaim transactions concurrently, each against its own maxTxsPerSigner
   * budget.
   *
   * Submissions within a group stay sequential (each batch refetches live
   * state, so a group depends on its own prior submissions to avoid
   * double-reclaiming), but independent rent-payer groups do not share a
   * budget or depend on one another: adding managed signer keys adds
   * maxTxsPerSigner more reclaim throughput per pass, not a share of a fixed
   * pool.
   *
   * @param candidates - Distributed channels ready to reclaim
   * @param opts - Batch size, tx budget, callbacks
   * @param opts.maxReclaimsPerTx - Max reclaim instructions per transaction
   * @param opts.maxTxsPerSigner - Max reclaim transactions per rent-payer group
   * @param opts.abort - Cancellation checked before each batch
   * @param opts.onReclaim - Optional success callback per reclaim batch
   * @param opts.onError - Optional error callback
   */
  private async submitReclaimBatches(
    candidates: ReclaimCandidate[],
    opts: {
      maxReclaimsPerTx: number;
      maxTxsPerSigner: number;
      abort: PassAbort;
      onReclaim?: ((result: RentCleanupReclaimResult) => void) | undefined;
      onError?: ((error: unknown, context?: { channelId?: string }) => void) | undefined;
    },
  ): Promise<void> {
    if (opts.maxTxsPerSigner <= 0 || candidates.length === 0) return;

    const byRentPayer = new Map<string, ReclaimCandidate[]>();
    for (const candidate of candidates) {
      const group = byRentPayer.get(candidate.rentPayer) ?? [];
      group.push(candidate);
      byRentPayer.set(candidate.rentPayer, group);
    }

    await Promise.all(
      Array.from(byRentPayer.entries()).map(([rentPayer, group]) =>
        this.submitReclaimGroup(rentPayer, group, opts, { remaining: opts.maxTxsPerSigner }),
      ),
    );
  }

  /**
   * Submit one rent payer's reclaim batches sequentially, claiming a slot
   * from the shared budget before each attempt.
   *
   * @param rentPayer - Rent payer this group's channels share
   * @param group - This rent payer's reclaim candidates
   * @param opts - Batch size and callbacks
   * @param opts.maxReclaimsPerTx - Max reclaim instructions per transaction
   * @param opts.abort - Cancellation checked before each batch
   * @param opts.onReclaim - Optional success callback per reclaim batch
   * @param opts.onError - Optional error callback
   * @param budget - This group's remaining-transaction counter
   * @param budget.remaining - Reclaim transactions this rent payer may submit
   */
  private async submitReclaimGroup(
    rentPayer: string,
    group: ReclaimCandidate[],
    opts: {
      maxReclaimsPerTx: number;
      abort: PassAbort;
      onReclaim?: ((result: RentCleanupReclaimResult) => void) | undefined;
      onError?: ((error: unknown, context?: { channelId?: string }) => void) | undefined;
    },
    budget: { remaining: number },
  ): Promise<void> {
    const feePayerSigner = this.resolveFeePayer(rentPayer);
    if (!feePayerSigner) {
      for (const candidate of group) {
        opts.onError?.(
          new Error(
            `channel ${candidate.channelId} feePayer ${rentPayer} not in facilitator signer set`,
          ),
          { channelId: candidate.channelId },
        );
      }
      return;
    }

    for (let i = 0; i < group.length; i += opts.maxReclaimsPerTx) {
      if (budget.remaining <= 0) return;
      // Silent, unlike the scan loop: batches already submitted reported
      // through onReclaim, and the pass as a whole reports the cancellation.
      if (opts.abort.aborted()) return;
      budget.remaining -= 1;

      const batch = group.slice(i, i + opts.maxReclaimsPerTx);
      try {
        const rpc = accountFetchRpc(this.signer, this.network);
        // Refetch each account immediately before acting (stale → skip).
        const liveBatch: ReclaimCandidate[] = [];
        for (const candidate of batch) {
          const maybe = await fetchMaybeChannel(rpc, address(candidate.channelId), {
            commitment: STATE_COMMITMENT,
          });
          if (!maybe.exists) {
            await this.storage.delete(candidate.channelId);
            continue;
          }
          if (maybe.data.status !== ChannelStatus.Distributed) continue;
          liveBatch.push({
            channelId: candidate.channelId,
            rentPayer: maybe.data.rentPayer,
          });
        }
        if (liveBatch.length === 0) continue;

        const instructions = liveBatch.map(candidate =>
          buildReclaimInstruction({
            channelId: candidate.channelId,
            rentPayer: candidate.rentPayer,
          }),
        );
        const signature = await submitSettle(
          feePayerSigner,
          this.signer,
          this.network,
          instructions,
          {
            computeUnitLimit: reclaimComputeUnitLimit(liveBatch.length),
            computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
          },
        );
        opts.onReclaim?.({
          channelIds: liveBatch.map(c => c.channelId),
          transaction: signature,
        });
        for (const candidate of liveBatch) {
          await this.storage.delete(candidate.channelId);
        }
      } catch (error) {
        // Every channel in the batch is stuck, not just the first.
        for (const candidate of batch) {
          opts.onError?.(error, { channelId: candidate.channelId });
        }
      }
    }
  }

  /**
   * Resolve the facilitator signer for a channel payee / rent_payer.
   *
   * @param feePayerAddress - Live channel payee / rent_payer
   * @returns Matching signer, or undefined when not configured
   */
  private resolveFeePayer(feePayerAddress: string): UptoSvmSigner | undefined {
    if (!this.signer.getAddresses().includes(feePayerAddress as Address)) {
      return undefined;
    }
    return this.getKitSigner(feePayerAddress as Address);
  }
}
