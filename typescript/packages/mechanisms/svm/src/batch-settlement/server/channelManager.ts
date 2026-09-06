/**
 * Autonomous redemption for the channels a resource server has served.
 *
 * Vouchers accumulate offchain and are worth nothing until they are claimed,
 * so a server that never redeems forfeits everything it earned the moment a
 * payer forces a close — the grace period is the whole window. This drives
 * that redemption on an interval, out of the request path.
 */

import type { PaymentRequirements, SettleResponse } from "@x402/core/types";

import { BATCH_SETTLEMENT_SCHEME } from "../types";
import type { ChannelState, ChannelStore } from "./storage";

/**
 * The spec packs no more than four channels into one claim transaction, and a
 * full batch is never silently truncated.
 */
const MAX_CHANNELS_PER_BATCH = 4;

/** Submits a server-authored redemption payload; normally a facilitator. */
export type RedemptionSettler = (
  payload: { x402Version: number; payload: unknown; accepted: PaymentRequirements },
  requirements: PaymentRequirements,
) => Promise<SettleResponse>;

export interface BatchChannelManagerConfig {
  /** The server's channel state, holding the vouchers to redeem. */
  store: ChannelStore;
  /** How redemption payloads reach the chain. */
  settle: RedemptionSettler;
  /**
   * Terms the channels were opened against — network, asset, `payTo` and
   * `extra.feePayer`. Redemption is authored against these, so they must be
   * the ones the server advertises.
   */
  requirements: PaymentRequirements;
  /** Channels per claim transaction. Defaults to the spec's four. */
  maxChannelsPerBatch?: number | undefined;
  /** Reports a pass that failed, so an operator can see it. */
  onError?: ((error: unknown) => void) | undefined;
}

/** What one redemption pass moved. */
export interface RedemptionResult {
  claimed: string[];
  distributed: string[];
}

/**
 * Claims accumulated vouchers and distributes what they settle.
 *
 * Both halves are separate onchain steps: `claim` advances the settled
 * watermark from a stored voucher, and `distribute` pays the newly settled
 * delta to `payTo`. A pass does the first for every channel that has an
 * unclaimed voucher, then the second for every channel holding an
 * undistributed balance.
 */
export class BatchChannelManager {
  private timer: ReturnType<typeof setInterval> | undefined;
  private passInFlight: Promise<unknown> = Promise.resolve();
  private running = false;

  /**
   * Build a worker over a store and a way to submit redemption payloads.
   *
   * @param config - Store, settler and the terms to redeem against
   */
  constructor(private readonly config: BatchChannelManagerConfig) {}

  /**
   * Run one redemption pass: claim what has vouchers, pay out what settles.
   *
   * Safe to call from a cron instead of using {@link start}; passes are
   * serialized either way, so a slow pass cannot overlap the next and submit
   * the same claim twice.
   *
   * @returns The channels claimed and distributed
   */
  async redeem(): Promise<RedemptionResult> {
    const pass = this.passInFlight.then(
      () => this.runPass(),
      () => this.runPass(),
    );
    this.passInFlight = pass.catch(() => undefined);
    return pass;
  }

  /**
   * Redeem every `intervalSecs`.
   *
   * Claim well inside the forced-close grace period: a voucher still unclaimed
   * when a close completes is value the server gives back to the payer.
   *
   * @param intervalSecs - Seconds between passes
   */
  start(intervalSecs: number): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.redeem().catch(error => this.config.onError?.(error));
    }, intervalSecs * 1_000);
  }

  /** Stop the interval and wait for a pass already under way. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.passInFlight;
  }

  /**
   * One pass: claim, then distribute against freshly read state.
   *
   * @returns The channels claimed and distributed
   */
  private async runPass(): Promise<RedemptionResult> {
    if (typeof this.config.store.list !== "function") {
      throw new Error("BatchChannelManager requires a channel store that can list its channels");
    }
    const list = this.config.store.list.bind(this.config.store);
    const claimed = await this.claim(await list());
    // Re-read before paying out: a claim in this same pass just advanced the
    // watermarks that decide what there is to distribute, so the snapshot the
    // pass opened with is already stale.
    const distributed = await this.distribute(await list());
    return { claimed, distributed };
  }

  /**
   * Advance the onchain settled watermark from each stored voucher.
   *
   * @param channels - Channels to consider claiming
   * @returns The channels whose claim landed
   */
  private async claim(channels: ChannelState[]): Promise<string[]> {
    const claimable = channels.filter(
      channel =>
        channel.status === "open" &&
        channel.highestVoucherSignature !== undefined &&
        channel.signedMaxClaimable > channel.settled,
    );
    const claimed: string[] = [];
    for (const batch of chunk(claimable, this.batchSize())) {
      const response = await this.config.settle(
        {
          accepted: this.config.requirements,
          payload: {
            claims: batch.map(channel => ({
              signature: channel.highestVoucherSignature!,
              voucher: {
                channelConfig: channel.channelConfig,
                channelId: channel.channelId,
                expiresAt: channel.highestVoucherExpiresAt ?? 0,
                maxClaimableAmount: channel.signedMaxClaimable.toString(),
              },
            })),
            type: "claim",
          },
          x402Version: 2,
        },
        this.config.requirements,
      );
      if (!response.success) {
        // A batch that did not land leaves its channels for the next pass;
        // the watermark is monotonic, so a repeat is harmless.
        this.config.onError?.(
          new Error(
            `${BATCH_SETTLEMENT_SCHEME} claim failed: ${response.errorReason ?? "unknown"}`,
          ),
        );
        continue;
      }
      for (const channel of batch) {
        await this.record(channel.channelId, state => ({
          ...state,
          settled: channel.signedMaxClaimable,
        }));
        claimed.push(channel.channelId);
      }
    }
    return claimed;
  }

  /**
   * Pay each newly settled delta to `payTo`.
   *
   * @param channels - Channels to consider paying out
   * @returns The channels whose distribution landed
   */
  private async distribute(channels: ChannelState[]): Promise<string[]> {
    const payable = channels.filter(
      channel => channel.status === "open" && channel.settled > channel.payoutWatermark,
    );
    const distributed: string[] = [];
    for (const batch of chunk(payable, this.batchSize())) {
      const response = await this.config.settle(
        {
          accepted: this.config.requirements,
          payload: {
            channels: batch.map(channel => ({
              channelConfig: channel.channelConfig,
              channelId: channel.channelId,
            })),
            type: "settle",
          },
          x402Version: 2,
        },
        this.config.requirements,
      );
      if (!response.success) {
        this.config.onError?.(
          new Error(
            `${BATCH_SETTLEMENT_SCHEME} distribute failed: ${response.errorReason ?? "unknown"}`,
          ),
        );
        continue;
      }
      for (const channel of batch) {
        await this.record(channel.channelId, state => ({
          ...state,
          payoutWatermark: channel.settled,
        }));
        distributed.push(channel.channelId);
      }
    }
    return distributed;
  }

  /**
   * Fold a confirmed redemption into the stored channel.
   *
   * @param channelId - Channel to update
   * @param updater - Applies the confirmed advance
   */
  private async record(
    channelId: string,
    updater: (state: ChannelState) => ChannelState,
  ): Promise<void> {
    await this.config.store.update(channelId, current => {
      if (!current) throw new Error(`channel ${channelId} vanished mid-redemption`);
      return updater(current);
    });
  }

  /**
   * How many channels one redemption transaction carries.
   *
   * @returns Channels to pack into one redemption transaction
   */
  private batchSize(): number {
    return Math.max(1, this.config.maxChannelsPerBatch ?? MAX_CHANNELS_PER_BATCH);
  }
}

/**
 * Split `items` into runs of at most `size`.
 *
 * @param items - What to split
 * @param size - Longest run to produce
 * @returns The runs, in order
 */
function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
