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
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";

import { signCloseAuthorization } from "../closeAuthorization";
import { BatchError } from "../errors";
import { BATCH_SETTLEMENT_SCHEME, type BatchSealPayload } from "../types";
import type { ChannelState, ChannelStore } from "./types";

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
  /** Channels per claim or distribute transaction. Defaults to, and is capped at, the spec's four. */
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
    for (const batch of chunk(claimable, this.batchSize())) {
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
   */
  private async claimBatch(
    batch: ChannelState[],
    result: { claimed: string[]; sealed: string[] },
  ): Promise<void> {
    const response = await this.config.settle(
      {
        accepted: this.config.requirements,
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
      this.config.requirements,
    );
    if (!response.success) {
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
      // A batch that did not land leaves its channels for the next pass;
      // the watermark is monotonic, so a repeat is harmless.
      this.config.onError?.(
        new Error(`${BATCH_SETTLEMENT_SCHEME} claim failed: ${response.errorReason ?? "unknown"}`),
      );
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
      if (claimedInBatch > 0) {
        this.config.onClaim?.({
          transaction: response.transaction ?? "",
          vouchers: claimedInBatch,
        });
      }
    }
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
    const response = await this.config.settle(
      { accepted: this.config.requirements, payload, x402Version: 2 },
      this.config.requirements,
    );
    if (!response.success || response.network !== network) {
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
      if (response.network !== this.config.requirements.network) {
        this.config.onError?.(
          new Error(`${BATCH_SETTLEMENT_SCHEME} distribute response bound to another network`),
        );
        continue;
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
        continue;
      }
      let distributedInBatch = 0;
      for (const channel of batch) {
        try {
          // This response may recover an earlier sweep. A channel ID and a
          // successful signature do not prove that today's full claim was paid.
          const paid = await this.readPayoutWatermark(channel.channelId);
          if (paid === undefined || paid < 0n || paid > channel.deposit)
            throw new Error("confirmed payout watermark unavailable or invalid");
          await this.record(channel.channelId, state => ({
            ...state,
            onchainSyncedAt: Date.now(),
            payoutWatermark: state.payoutWatermark > paid ? state.payoutWatermark : paid,
          }));
          if (paid >= channel.settled) {
            distributed.push(channel.channelId);
            distributedInBatch++;
          }
        } catch (error) {
          // Leave the balance payable for the next pass, including after restart.
          this.config.onError?.(error);
        }
      }
      if (distributedInBatch > 0) {
        this.config.onSettle?.({ transaction: response.transaction ?? "" });
      }
    }
    return distributed;
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
   * How many channels one redemption transaction carries.
   *
   * @returns Channels to pack into one redemption transaction
   */
  private batchSize(): number {
    // Clamp to the spec's ceiling: a `claims[]` or `channels[]` array longer
    // than four is not a valid request (spec 4.5).
    return Math.min(
      MAX_CHANNELS_PER_BATCH,
      Math.max(1, this.config.maxChannelsPerBatch ?? MAX_CHANNELS_PER_BATCH),
    );
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
