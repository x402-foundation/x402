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
import { SettleError, type PaymentRequirements, type SettleResponse } from "@x402/core/types";

import { ErrSettlementPending } from "../../exact/facilitator/errors";
import { signCloseAuthorization } from "../closeAuthorization";
import { BatchError } from "../errors";
import { V1_MAX_CLAIM_CHANNELS, V1_MAX_SETTLE_CHANNELS } from "../facilitator/constants";
import { BATCH_SETTLEMENT_SCHEME, type BatchSealPayload } from "../types";
import { CHANNEL_BUSY } from "./constants";
import type { ChannelState, ChannelStore } from "./types";

/**
 * The spec packs no more than four channels into one claim transaction, and a
 * full batch is never silently truncated.
 */
/** Channels per claim or settle request when the facilitator advertises no capacity. */
const DEFAULT_CHANNELS_PER_BATCH = 4;

/**
 * Failure reasons that mean the same request may still land: the facilitator
 * broadcast it (`settlement_pending`) or is already working on it
 * (`duplicate_settlement`). Such a batch is not split into new requests for
 * the same vouchers; it is left for a later pass.
 */
const RETRY_UNCHANGED_REASONS: ReadonlySet<string> = new Set([ErrSettlementPending, CHANNEL_BUSY]);

/**
 * 4xx statuses that ask the client to retry later rather than refuse the
 * request: 408 Request Timeout and 425 Too Early (RFC 9110 15.5.9, RFC 8470),
 * 429 Too Many Requests (RFC 6585). With every 5xx, they are not evidence that
 * nothing was broadcast, so a batch answered with one is not split.
 */
const RETRY_LATER_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/** A facilitator's answer to one redemption request. */
interface RedemptionAnswer {
  response: SettleResponse;
  /** HTTP status when the answer was thrown as a `SettleError`; absent when it was returned. */
  status?: number | undefined;
  /** The `SettleError` the answer was thrown as, kept for the report. */
  thrown?: SettleError | undefined;
}

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
  /** Channels per claim or distribute transaction, capped at the facilitator's advertised capacity. */
  maxChannelsPerBatch?: number | undefined;
  /**
   * RPC endpoint for confirmed watermark reads. Omit to use the public
   * endpoint for `requirements.network`.
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
  /**
   * Reports a redemption request or pass that failed, so an operator can see
   * it. When the facilitator answers a request with a failure or a refusal,
   * the request's channels are left for the next pass and the rest of the
   * pass continues. A request that gets no answer (a timeout, a network
   * error) still ends the pass and rejects `redeem()`.
   */
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
   * Channels the facilitator refused on their own while the rest of their
   * batch was not, per step. Later passes submit them alone until a request
   * for them is accepted, so a channel the facilitator keeps refusing does not
   * fail a batch of other channels every pass.
   */
  private readonly isolated = { claim: new Set<string>(), settle: new Set<string>() };
  /**
   * Batches sent but not yet answered for good, per step: each channel set
   * stays here from submission until the facilitator accepts it, refuses it
   * outright or reports a closing channel. A batch whose outcome is still
   * open (pending, in flight, a 5xx, no answer) is sent again with the same
   * channels on later passes instead of being re-packed into a new request
   * for the same vouchers. The reference facilitator keys a distribute retry
   * on the channel set and a claim retry on each channel's id and voucher
   * amount. The retry is rebuilt from the store, not replayed, so a newer
   * voucher, a channel leaving the step or an outright refusal of the retry
   * makes the next request new to the facilitator; while the first
   * transaction is in flight both can be broadcast. The onchain watermark
   * only moves forward, so that costs at most a failed transaction, and the
   * `cumulative_amount_mismatch` resync records the one that landed.
   */
  private readonly unresolved = {
    claim: new Map<string, string[]>(),
    settle: new Map<string, string[]>(),
  };

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
    for (const batch of this.batches(claimable, "claim")) {
      await this.claimBatch(batch, result);
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
   * @param result - Accumulates the pass outcome
   * @param result.claimed - Channels whose claim landed
   * @param result.sealed - Closing channels finalized through `seal`
   * @param refusedAlone - Collects this channel when a one-channel batch is refused outright
   */
  private async claimBatch(
    batch: ChannelState[],
    result: { claimed: string[]; sealed: string[] },
    refusedAlone?: string[],
  ): Promise<void> {
    this.unresolved.claim.set(batchKey(batch), ids(batch));
    const answer = await this.submit({
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
    });
    const { response, status } = answer;
    if (!response.success) {
      const failed = `${BATCH_SETTLEMENT_SCHEME} claim failed: ${response.errorReason ?? "unknown"}`;
      if (response.errorReason === BatchError.CUMULATIVE_AMOUNT_MISMATCH) {
        // The chain already holds a voucher this batch names, most likely
        // from an earlier request that landed without this worker seeing it
        // confirmed. Record what the chain shows and claim the rest again;
        // each retry is smaller, so this ends.
        const behind = await this.resyncClaim(batch);
        if (behind.length < batch.length) {
          this.unresolved.claim.delete(batchKey(batch));
          if (behind.length > 0) await this.claimBatch(behind, result, refusedAlone);
          return;
        }
      }
      const outright = refusedOutright(response, status);
      // Answered for good: these channels need not travel together again.
      if (outright || response.errorReason === BatchError.CHANNEL_CLOSING) {
        this.unresolved.claim.delete(batchKey(batch));
      }
      if (response.errorReason === BatchError.CHANNEL_CLOSING) {
        // The payer started a forced close on at least one channel in the
        // batch, so program `settle` is no longer available for it. Claim the
        // others one by one and finalize the closing one with its latest
        // voucher through `seal` while the grace period still allows it.
        if (batch.length > 1) {
          for (const channel of batch) await this.claimBatch([channel], result);
          return;
        }
        const channel = batch[0]!;
        if (await this.seal(channel)) result.sealed.push(channel.channelId);
        return;
      }
      if (outright) {
        // The facilitator refused the request outright: a policy hook, or one
        // voucher it rejects. One such channel must not hold back the others
        // packed with it, so claim each alone and let the refusal stop only
        // the channel that caused it.
        if (batch.length > 1) {
          const refused: string[] = [];
          for (const channel of batch) await this.claimBatch([channel], result, refused);
          // No channel was refused on its own, so the refusal was about the
          // batch as a whole: report it once.
          if (refused.length === 0) this.config.onError?.(failure(failed, answer));
          this.isolate("claim", batch, refused);
          return;
        }
        refusedAlone?.push(batch[0]!.channelId);
      }
      // A batch that did not land leaves its channels for the next pass;
      // the watermark is monotonic, so a repeat is harmless.
      this.config.onError?.(failure(failed, answer));
      return;
    }
    if (response.network !== this.config.requirements.network) {
      this.config.onError?.(
        new Error(`${BATCH_SETTLEMENT_SCHEME} claim response bound to another network`),
      );
      return;
    }
    {
      // The spec's claim response is just `success`/`transaction`/`network`/
      // `amount`; the reference facilitator adds `extra.accepts[]` with each
      // channel's confirmed watermark. Use it when present, otherwise read the
      // watermark from the chain so any conforming facilitator works.
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
        // Accepted: pack it with the others again from the next pass on.
        this.isolated.claim.delete(channel.channelId);
        let settled = channel.signedMaxClaimable;
        if (accepts === undefined) {
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
      // Every channel recorded: the batch is resolved. Otherwise it stays
      // pinned, so the facilitator can replay the same claim next pass.
      if (claimedInBatch === batch.length) this.unresolved.claim.delete(batchKey(batch));
      if (claimedInBatch > 0) {
        this.config.onClaim?.({
          transaction: response.transaction ?? "",
          vouchers: claimedInBatch,
        });
      }
    }
  }

  /**
   * Record each channel of a batch whose voucher the chain has already
   * settled. Like a confirmed claim, the confirmed `settled` watermark is
   * what gets recorded. These channels were claimed by an earlier request, so
   * they do not count as claimed in this pass or reach `onClaim`.
   *
   * @param batch - Channels whose claim was answered `cumulative_amount_mismatch`
   * @returns The channels the chain shows still behind their voucher
   */
  private async resyncClaim(batch: ChannelState[]): Promise<ChannelState[]> {
    const behind: ChannelState[] = [];
    for (const channel of batch) {
      let observed: bigint | undefined;
      try {
        observed = await this.readSettledWatermark(channel.channelId);
      } catch (error) {
        this.config.onError?.(error);
      }
      if (observed === undefined || observed < channel.signedMaxClaimable) {
        behind.push(channel);
        continue;
      }
      const settled = observed;
      await this.record(channel.channelId, state => ({
        ...state,
        onchainSyncedAt: Date.now(),
        settled: state.settled > settled ? state.settled : settled,
      }));
    }
    return behind;
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
    const feePayer = this.config.requirements.extra?.feePayer;
    if (typeof feePayer !== "string") {
      this.config.onError?.(
        new Error(`${BATCH_SETTLEMENT_SCHEME} seal requires requirements.extra.feePayer`),
      );
      return false;
    }
    const { network, maxTimeoutSeconds } = this.config.requirements;
    const expiresAt = channel.highestVoucherExpiresAt ?? 0;
    const authorizer = this.config.receiverAuthorizer;
    const closeAuthorization = authorizer
      ? await signCloseAuthorization(authorizer, {
          channelId: channel.channelId,
          feePayer,
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
    const answer = await this.submit(payload);
    const { response } = answer;
    if (!response.success || response.network !== network) {
      this.config.onError?.(
        failure(
          `${BATCH_SETTLEMENT_SCHEME} seal failed: ${response.errorReason ?? "unknown"}`,
          answer,
        ),
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
    for (const batch of this.batches(payable, "settle")) {
      await this.distributeBatch(batch, distributed);
    }
    return distributed;
  }

  /**
   * Distribute one batch, retrying its channels one by one if the facilitator
   * refuses it outright.
   *
   * @param batch - Channels packed into one distribute transaction
   * @param distributed - Accumulates the channels whose distribution landed
   * @param refusedAlone - Collects this channel when a one-channel batch is refused outright
   */
  private async distributeBatch(
    batch: ChannelState[],
    distributed: string[],
    refusedAlone?: string[],
  ): Promise<void> {
    this.unresolved.settle.set(batchKey(batch), ids(batch));
    const answer = await this.submit({
      channels: batch.map(channel => ({
        channelConfig: channel.channelConfig,
        channelId: channel.channelId,
      })),
      type: "settle",
    });
    const { response, status } = answer;
    if (!response.success) {
      const failed = `${BATCH_SETTLEMENT_SCHEME} distribute failed: ${response.errorReason ?? "unknown"}`;
      // Nothing in the batch is left to pay out, most likely because an
      // earlier distribute landed without this worker seeing it confirmed.
      // Channels the chain shows paid up need nothing more; as with claims,
      // they do not count as distributed in this pass or reach `onSettle`.
      if (
        response.errorReason === BatchError.CUMULATIVE_AMOUNT_MISMATCH &&
        (await this.recordPayouts(batch)).length > 0
      ) {
        this.unresolved.settle.delete(batchKey(batch));
        return;
      }
      if (refusedOutright(response, status)) {
        this.unresolved.settle.delete(batchKey(batch));
        // As for claims: a channel the facilitator refuses must not hold back
        // the payout of the others packed with it.
        if (batch.length > 1) {
          const refused: string[] = [];
          for (const channel of batch) await this.distributeBatch([channel], distributed, refused);
          if (refused.length === 0) this.config.onError?.(failure(failed, answer));
          this.isolate("settle", batch, refused);
          return;
        }
        refusedAlone?.push(batch[0]!.channelId);
      }
      this.config.onError?.(failure(failed, answer));
      return;
    }
    if (response.network !== this.config.requirements.network) {
      this.config.onError?.(
        new Error(`${BATCH_SETTLEMENT_SCHEME} distribute response bound to another network`),
      );
      return;
    }
    // `extra.channels[]` is the reference facilitator's addition, not a
    // spec field; when present it must name exactly this batch. The paid
    // watermark is always reconciled from the chain below either way.
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
      return;
    }
    // Accepted and bound to this batch: each channel's payout is reconciled
    // from the chain below, and a balance still owed is re-packed freely.
    this.unresolved.settle.delete(batchKey(batch));
    // Accepted: pack these with the others again from the next pass on.
    for (const channel of batch) this.isolated.settle.delete(channel.channelId);
    // This response may recover an earlier sweep. A channel ID and a
    // successful signature do not prove that today's full claim was paid.
    const paidOut = await this.recordPayouts(batch);
    distributed.push(...paidOut);
    if (paidOut.length > 0) {
      this.config.onSettle?.({ transaction: response.transaction ?? "" });
    }
  }

  /**
   * Record each channel's confirmed payout watermark.
   *
   * @param batch - Channels a distribute named
   * @returns The channels the chain shows paid up to their settled value
   */
  private async recordPayouts(batch: ChannelState[]): Promise<string[]> {
    const paidOut: string[] = [];
    for (const channel of batch) {
      try {
        const paid = await this.readPayoutWatermark(channel.channelId);
        if (paid === undefined || paid < 0n || paid > channel.deposit)
          throw new Error("confirmed payout watermark unavailable or invalid");
        await this.record(channel.channelId, state => ({
          ...state,
          onchainSyncedAt: Date.now(),
          payoutWatermark: state.payoutWatermark > paid ? state.payoutWatermark : paid,
        }));
        if (paid >= channel.settled) paidOut.push(channel.channelId);
      } catch (error) {
        // Leave the balance payable for the next pass, including after restart.
        this.config.onError?.(error);
      }
    }
    return paidOut;
  }

  /**
   * Submit one server-authored redemption payload.
   *
   * `HTTPFacilitatorClient.settle` throws a `SettleError` for any non-2xx
   * answer that carries a settle response, such as a 403 from a policy hook.
   * That answer is turned back into the failed response it carries, so one
   * refused request is handled like any other failure instead of ending the
   * pass. Anything else thrown (a timeout, a network error, an unreadable
   * body) means there was no answer at all; it is rethrown and ends the pass,
   * as before.
   *
   * @param payload - The claim, settle or seal payload
   * @returns The facilitator's answer, with its HTTP status when it was thrown
   */
  private async submit(payload: unknown): Promise<RedemptionAnswer> {
    try {
      return {
        response: await this.config.settle(
          { accepted: this.config.requirements, payload, x402Version: 2 },
          this.config.requirements,
        ),
      };
    } catch (error) {
      if (!isSettleError(error)) throw error;
      return {
        response: {
          errorReason: error.errorReason,
          network: error.network,
          success: false,
          transaction: error.transaction ?? "",
        },
        status: error.statusCode,
        thrown: error,
      };
    }
  }

  /**
   * Remember the channels a split batch narrowed a refusal down to, so later
   * passes submit them alone. When every channel was refused, the refusal
   * belonged to the request (a facilitator outage or misconfiguration), not to
   * one channel, and nothing is remembered.
   *
   * @param step - `claim` or `settle` (distribute)
   * @param batch - The batch that was split
   * @param refused - Its channels the facilitator refused again on their own
   */
  private isolate(step: "claim" | "settle", batch: ChannelState[], refused: string[]): void {
    if (refused.length === batch.length) return;
    for (const channelId of refused) this.isolated[step].add(channelId);
  }

  /**
   * Pack channels into redemption batches: first each unresolved batch from
   * an earlier pass, with the same channels, then the others in batches of
   * the advertised capacity, then each channel the facilitator refused on its
   * own in an earlier pass, alone. An unresolved batch with a channel that no
   * longer needs this step cannot be sent unchanged, so it is dropped and its
   * other channels are packed like the rest.
   *
   * @param channels - Channels to redeem in this step
   * @param step - `claim` or `settle` (distribute)
   * @returns The batches, in submission order
   */
  private batches(channels: ChannelState[], step: "claim" | "settle"): ChannelState[][] {
    const byId = new Map(channels.map(channel => [channel.channelId, channel]));
    const kept: ChannelState[][] = [];
    const taken = new Set<string>();
    for (const [key, members] of this.unresolved[step]) {
      const batch = members.map(channelId => byId.get(channelId));
      if (batch.some(channel => channel === undefined) || members.some(id => taken.has(id))) {
        this.unresolved[step].delete(key);
        continue;
      }
      kept.push(batch as ChannelState[]);
      for (const channelId of members) taken.add(channelId);
    }
    const rest = channels.filter(channel => !taken.has(channel.channelId));
    const isolated = this.isolated[step];
    const packable = rest.filter(channel => !isolated.has(channel.channelId));
    const alone = rest.filter(channel => isolated.has(channel.channelId));
    const size = this.batchSize(step === "claim" ? "maxClaimChannels" : "maxSettleChannels");
    return [...kept, ...chunk(packable, size), ...alone.map(channel => [channel])];
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
  private async readSettlement(
    channelId: string,
  ): Promise<{ settled: bigint; payoutWatermark: bigint } | undefined> {
    const rpc = createRpcClient(this.config.requirements.network, this.config.rpcUrl);
    const account = await rpc
      .getAccountInfo(address(channelId), { commitment: "confirmed", encoding: "base64" })
      .send();
    if (!account.value) return undefined;
    if (account.value.owner !== PAYMENT_CHANNELS_PROGRAM_ID)
      throw new Error("unexpected channel account owner");
    const { settled, payoutWatermark } = getChannelDecoder().decode(
      Buffer.from(account.value.data[0], "base64"),
    ).settlement;
    return { settled, payoutWatermark };
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
   * How many channels one redemption transaction carries: the facilitator's
   * advertised capacity copied into the requirements (four when absent,
   * clamped to the protocol maximum),
   * narrowed by `maxChannelsPerBatch`. A `claims[]` or `channels[]` longer
   * than that capacity is not a valid request.
   *
   * @param field - `maxClaimChannels` for claims, `maxSettleChannels` for distributions
   * @returns Channels to pack into one redemption transaction
   */
  private batchSize(field: "maxClaimChannels" | "maxSettleChannels"): number {
    const advertised = this.config.requirements.extra?.[field];
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
 * Whether the facilitator refused a redemption outright, before anything was
 * broadcast, so its channels can safely be resubmitted in smaller batches.
 * A failure that names a transaction, says the same request is pending or
 * already in flight, or was thrown with a 5xx or retry-later status may
 * still land or pass on its own, and is not split.
 *
 * @param response - The failed settle response
 * @param status - HTTP status of a thrown `SettleError`; absent for a returned response
 * @returns Whether the batch can be split
 */
function refusedOutright(response: SettleResponse, status: number | undefined): boolean {
  if (response.transaction || RETRY_UNCHANGED_REASONS.has(response.errorReason ?? "")) {
    return false;
  }
  return (
    status === undefined || (status >= 400 && status < 500 && !RETRY_LATER_STATUSES.has(status))
  );
}

/**
 * The error reported for a failed request. A thrown `SettleError` is kept as
 * its `cause`, so the facilitator's message, status and payer reach `onError`.
 *
 * @param message - What failed and why
 * @param answer - The facilitator's answer
 * @returns The error to report
 */
function failure(message: string, answer: RedemptionAnswer): Error {
  const error = new Error(message);
  return answer.thrown ? Object.assign(error, { cause: answer.thrown }) : error;
}

/**
 * Whether a thrown value is a facilitator's failed settle response.
 *
 * Matched by name as well, since the facilitator client may come from another
 * copy of `@x402/core` than this package's.
 *
 * @param error - The thrown value
 * @returns Whether it carries a settle response
 */
function isSettleError(error: unknown): error is SettleError {
  return error instanceof SettleError || (error instanceof Error && error.name === "SettleError");
}

/**
 * The channel IDs of a batch, in order.
 *
 * @param batch - Channels packed into one request
 * @returns Their IDs
 */
function ids(batch: ChannelState[]): string[] {
  return batch.map(channel => channel.channelId);
}

/**
 * A batch's identity regardless of order, as the facilitator keys it.
 *
 * @param batch - Channels packed into one request
 * @returns The sorted channel IDs, joined
 */
function batchKey(batch: ChannelState[]): string {
  return ids(batch).sort().join(",");
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
