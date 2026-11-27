/**
 * Autonomous redemption for the channels a resource server has served.
 *
 * Vouchers accumulate offchain and are worth nothing until they are claimed,
 * so a server that never redeems forfeits everything it earned the moment a
 * payer forces a close — the grace period is the whole window. This drives
 * that redemption on an interval, out of the request path.
 */

import { address, type MessagePartialSigner } from "@solana/kit";
import { getChannelDecoder } from "../../payment-channels/generated/accounts/channel";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../payment-channels/onchain";
import { createRpcClient } from "../../utils";
import type { Network, PaymentRequirements, SettleResponse } from "@x402/core/types";

import { signCloseAuthorization } from "../closeAuthorization";
import { BatchError } from "../errors";
import { V1_MAX_CLAIM_CHANNELS, V1_MAX_SETTLE_CHANNELS } from "../facilitator/constants";
import {
  BATCH_SETTLEMENT_SCHEME,
  isBatchRedemptionChannelState,
  redemptionStatusOf,
  type BatchRedemptionStatus,
  type BatchSealPayload,
} from "../types";
import { REDEMPTION_TIMEOUT_SECONDS } from "./constants";
import type { BatchChannelStatus, ChannelState, ChannelStore } from "./types";

/** Channels per claim or settle request when the facilitator advertises no capacity. */
const DEFAULT_CHANNELS_PER_BATCH = 4;

/** Largest unsigned 64-bit integer a channel watermark can hold. */
const U64_MAX = (1n << 64n) - 1n;

/** Submits a server-authored redemption payload; normally a facilitator. */
export type RedemptionSettler = (
  payload: { x402Version: number; payload: unknown; accepted: PaymentRequirements },
  requirements: PaymentRequirements,
) => Promise<SettleResponse>;

/** Outcome of a successful onchain claim batch. */
export interface ClaimResult {
  vouchers: number;
  transaction: string;
}

/** Outcome of a successful distribute batch that pays `payTo`. */
export interface SettleResult {
  transaction: string;
}

/** Outcome of a successful `seal` on a channel the payer is closing. */
export interface SealResult {
  channel: string;
  transaction: string;
}

/** Batch capacity a facilitator advertises in `/supported`. */
export interface RedemptionCapacity {
  maxClaimChannels?: number | undefined;
  maxSettleChannels?: number | undefined;
}

export interface BatchChannelManagerConfig {
  /** The server's channel state, holding the vouchers to redeem. */
  store: ChannelStore;
  /** How redemption payloads reach the chain. */
  settle: RedemptionSettler;
  network: Network;
  /**
   * The facilitator's advertised batch capacity, read at each pass. Absent or
   * non-positive values fall back to four channels per batch.
   */
  capacity?: (() => RedemptionCapacity | undefined) | undefined;
  /** Channels per claim or distribute transaction, capped at the facilitator's advertised capacity. */
  maxChannelsPerBatch?: number | undefined;
  /**
   * RPC endpoint for confirmed watermark reads. Empty disables chain reads
   * unless the matching watermark reader is set. Never the public endpoint
   * for `network`.
   */
  rpcUrl?: string | undefined;
  /** Optional confirmed channel reader for custom transports; never estimate from the response amount. */
  readPayoutWatermark?: ((channelId: string) => Promise<bigint | undefined>) | undefined;
  /**
   * Optional confirmed reader of the onchain `settled` watermark, used when a
   * claim response carries no per-channel confirmation (spec 4.5 defines only
   * `success`, `transaction`, `network` and `amount` for a claim).
   */
  readSettledWatermark?: ((channelId: string) => Promise<bigint | undefined>) | undefined;
  /** Fires after a successful onchain claim batch. */
  onClaim?: ((result: ClaimResult) => void) | undefined;
  /** Fires after a successful distribute (`settle`) batch. */
  onSettle?: ((result: SettleResult) => void) | undefined;
  /** Fires after a successful `seal` on a closing channel. */
  onSeal?: ((result: SealResult) => void) | undefined;
  /** Reports a pass that failed, so an operator can see it. */
  onError?: ((error: unknown) => void) | undefined;
  /**
   * Receiver-authorizer key advertised as `extra.receiverAuthorizer`. For a
   * channel the payer is closing, the worker signs a `CloseAuthorization` with
   * it and submits a `seal`, so vouchers above the onchain watermark are
   * collected inside the grace period instead of forfeited. Omit it when the
   * facilitator authenticates the close itself.
   */
  receiverAuthorizer?: MessagePartialSigner | undefined;
}

/** A channel's confirmed onchain state, as the facilitator reported it in `extra.channelStates`. */
type ObservedChannel = {
  status: BatchRedemptionStatus;
  settled: bigint;
  payout: bigint;
};

/** What one redemption pass moved. */
export interface RedemptionResult {
  claimed: string[];
  distributed: string[];
  /** Closing channels finalized with the latest voucher through `seal`. */
  sealed: string[];
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
  private readonly graceElapsedReported = new Set<string>();

  /**
   * Build a worker over a store and a way to submit redemption payloads.
   *
   * @param config - Store, settler and network to redeem on
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

  /**
   * Stop the interval and wait for a pass already under way.
   *
   * @param opts - Stop options.
   * @param opts.flush - When true, run one final {@link redeem} before returning.
   * @returns Resolves when the interval is stopped (and flush work completes, if requested).
   */
  async stop(opts?: { flush?: boolean }): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (opts?.flush) {
      await this.redeem().catch(error => this.config.onError?.(error));
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
    const { claimed, sealed } = await this.claim(await list());
    // Re-read before paying out: a claim in this same pass just advanced the
    // watermarks that decide what there is to distribute, so the snapshot the
    // pass opened with is already stale.
    const distributed = await this.distribute(await list());
    return { claimed, distributed, sealed };
  }

  /**
   * Advance the onchain settled watermark from each stored voucher.
   *
   * @param channels - Channels to consider claiming
   * @returns The channels whose claim landed
   */
  private async claim(channels: ChannelState[]): Promise<{ claimed: string[]; sealed: string[] }> {
    const unclaimed = channels.filter(
      channel =>
        channel.highestVoucherSignature !== undefined &&
        channel.signedMaxClaimable > channel.settled,
    );
    const claimable = unclaimed.filter(channel => channel.status === "open");
    const closing = unclaimed.filter(channel => channel.status === "closing");
    const result = { claimed: [] as string[], sealed: [] as string[] };
    for (const group of this.groupByTerms(claimable)) {
      for (const batch of chunk(group.channels, this.batchSize("maxClaimChannels"))) {
        await this.claimBatch(batch, group.requirements, result);
      }
    }
    for (const channel of closing) {
      if (await this.seal(channel)) result.sealed.push(channel.channelId);
    }
    return result;
  }

  /**
   * Claim one batch, or fall back to `seal` for a channel the payer is closing.
   *
   * @param batch - Channels packed into one claim transaction
   * @param requirements - Terms the batch's channels were opened against
   * @param result - Accumulates the pass outcome
   * @param result.claimed - Channels whose claim landed
   * @param result.sealed - Closing channels finalized through `seal`
   * @param resynced - Whether a resync re-claim already ran in this chain, so a second mismatch is reported rather than retried
   */
  private async claimBatch(
    batch: ChannelState[],
    requirements: PaymentRequirements,
    result: { claimed: string[]; sealed: string[] },
    resynced = false,
  ): Promise<void> {
    const response = await this.config.settle(
      {
        accepted: requirements,
        payload: {
          claims: batch.map(channel => ({
            channelConfig: channel.channelConfig,
            channelId: channel.channelId,
            voucher: {
              channelId: channel.channelId,
              expiresAt: channel.highestVoucherExpiresAt ?? 0,
              maxClaimableAmount: channel.signedMaxClaimable.toString(),
              signature: channel.highestVoucherSignature!,
            },
          })),
          type: "claim",
        },
        x402Version: 2,
      },
      requirements,
    );
    if (!response.success) {
      if (response.errorReason === BatchError.CHANNEL_CLOSING) {
        // The payer started a forced close on at least one channel in the
        // batch, so program `settle` is no longer available for it. Claim the
        // others one by one and finalize the closing one with its latest
        // voucher through `seal` while the grace period still allows it.
        if (batch.length > 1) {
          for (const channel of batch) {
            await this.claimBatch([channel], requirements, result, resynced);
          }
          return;
        }
        const channel = batch[0]!;
        if (await this.seal(channel)) result.sealed.push(channel.channelId);
        return;
      }
      if (response.errorReason === BatchError.CUMULATIVE_AMOUNT_MISMATCH) {
        await this.resyncClaim(batch, requirements, response, result, resynced);
        return;
      }
      // A batch that did not land leaves its channels for the next pass;
      // the watermark is monotonic, so a repeat is harmless.
      this.reportClaimFailure(response);
      return;
    }
    if (response.network !== this.config.network) {
      this.config.onError?.(
        new Error(`${BATCH_SETTLEMENT_SCHEME} claim response bound to another network`),
      );
      return;
    }
    {
      // The spec's claim response is just `success`/`transaction`/`network`/
      // `amount`; the reference facilitator adds `extra.accepts[]` with each
      // channel's confirmed watermark. Use it when present. Otherwise read a
      // configured settled reader or `rpcUrl`, or record the voucher amount.
      const accepts = response.extra?.accepts;
      if (accepts !== undefined) {
        if (
          !Array.isArray(accepts) ||
          accepts.length !== batch.length ||
          batch.some(channel => {
            const matches = accepts.filter(
              item =>
                typeof item === "object" &&
                item !== null &&
                "channelId" in item &&
                item.channelId === channel.channelId,
            );
            return (
              matches.length !== 1 ||
              !("totalClaimed" in matches[0]!) ||
              matches[0]!.totalClaimed !== channel.signedMaxClaimable.toString()
            );
          })
        ) {
          this.config.onError?.(
            new Error(`${BATCH_SETTLEMENT_SCHEME} claim missing confirmed settled watermark`),
          );
          return;
        }
      }
      let claimedInBatch = 0;
      for (const channel of batch) {
        let settled = channel.signedMaxClaimable;
        if (accepts === undefined && this.hasSettledReader()) {
          try {
            const observed = await this.readSettledWatermark(channel.channelId);
            if (observed === undefined || observed < channel.signedMaxClaimable) {
              throw new Error("confirmed settled watermark unavailable or behind the claim");
            }
            settled = observed;
          } catch (error) {
            // Leave the voucher claimable for the next pass; `settle` is
            // monotonic, so a repeat cannot advance the watermark twice.
            this.config.onError?.(error);
            continue;
          }
        }
        await this.record(channel.channelId, state => ({
          ...state,
          onchainSyncedAt: Date.now(),
          settled: state.settled > settled ? state.settled : settled,
        }));
        result.claimed.push(channel.channelId);
        claimedInBatch++;
      }
      if (claimedInBatch > 0) {
        this.config.onClaim?.({
          transaction: response.transaction ?? "",
          vouchers: claimedInBatch,
        });
      }
    }
  }

  /**
   * Report a claim that did not land.
   *
   * @param response - The facilitator's rejection
   */
  private reportClaimFailure(response: SettleResponse): void {
    this.config.onError?.(
      new Error(`${BATCH_SETTLEMENT_SCHEME} claim failed: ${response.errorReason ?? "unknown"}`),
    );
  }

  /**
   * Resync from a claim the facilitator rejected as already applied: record the
   * channels whose confirmed `settled` covers their voucher and re-claim the
   * rest once. Confirmation is `extra.channelStates`, or a configured reader
   * when that snapshot is missing or unusable. A resynced channel is not a new
   * claim, so it does not reach `onClaim`.
   *
   * @param batch - The rejected claim batch
   * @param requirements - Terms the batch's channels were opened against
   * @param response - The rejection, possibly carrying `extra.channelStates`
   * @param result - Accumulates the pass outcome
   * @param result.claimed - Channels whose claim landed
   * @param result.sealed - Closing channels finalized through `seal`
   * @param resynced - Whether a resync re-claim already ran in this chain
   */
  private async resyncClaim(
    batch: ChannelState[],
    requirements: PaymentRequirements,
    response: SettleResponse,
    result: { claimed: string[]; sealed: string[] },
    resynced: boolean,
  ): Promise<void> {
    const states = this.adoptChannelStates(response, batch);
    const behind: ChannelState[] = [];
    for (const channel of batch) {
      const settled = await this.observeSettled(channel.channelId, states);
      if (settled === undefined || settled < channel.signedMaxClaimable) {
        behind.push(channel);
        continue;
      }
      await this.recordObserved(channel.channelId, { settled });
    }
    if (behind.length === batch.length || (behind.length > 0 && resynced)) {
      this.reportClaimFailure(response);
      return;
    }
    if (behind.length > 0) await this.claimBatch(behind, requirements, result, true);
  }

  /**
   * Finalize a channel the payer is closing with the server's latest voucher.
   *
   * Program `settle` is unavailable once a channel is `Closing`; only the
   * facilitator, as channel payee, can apply a final voucher through
   * `settle_and_seal` during the grace period. The server proves it authored
   * the request with a `CloseAuthorization` from its receiver authorizer.
   *
   * @param channel - The closing channel and its latest voucher
   * @returns Whether the seal landed
   */
  private async seal(channel: ChannelState): Promise<boolean> {
    const closeRequestedAt = channel.closeRequestedAt ?? 0;
    const graceElapsed =
      closeRequestedAt > 0 &&
      Math.floor(Date.now() / 1000) >= closeRequestedAt + channel.withdrawDelay;
    if (graceElapsed) {
      if (!this.graceElapsedReported.has(channel.channelId)) {
        this.graceElapsedReported.add(channel.channelId);
        this.config.onError?.(
          new Error(
            `${BATCH_SETTLEMENT_SCHEME} channel ${channel.channelId} grace period elapsed: ` +
              `voucher value above the onchain watermark can no longer be sealed`,
          ),
        );
      }
      return false;
    }
    // Whatever happens next, the payer has started a forced close: stop
    // serving paid requests against this channel.
    await this.record(channel.channelId, state =>
      state.status === "open" ? { ...state, status: "closing" } : state,
    );
    const requirements = this.termsFor(channel);
    const { network, maxTimeoutSeconds } = requirements;
    const expiresAt = channel.highestVoucherExpiresAt ?? 0;
    const authorizer = this.config.receiverAuthorizer;
    const closeAuthorization = authorizer
      ? await signCloseAuthorization(authorizer, {
          channelId: channel.channelId,
          feePayer: channel.feePayer,
          maxClaimableAmount: channel.signedMaxClaimable,
          network,
          validBefore: Math.floor(Date.now() / 1000) + maxTimeoutSeconds,
          voucherExpiresAt: BigInt(expiresAt),
        })
      : undefined;
    const payload: BatchSealPayload = {
      channelConfig: channel.channelConfig,
      channelId: channel.channelId,
      type: "seal",
      voucher: {
        channelId: channel.channelId,
        expiresAt,
        maxClaimableAmount: channel.signedMaxClaimable.toString(),
        signature: channel.highestVoucherSignature!,
      },
      ...(closeAuthorization ? { closeAuthorization } : {}),
    };
    const response = await this.config.settle(
      { accepted: requirements, payload, x402Version: 2 },
      requirements,
    );
    if (!response.success || response.network !== network) {
      if (!response.success && response.errorReason === BatchError.CLOSE_STATE) {
        if (await this.resyncSeal(channel, response)) return false;
      }
      this.config.onError?.(
        new Error(`${BATCH_SETTLEMENT_SCHEME} seal failed: ${response.errorReason ?? "unknown"}`),
      );
      return false;
    }
    const final = channel.signedMaxClaimable;
    await this.record(channel.channelId, state => ({
      ...state,
      onchainSyncedAt: Date.now(),
      payoutWatermark: state.payoutWatermark > final ? state.payoutWatermark : final,
      settled: state.settled > final ? state.settled : final,
      status: "distributed",
    }));
    this.config.onSeal?.({
      channel: channel.channelId,
      transaction: response.transaction ?? "",
    });
    return true;
  }

  /**
   * Resync from a seal the facilitator rejected because the channel is no longer
   * `Closing`. The snapshot is `extra.channelStates`, or a read through the
   * configured `rpcUrl` when that snapshot is missing or unusable. A sealed
   * channel is recorded as sealed, so a distribute still sweeps its unpaid
   * `settled`. A resynced seal is not a new one, so it does not reach `onSeal`.
   *
   * @param channel - The channel whose seal was rejected
   * @param response - The rejection, possibly carrying `extra.channelStates`
   * @returns Whether the channel is already paid out, which needs no further seal
   */
  private async resyncSeal(channel: ChannelState, response: SettleResponse): Promise<boolean> {
    let observed = this.adoptChannelStates(response, [channel])?.get(channel.channelId);
    if (!observed && this.configuredRpcUrl() !== undefined) {
      try {
        const read = await this.readSettlement(channel.channelId);
        const status = read ? redemptionStatusOf(read.status) : undefined;
        if (read && status) {
          observed = { payout: read.payoutWatermark, settled: read.settled, status };
        }
      } catch (error) {
        this.config.onError?.(error);
      }
    }
    if (observed?.status === "distributed") {
      await this.recordObserved(channel.channelId, observed);
      return true;
    }
    if (observed?.status === "sealed") await this.recordObserved(channel.channelId, observed);
    return false;
  }

  /**
   * Pay each newly settled delta to `payTo`.
   *
   * @param channels - Channels to consider paying out
   * @returns The channels whose distribution landed
   */
  private async distribute(channels: ChannelState[]): Promise<string[]> {
    const payable = channels.filter(
      channel =>
        (channel.status === "open" || channel.status === "sealed") &&
        channel.settled > channel.payoutWatermark,
    );
    const distributed: string[] = [];
    for (const group of this.groupByTerms(payable)) {
      for (const batch of chunk(group.channels, this.batchSize("maxSettleChannels"))) {
        const requirements = group.requirements;
        const response = await this.config.settle(
          {
            accepted: requirements,
            payload: {
              channels: batch.map(channel => ({
                channelConfig: channel.channelConfig,
                channelId: channel.channelId,
              })),
              type: "settle",
            },
            x402Version: 2,
          },
          requirements,
        );
        if (!response.success) {
          if (
            response.errorReason === BatchError.CUMULATIVE_AMOUNT_MISMATCH &&
            (await this.recordPayouts(batch, this.adoptChannelStates(response, batch))).length > 0
          ) {
            continue;
          }
          this.config.onError?.(
            new Error(
              `${BATCH_SETTLEMENT_SCHEME} distribute failed: ${response.errorReason ?? "unknown"}`,
            ),
          );
          continue;
        }
        if (response.network !== this.config.network) {
          this.config.onError?.(
            new Error(`${BATCH_SETTLEMENT_SCHEME} distribute response bound to another network`),
          );
          continue;
        }
        // `extra.channels[]` is the reference facilitator's addition, not a
        // spec field; when present it must name exactly this batch. The paid
        // watermark comes from `extra.channelStates`, then a configured reader
        // or `rpcUrl`; without one the channel stays payable.
        const channels = response.extra?.channels;
        if (
          channels !== undefined &&
          (!Array.isArray(channels) ||
            channels.length !== batch.length ||
            new Set(channels).size !== channels.length ||
            batch.some(channel => !channels.includes(channel.channelId)))
        ) {
          this.config.onError?.(
            new Error(`${BATCH_SETTLEMENT_SCHEME} distribute response channel mismatch`),
          );
          continue;
        }
        const states = this.adoptChannelStates(response, batch);
        if (!states && !this.hasPayoutReader()) {
          this.config.onError?.(
            new Error(
              "distribute confirmed but payout unknown: facilitator sent no channelStates and neither rpcUrl nor readPayoutWatermark is set",
            ),
          );
        }
        const paidOut = await this.recordPayouts(batch, states);
        distributed.push(...paidOut);
        if (paidOut.length > 0) {
          this.config.onSettle?.({ transaction: response.transaction ?? "" });
        }
      }
    }
    return distributed;
  }

  /**
   * Record the confirmed payout watermarks of a distribute batch. A response may
   * recover an earlier sweep that a later claim has passed, so a channel's
   * payout comes from the facilitator's state, or else a configured reader,
   * never from the signature alone. Without either, the channel stays payable.
   *
   * @param batch - The channels the distribute covered
   * @param states - The facilitator's adopted `extra.channelStates`, if usable
   * @returns The channels paid up to their settled value
   */
  private async recordPayouts(
    batch: ChannelState[],
    states: Map<string, ObservedChannel> | undefined,
  ): Promise<string[]> {
    const paidOut: string[] = [];
    for (const channel of batch) {
      const observed = await this.observePayout(channel, states);
      if (!observed) continue;
      try {
        await this.recordObserved(channel.channelId, observed);
        if ((observed.payout ?? 0n) >= channel.settled) paidOut.push(channel.channelId);
      } catch (error) {
        // Leave the balance payable for the next pass, including after restart.
        this.config.onError?.(error);
      }
    }
    return paidOut;
  }

  /**
   * A channel's confirmed settled watermark: the facilitator's state, else a
   * configured reader. An unusable snapshot does not skip the reader.
   *
   * @param channelId - Channel whose claimed state is being reconciled
   * @param states - Adopted `extra.channelStates`, if the response carried a usable set
   * @returns The settled watermark, or undefined when none was confirmed
   */
  private async observeSettled(
    channelId: string,
    states: Map<string, ObservedChannel> | undefined,
  ): Promise<bigint | undefined> {
    const adopted = states?.get(channelId);
    if (adopted) return adopted.settled;
    if (!this.hasSettledReader()) return undefined;
    try {
      return await this.readSettledWatermark(channelId);
    } catch (error) {
      this.config.onError?.(error);
      return undefined;
    }
  }

  /**
   * A channel's confirmed payout: the facilitator's state, else a configured
   * reader. An empty `rpcUrl` is not a reader.
   *
   * @param channel - The channel whose payout is being reconciled
   * @param states - Adopted `extra.channelStates`, if the response carried a usable set
   * @returns The observed payout, or undefined when none was confirmed
   */
  private async observePayout(
    channel: ChannelState,
    states: Map<string, ObservedChannel> | undefined,
  ): Promise<Partial<ObservedChannel> | undefined> {
    const adopted = states?.get(channel.channelId);
    if (adopted) return adopted;
    if (!this.hasPayoutReader()) return undefined;
    try {
      const paid = await this.readPayoutWatermark(channel.channelId);
      if (paid === undefined || paid < 0n || paid > channel.deposit) {
        this.config.onError?.(new Error("confirmed payout watermark unavailable or invalid"));
        return undefined;
      }
      return { payout: paid };
    } catch (error) {
      this.config.onError?.(error);
      return undefined;
    }
  }

  /**
   * The facilitator's `extra.channelStates` for a batch, or undefined unless the
   * response is bound to this network and names exactly the batch's channels,
   * each once, with every amount inside uint64 and
   * `payoutWatermark <= totalClaimed <= balance`.
   *
   * @param response - The facilitator's settle response
   * @param batch - The channels the request covered
   * @returns The observed state keyed by channel, or undefined to ignore the field
   */
  private adoptChannelStates(
    response: SettleResponse,
    batch: ChannelState[],
  ): Map<string, ObservedChannel> | undefined {
    const entries = response.extra?.channelStates;
    if (
      response.network !== this.config.network ||
      !Array.isArray(entries) ||
      entries.length !== batch.length
    ) {
      return undefined;
    }
    const observed = new Map<string, ObservedChannel>();
    for (const entry of entries) {
      if (!isBatchRedemptionChannelState(entry) || observed.has(entry.channelId)) return undefined;
      const balance = BigInt(entry.balance);
      const settled = BigInt(entry.totalClaimed);
      const payout = BigInt(entry.payoutWatermark);
      if (
        balance > U64_MAX ||
        settled > U64_MAX ||
        payout > U64_MAX ||
        payout > settled ||
        settled > balance
      ) {
        return undefined;
      }
      observed.set(entry.channelId, { payout, settled, status: entry.status });
    }
    return batch.every(channel => observed.has(channel.channelId)) ? observed : undefined;
  }

  /**
   * Raise a channel's watermarks to the observed ones and mark it sealed or
   * distributed once the chain says it is.
   *
   * @param channelId - Channel to update
   * @param observed - What was confirmed; an absent field leaves the stored one alone
   */
  private async recordObserved(
    channelId: string,
    observed: Partial<ObservedChannel>,
  ): Promise<void> {
    await this.record(channelId, state => ({
      ...state,
      onchainSyncedAt: Date.now(),
      payoutWatermark: larger(state.payoutWatermark, observed.payout ?? 0n),
      settled: larger(state.settled, observed.settled ?? 0n),
      status: statusAfter(state.status, observed.status),
    }));
  }

  /**
   * Whether a settled watermark can be read without a public RPC.
   *
   * @returns True when `readSettledWatermark` or a non-empty `rpcUrl` is set
   */
  private hasSettledReader(): boolean {
    return this.config.readSettledWatermark !== undefined || this.configuredRpcUrl() !== undefined;
  }

  /**
   * Whether a payout watermark can be read without a public RPC.
   *
   * @returns True when `readPayoutWatermark` or a non-empty `rpcUrl` is set
   */
  private hasPayoutReader(): boolean {
    return this.config.readPayoutWatermark !== undefined || this.configuredRpcUrl() !== undefined;
  }

  /**
   * The configured RPC endpoint.
   *
   * @returns Non-empty `rpcUrl`, or undefined when chain reads through RPC are off
   */
  private configuredRpcUrl(): string | undefined {
    return this.config.rpcUrl || undefined;
  }

  /**
   * Read a conservative paid watermark; stale reads delay bookkeeping, never advance it too far.
   *
   * @param channelId - Channel whose paid state is being reconciled
   * @returns Observed payout watermark, or undefined if the account is absent
   */
  private async readPayoutWatermark(channelId: string): Promise<bigint | undefined> {
    if (this.config.readPayoutWatermark) return this.config.readPayoutWatermark(channelId);
    return (await this.readSettlement(channelId))?.payoutWatermark;
  }

  /**
   * Read the confirmed onchain `settled` watermark for a channel.
   *
   * @param channelId - Channel whose claimed state is being reconciled
   * @returns Observed settled watermark, or undefined if the account is absent
   */
  private async readSettledWatermark(channelId: string): Promise<bigint | undefined> {
    if (this.config.readSettledWatermark) return this.config.readSettledWatermark(channelId);
    return (await this.readSettlement(channelId))?.settled;
  }

  /**
   * Decode the confirmed settlement fields of a channel account.
   *
   * @param channelId - Channel account to read
   * @returns The channel's settlement fields, or undefined if the account is absent
   */
  private async readSettlement(channelId: string): Promise<
    | {
        settled: bigint;
        payoutWatermark: bigint;
        status: number;
      }
    | undefined
  > {
    const rpcUrl = this.configuredRpcUrl();
    if (rpcUrl === undefined) {
      throw new Error(
        `${BATCH_SETTLEMENT_SCHEME} watermark read requires rpcUrl or a watermark reader`,
      );
    }
    const rpc = createRpcClient(this.config.network, rpcUrl);
    const account = await rpc
      .getAccountInfo(address(channelId), { commitment: "confirmed", encoding: "base64" })
      .send();
    if (!account.value) return undefined;
    if (account.value.owner !== PAYMENT_CHANNELS_PROGRAM_ID)
      throw new Error("unexpected channel account owner");
    const decoded = getChannelDecoder().decode(Buffer.from(account.value.data[0], "base64"));
    return {
      payoutWatermark: decoded.settlement.payoutWatermark,
      settled: decoded.settlement.settled,
      status: decoded.status,
    };
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
   * Terms from `channelConfig`, which the facilitator checks.
   *
   * @param channel - Channel to redeem
   * @returns Requirements for that channel
   */
  private termsFor(channel: ChannelState): PaymentRequirements {
    const { channelConfig } = channel;
    const serverSigned = channelConfig.voucherSigner === "server";
    return {
      scheme: BATCH_SETTLEMENT_SCHEME,
      network: this.config.network,
      asset: channelConfig.token,
      payTo: channelConfig.receiver,
      amount: "0",
      maxTimeoutSeconds: REDEMPTION_TIMEOUT_SECONDS,
      extra: {
        feePayer: channel.feePayer,
        tokenProgram: channel.tokenProgram,
        withdrawDelay: channelConfig.withdrawDelay,
        receiverAuthorizer: channelConfig.receiverAuthorizer,
        ...(serverSigned
          ? { operator: channelConfig.payerAuthorizer, voucherSigner: "server" }
          : {}),
      },
    };
  }

  /**
   * Partition channels by redemption terms, in first-seen order.
   *
   * @param channels - Channels to redeem
   * @returns One group per distinct terms
   */
  private groupByTerms(
    channels: ChannelState[],
  ): { requirements: PaymentRequirements; channels: ChannelState[] }[] {
    const groups = new Map<
      string,
      { requirements: PaymentRequirements; channels: ChannelState[] }
    >();
    for (const channel of channels) {
      const requirements = this.termsFor(channel);
      const key = JSON.stringify(requirements);
      const group = groups.get(key);
      if (group) group.channels.push(channel);
      else groups.set(key, { requirements, channels: [channel] });
    }
    return [...groups.values()];
  }

  /**
   * Channels to pack into one redemption transaction.
   *
   * @param field - `maxClaimChannels` for claims, `maxSettleChannels` for distributions
   * @returns The batch size
   */
  private batchSize(field: "maxClaimChannels" | "maxSettleChannels"): number {
    const advertised = this.config.capacity?.()?.[field];
    // Never above the protocol maximum: a facilitator misadvertising a larger
    // capacity would otherwise get batches the wire guard rejects.
    const ceiling = field === "maxClaimChannels" ? V1_MAX_CLAIM_CHANNELS : V1_MAX_SETTLE_CHANNELS;
    const capacity =
      typeof advertised === "number" && Number.isSafeInteger(advertised) && advertised > 0
        ? Math.min(advertised, ceiling)
        : DEFAULT_CHANNELS_PER_BATCH;
    return Math.min(capacity, Math.max(1, this.config.maxChannelsPerBatch ?? capacity));
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

/**
 * The greater of two watermarks.
 *
 * @param a - A watermark
 * @param b - Another watermark
 * @returns The greater one
 */
function larger(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * The stored status once the chain reports `observed`: a paid-out channel is
 * final, and a sealed one never replaces it.
 *
 * @param current - The stored status
 * @param observed - The status the facilitator reported, if any
 * @returns The status to store
 */
function statusAfter(
  current: BatchChannelStatus,
  observed: BatchRedemptionStatus | undefined,
): BatchChannelStatus {
  if (observed === "distributed") return "distributed";
  if (observed === "sealed" && current !== "distributed") return "sealed";
  return current;
}
