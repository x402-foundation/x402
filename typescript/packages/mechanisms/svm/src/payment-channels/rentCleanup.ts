/**
 * Facilitator-side async rent cleanup for SVM payment channels.
 *
 * Driven entirely by verify-time {@link PaymentChannelStorage}: each pass lists
 * stored channels, refetches live account status, then acts on whatever is
 * ready (abandon-close / forced-close / distribute / reclaim). RPC is not
 * used for discovery.
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

import { fetchMaybeChannel, type Channel } from "./generated/accounts/channel";
import {
  buildDistributeInstruction,
  buildReclaimInstruction,
  buildSealInstruction,
  buildSettleAndSealInstructions,
  ChannelStatus,
  type ServerInstruction,
} from "./onchain";
import { OPEN_SLOT_WINDOW } from "./open";
import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../signer";
import { createRpcClient } from "../utils";
import type { ChannelRpc, PaymentChannelSvmSigner } from "./facilitator";
import { reclaimComputeUnitLimit, submitSettle } from "./facilitator";
import type { PaymentChannelRecord, PaymentChannelStorage } from "./storage";

/** Reclaim work item: storage key plus live rent_payer from the channel account. */
interface ReclaimCandidate {
  channelId: string;
  rentPayer: string;
}

/** Default grace after voucher expiry before abandon-closing an Open channel. */
export const DEFAULT_ABANDON_GRACE_SECS = 120;

/** Default reclaim instructions per cleanup transaction. */
export const DEFAULT_MAX_RECLAIMS_PER_TX = 8;

/** Default total cleanup transactions submitted per `cleanup` call. */
export const DEFAULT_MAX_TXS_PER_RUN = 20;

/** Default abandon-close (settle+distribute) transactions per `cleanup` call. */
export const DEFAULT_MAX_CLOSES_PER_RUN = 10;

/** Result of a successful abandon-close or Sealed distribute. */
export interface RentCleanupCloseResult {
  channelId: string;
  transaction: string;
  action: "abandon_close" | "forced_close" | "distribute";
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
  /** Max cleanup transactions (closes + reclaim batches) per call. */
  maxTxsPerRun?: number;
  /** Max abandon-close / Sealed-distribute transactions per call. */
  maxClosesPerRun?: number;
  onClose?: (result: RentCleanupCloseResult) => void;
  onReclaim?: (result: RentCleanupReclaimResult) => void;
  onError?: (error: unknown, context?: { channelId?: string }) => void;
}

/** Interval runner configuration. */
export interface RentCleanupStartConfig extends RentCleanupOptions {
  /** Seconds between `cleanup` ticks. Required to start the loop. */
  intervalSecs: number;
}

export interface PaymentChannelRentCleanupManagerConfig {
  signer: FacilitatorSvmSigner;
  storage: PaymentChannelStorage;
  network: Network;
  rpcUrl?: string;
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
 * Storage-driven rent cleanup worker for SVM payment channels.
 *
 * Operators opt in via {@link start} or an external cron calling
 * {@link cleanup}; the facilitator scheme never auto-starts this.
 */
export class PaymentChannelRentCleanupManager {
  private readonly signer: FacilitatorSvmSigner;
  private readonly getKitSigner: (feePayer: Address) => FacilitatorSigningCapabilities;
  private readonly storage: PaymentChannelStorage;
  private readonly network: Network;
  private readonly rpcUrl: string | undefined;
  private readonly computeUnitPriceMicroLamports: number | undefined;
  private readonly settleComputeUnitLimit: number | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private tickInFlight = false;
  private startConfig: RentCleanupStartConfig | undefined;

  /**
   * Create a rent cleanup manager for one network.
   *
   * @param config - Signer pool, channel storage, and network/RPC
   */
  constructor(config: PaymentChannelRentCleanupManagerConfig) {
    if (typeof config.signer.getSigner !== "function") {
      throw new Error(
        "PaymentChannelRentCleanupManager requires getSigner on the signer. " +
          "Use toFacilitatorSvmSigner() which provides all required methods.",
      );
    }
    this.getKitSigner = config.signer.getSigner.bind(config.signer);
    this.signer = config.signer;
    this.storage = config.storage;
    this.network = config.network;
    this.rpcUrl = config.rpcUrl;
    this.computeUnitPriceMicroLamports = config.computeUnitPriceMicroLamports;
    this.settleComputeUnitLimit = config.settleComputeUnitLimit;
  }

  /**
   * Clean up whatever is ready: abandon-close timed-out Open channels,
   * finalize Closing channels once their onchain grace period elapses,
   * distribute Sealed ones, and batch-reclaim Distributed channels past the
   * open-slot gate. Defers too-early Closing and still-active Open channels.
   *
   * @param opts - Work caps and callbacks
   */
  async cleanup(opts: RentCleanupOptions = {}): Promise<void> {
    const abandonGraceSecs = opts.abandonGraceSecs ?? DEFAULT_ABANDON_GRACE_SECS;
    const maxReclaimsPerTx = opts.maxReclaimsPerTx ?? DEFAULT_MAX_RECLAIMS_PER_TX;
    const maxTxsPerRun = opts.maxTxsPerRun ?? DEFAULT_MAX_TXS_PER_RUN;
    const maxClosesPerRun = opts.maxClosesPerRun ?? DEFAULT_MAX_CLOSES_PER_RUN;

    const rpc = createRpcClient(this.network, this.rpcUrl);
    const records = await this.storage.list();
    const nowSecs = Math.floor(Date.now() / 1_000);
    let currentSlot: bigint | undefined;
    let txsUsed = 0;
    let closesUsed = 0;
    const reclaimCandidates: ReclaimCandidate[] = [];

    for (const record of records) {
      if (txsUsed >= maxTxsPerRun) break;
      if (record.network !== this.network) continue;

      try {
        const maybe = await fetchMaybeChannel(rpc, address(record.channelId));
        if (!maybe.exists) {
          await this.storage.delete(record.channelId);
          continue;
        }

        const live = maybe.data;
        const status = live.status as ChannelStatus;

        if (
          status === ChannelStatus.Open ||
          status === ChannelStatus.Closing ||
          status === ChannelStatus.Sealed
        ) {
          if (status === ChannelStatus.Open) {
            const readyAt = record.expiresAt + abandonGraceSecs;
            if (nowSecs < readyAt) continue;
          } else if (
            status === ChannelStatus.Closing &&
            BigInt(nowSecs) < live.closureStartedAt + BigInt(live.gracePeriod)
          ) {
            continue;
          }
          if (closesUsed >= maxClosesPerRun || txsUsed >= maxTxsPerRun) break;

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
            rpc,
            record,
            live,
            status,
          );
          closesUsed += 1;
          txsUsed += 1;
          opts.onClose?.({
            channelId: record.channelId,
            transaction: signature,
            action:
              status === ChannelStatus.Open
                ? "abandon_close"
                : status === ChannelStatus.Closing
                  ? "forced_close"
                  : "distribute",
          });
          await this.syncStorageAfterAction(rpc, record.channelId);
          continue;
        }

        if (status === ChannelStatus.Distributed) {
          currentSlot ??= await rpc.getSlot().send();
          if (currentSlot > live.openSlot + OPEN_SLOT_WINDOW) {
            reclaimCandidates.push({
              channelId: record.channelId,
              rentPayer: live.rentPayer,
            });
          }
        }
      } catch (error) {
        opts.onError?.(error, { channelId: record.channelId });
      }
    }

    if (txsUsed < maxTxsPerRun) {
      await this.submitReclaimBatches(rpc, reclaimCandidates, {
        maxReclaimsPerTx,
        maxTxs: maxTxsPerRun - txsUsed,
        onReclaim: opts.onReclaim,
        onError: opts.onError,
      });
    }
  }

  /**
   * Start an interval loop that calls {@link cleanup}.
   *
   * @param config - Interval and cleanup policy
   */
  start(config: RentCleanupStartConfig): void {
    if (this.running) return;
    this.running = true;
    this.startConfig = config;
    const intervalMs = config.intervalSecs * 1_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  /**
   * Stop the interval loop.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.startConfig = undefined;
  }

  /**
   * Interval tick: skip if a previous tick is still in flight.
   */
  private async tick(): Promise<void> {
    if (!this.running || this.tickInFlight || !this.startConfig) return;
    this.tickInFlight = true;
    try {
      await this.cleanup(this.startConfig);
    } catch (error) {
      this.startConfig.onError?.(error);
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Submit settle_and_seal(has_voucher=0)+distribute for Open,
   * seal+distribute for Closing, or distribute alone for Sealed.
   *
   * @param feePayerSigner - Channel feePayer / payee signer
   * @param rpc - RPC client
   * @param record - Stored channel (must include payTo + tokenProgram)
   * @param live - Refetched channel account
   * @param status - Live status that selected this path
   * @returns Broadcast signature
   */
  private async submitCloseOrDistribute(
    feePayerSigner: PaymentChannelSvmSigner,
    rpc: ChannelRpc,
    record: PaymentChannelRecord,
    live: Channel,
    status: ChannelStatus,
  ): Promise<Signature> {
    const splits = [{ bps: 10_000, recipient: record.payTo }];
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

    let instructions: ServerInstruction[];
    if (status === ChannelStatus.Open) {
      instructions = [
        ...buildSettleAndSealInstructions({
          channelId: record.channelId,
          payeeSigner: feePayerSigner,
        }),
        distribute,
      ];
    } else if (status === ChannelStatus.Closing) {
      instructions = [buildSealInstruction(record.channelId), distribute];
    } else {
      instructions = [distribute];
    }

    return submitSettle(feePayerSigner, rpc, instructions, {
      computeUnitLimit: this.settleComputeUnitLimit,
      computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
    });
  }

  /**
   * After a close/distribute, delete the storage entry if the PDA is gone.
   *
   * @param rpc - RPC client
   * @param channelId - Channel PDA
   */
  private async syncStorageAfterAction(rpc: ChannelRpc, channelId: string): Promise<void> {
    const maybe = await fetchMaybeChannel(rpc, address(channelId));
    if (!maybe.exists) {
      await this.storage.delete(channelId);
    }
  }

  /**
   * Group reclaim candidates by rent_payer and submit batched reclaim txs.
   *
   * @param rpc - RPC client
   * @param candidates - Distributed channels ready to reclaim
   * @param opts - Batch size, tx budget, callbacks
   * @param opts.maxReclaimsPerTx - Max reclaim instructions per transaction
   * @param opts.maxTxs - Max reclaim transactions to submit
   * @param opts.onReclaim - Optional success callback per reclaim batch
   * @param opts.onError - Optional error callback
   */
  private async submitReclaimBatches(
    rpc: ChannelRpc,
    candidates: ReclaimCandidate[],
    opts: {
      maxReclaimsPerTx: number;
      maxTxs: number;
      onReclaim?: ((result: RentCleanupReclaimResult) => void) | undefined;
      onError?: ((error: unknown, context?: { channelId?: string }) => void) | undefined;
    },
  ): Promise<void> {
    if (opts.maxTxs <= 0 || candidates.length === 0) return;

    const byRentPayer = new Map<string, ReclaimCandidate[]>();
    for (const candidate of candidates) {
      const group = byRentPayer.get(candidate.rentPayer) ?? [];
      group.push(candidate);
      byRentPayer.set(candidate.rentPayer, group);
    }

    let txsUsed = 0;
    for (const [rentPayer, group] of byRentPayer) {
      if (txsUsed >= opts.maxTxs) break;

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
        continue;
      }

      for (let i = 0; i < group.length && txsUsed < opts.maxTxs; i += opts.maxReclaimsPerTx) {
        const batch = group.slice(i, i + opts.maxReclaimsPerTx);
        try {
          // Refetch each account immediately before acting (stale → skip).
          const liveBatch: ReclaimCandidate[] = [];
          for (const candidate of batch) {
            const maybe = await fetchMaybeChannel(rpc, address(candidate.channelId));
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
          const signature = await submitSettle(feePayerSigner, rpc, instructions, {
            computeUnitLimit: reclaimComputeUnitLimit(liveBatch.length),
            computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
          });
          txsUsed += 1;
          opts.onReclaim?.({
            channelIds: liveBatch.map(c => c.channelId),
            transaction: signature,
          });
          for (const candidate of liveBatch) {
            await this.storage.delete(candidate.channelId);
          }
        } catch (error) {
          opts.onError?.(error, { channelId: batch[0]?.channelId });
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
  private resolveFeePayer(feePayerAddress: string): PaymentChannelSvmSigner | undefined {
    if (!this.signer.getAddresses().includes(feePayerAddress as Address)) {
      return undefined;
    }
    return this.getKitSigner(feePayerAddress as Address);
  }
}
