import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import type { BatchSettlementVoucherClaim } from "../types";
import type { BatchSettlementEvmScheme } from "./scheme";
import { computeChannelId } from "../utils";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import type { Channel } from "./storage";

export interface ChannelManagerConfig {
  scheme: BatchSettlementEvmScheme;
  facilitator: FacilitatorClient;
  receiver: `0x${string}`;
  token: `0x${string}`;
  network: Network;
}

export type ClaimChannelSelector = (
  channels: Channel[],
  context: AutoSettlementContext,
) => Channel[] | Promise<Channel[]>;

export interface ClaimOptions {
  maxClaimsPerBatch?: number;
  idleSecs?: number;
  selectClaimChannels?: ClaimChannelSelector;
}

export interface AutoSettlementConfig {
  claimIntervalSecs?: number;
  settleIntervalSecs?: number;
  refundIntervalSecs?: number;
  maxClaimsPerBatch?: number;
  selectClaimChannels?: ClaimChannelSelector;
  shouldSettle?: (context: AutoSettlementContext) => boolean | Promise<boolean>;
  selectRefundChannels?: (
    channels: Channel[],
    context: AutoSettlementContext,
  ) => Channel[] | Promise<Channel[]>;
  onClaim?: (result: ClaimResult) => void;
  onSettle?: (result: SettleResult) => void;
  onRefund?: (result: RefundResult) => void;
  onError?: (error: unknown) => void;
}

export interface AutoSettlementContext {
  now: number;
  lastClaimTime: number;
  lastSettleTime: number;
  pendingSettle: boolean;
}

export interface ClaimResult {
  vouchers: number;
  transaction: string;
}

export interface SettleResult {
  transaction: string;
}

export interface RefundResult {
  channel: string;
  transaction: string;
}

type AutoJob = "claim" | "settle" | "refund";

const AUTO_JOB_PRIORITY: AutoJob[] = ["claim", "settle", "refund"];

/**
 * Formats a `Facilitator.settle()` failure into a human-readable error message.
 *
 * @param operation - Operation label (e.g. `"Claim"`, `"Settle"`, `"Refund"`).
 * @param response - The failed settle response.
 * @returns Error message including reason and (when available) facilitator-provided detail.
 */
function formatFacilitatorFailure(operation: string, response: SettleResponse): string {
  return `${operation} failed: ${response.errorReason ?? "unknown"} — ${response.errorMessage ?? ""}`;
}

/**
 * Checks whether a channel has a non-expired payer request reservation.
 *
 * @param channel - Channel state to inspect.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Whether the channel is busy with a live pending request.
 */
function hasLivePendingRequest(channel: Channel, now = Date.now()): boolean {
  return channel.pendingRequest !== undefined && channel.pendingRequest.expiresAt > now;
}

/**
 * Manages the server-side channel lifecycle for the `batch-settlement` scheme:
 * batch claiming of vouchers, settlement of claimed funds, and cooperative refund.
 *
 * Provides one-shot operations (`claim()`, `settle()`, `claimAndSettle()`,
 * `refundIdleChannels()`) and an optional interval runner.
 */
export class BatchSettlementChannelManager {
  private readonly scheme: BatchSettlementEvmScheme;
  private readonly facilitator: FacilitatorClient;
  private readonly receiver: `0x${string}`;
  private readonly token: `0x${string}`;
  private readonly network: Network;

  private timers: Partial<Record<AutoJob, ReturnType<typeof setInterval>>> = {};
  private lastClaimTime = 0;
  private lastSettleTime = 0;
  private pendingSettle = false;
  private running = false;
  private pendingJobs = new Set<AutoJob>();
  private drainingJobs = false;
  private autoSettleConfig: AutoSettlementConfig = {};

  /**
   * Creates a new channel manager.
   *
   * @param config - Manager configuration: scheme, facilitator, receiver, token, network.
   */
  constructor(config: ChannelManagerConfig) {
    this.scheme = config.scheme;
    this.facilitator = config.facilitator;
    this.receiver = config.receiver;
    this.token = config.token;
    this.network = config.network;
  }

  /**
   * Collects claimable vouchers and submits them in batches to the facilitator via `claim()`.
   *
   * @param opts - Optional claim execution and target selection options.
   * @param opts.maxClaimsPerBatch - Max vouchers per facilitator `claim` batch.
   * @param opts.idleSecs - When set, only include channels idle for at least this many seconds.
   * @param opts.selectClaimChannels - Optional selector for choosing channels before claimability checks.
   * @returns Array of claim results (one per batch).
   */
  async claim(opts?: ClaimOptions): Promise<ClaimResult[]> {
    const channels = await this.selectClaimTargets(opts);
    return this.claimFromChannels(channels, {
      maxClaimsPerBatch: opts?.maxClaimsPerBatch ?? 100,
      ...(opts?.idleSecs !== undefined ? { idleSecs: opts.idleSecs } : {}),
    });
  }

  /**
   * Transfers claimed (but unsettled) funds to the receiver by calling `settle(receiver, token)`.
   *
   * @returns Settle result with the transaction hash.
   */
  async settle(): Promise<SettleResult> {
    const paymentPayload = this.buildSettlePaymentPayload();
    const requirements = this.buildPaymentRequirements();

    const response = await this.facilitator.settle(paymentPayload, requirements);
    if (!response.success) {
      throw new Error(formatFacilitatorFailure("Settle", response));
    }

    this.pendingSettle = false;
    return { transaction: response.transaction };
  }

  /**
   * Convenience: claims all eligible vouchers then settles in one call.
   *
   * @param opts - Optional claim execution and target selection options.
   * @param opts.maxClaimsPerBatch - Max vouchers per claim batch before settling.
   * @param opts.idleSecs - When set, only include channels idle for at least this many seconds.
   * @param opts.selectClaimChannels - Optional selector for choosing channels before claimability checks.
   * @returns Combined claim and settle results.
   */
  async claimAndSettle(
    opts?: ClaimOptions,
  ): Promise<{ claims: ClaimResult[]; settle?: SettleResult }> {
    const claims = await this.claim(opts);
    let settleResult: SettleResult | undefined;
    if (claims.length > 0) {
      settleResult = await this.settle();
    }
    return { claims, settle: settleResult };
  }

  /**
   * Initiates cooperative refunds for one or more channels.
   *
   * @param channelIds - Specific channels to refund; defaults to all sessions.
   * @returns One result per successfully refunded channel.
   */
  async refund(channelIds?: string[]): Promise<RefundResult[]> {
    const storage = this.scheme.getStorage();
    const channels = await storage.list();

    const now = Date.now();
    const targets = (
      channelIds
        ? channels.filter(s =>
            channelIds.some(id => id.toLowerCase() === s.channelId.toLowerCase()),
          )
        : channels
    ).filter(channel => !hasLivePendingRequest(channel, now));

    if (targets.length === 0) {
      return [];
    }

    return this.refundChannels(targets);
  }

  /**
   * Refunds idle channels with non-zero balances.
   *
   * @param opts - Idle refund options.
   * @param opts.idleSecs - Minimum seconds since the last request.
   * @returns One result per successfully refunded channel.
   */
  async refundIdleChannels(opts: { idleSecs: number }): Promise<RefundResult[]> {
    const channels = await this.getIdleChannelsForRefund(opts.idleSecs);
    return this.refundChannels(channels);
  }

  /**
   * Collects vouchers that are eligible for onchain claiming.
   *
   * A voucher is claimable when its `chargedCumulativeAmount` exceeds what has already
   * been claimed onchain.  An optional idle filter skips sessions that received a
   * request within the last `idleSecs` seconds.
   *
   * @param opts - Optional filtering: `idleSecs` to only return idle channels.
   * @param opts.idleSecs - Minimum seconds since last request for a channel to be included.
   * @returns Array of {@link BatchSettlementVoucherClaim} entries for batch submission.
   */
  async getClaimableVouchers(opts?: { idleSecs?: number }): Promise<BatchSettlementVoucherClaim[]> {
    const channels = await this.scheme.getStorage().list();
    return this.getClaimableVouchersFromChannels(channels, opts);
  }

  /**
   * Returns channels that have a pending payer-initiated withdrawal.
   *
   * @returns All stored channel records with `withdrawRequestedAt` set.
   */
  async getWithdrawalPendingSessions(): Promise<Channel[]> {
    const channels = await this.scheme.getStorage().list();
    return channels.filter(s => s.withdrawRequestedAt > 0);
  }

  /**
   * Starts auto-settlement jobs for configured claim, settle, and refund intervals.
   *
   * @param config - Auto-settlement policy configuration.
   */
  start(config: AutoSettlementConfig = {}): void {
    if (this.running) {
      return;
    }

    const now = Date.now();
    this.lastClaimTime = now;
    this.lastSettleTime = now;
    this.running = true;
    this.autoSettleConfig = config;

    this.startAutoTimer("claim", config.claimIntervalSecs);
    this.startAutoTimer("settle", config.settleIntervalSecs);
    this.startAutoTimer("refund", config.refundIntervalSecs);
  }

  /**
   * Stops the auto-settlement loop.
   *
   * @param opts - Stop options.
   * @param opts.flush - When true, run `claimAndSettle` before stopping.
   * @returns Resolves when the loop is stopped (and flush work completes, if requested).
   */
  async stop(opts?: { flush?: boolean }): Promise<void> {
    this.running = false;
    for (const timer of Object.values(this.timers)) {
      clearInterval(timer);
    }
    this.timers = {};
    this.pendingJobs.clear();

    if (opts?.flush) {
      await this.claimAndSettle({
        maxClaimsPerBatch: this.autoSettleConfig.maxClaimsPerBatch,
        selectClaimChannels: this.autoSettleConfig.selectClaimChannels,
      });
    }
  }

  /**
   * Refunds a single channel and removes it from storage after success.
   *
   * @param target - Channel to refund.
   * @returns Successful refund transaction.
   */
  private async refundChannel(target: Channel): Promise<RefundResult> {
    const authorizerSigner = this.scheme.getReceiverAuthorizerSigner();
    const claims = this.buildRefundClaims(target);

    const refundAmount = (
      BigInt(target.balance) - BigInt(target.chargedCumulativeAmount)
    ).toString();

    const nonce = String(target.refundNonce ?? 0);

    const refundAuthorizerSignature = authorizerSigner
      ? await signRefund(
          authorizerSigner,
          target.channelId as `0x${string}`,
          refundAmount,
          nonce,
          this.network,
        )
      : undefined;

    const claimAuthorizerSignature =
      authorizerSigner && claims.length > 0
        ? await signClaimBatch(authorizerSigner, claims, this.network)
        : undefined;

    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "refund",
        channelConfig: target.channelConfig,
        voucher: {
          channelId: target.channelId as `0x${string}`,
          maxClaimableAmount: target.signedMaxClaimable,
          signature: target.signature as `0x${string}`,
        },
        amount: refundAmount,
        refundNonce: nonce,
        claims,
        ...(refundAuthorizerSignature ? { refundAuthorizerSignature } : {}),
        ...(claimAuthorizerSignature ? { claimAuthorizerSignature } : {}),
      },
    };

    const response = await this.facilitator.settle(paymentPayload, this.buildPaymentRequirements());
    if (!response.success) {
      throw new Error(formatFacilitatorFailure("Refund", response));
    }

    await this.scheme
      .getStorage()
      .updateChannel(target.channelId, current =>
        current && !hasLivePendingRequest(current) ? undefined : current,
      );

    return {
      channel: target.channelId,
      transaction: response.transaction,
    };
  }

  /**
   * Starts a recurring timer for one auto job.
   *
   * @param job - Job to enqueue when the interval fires.
   * @param intervalSecs - Timer interval in seconds.
   */
  private startAutoTimer(job: AutoJob, intervalSecs?: number): void {
    if (intervalSecs === undefined) {
      return;
    }

    this.timers[job] = setInterval(() => {
      this.enqueueJob(job);
    }, intervalSecs * 1000);
  }

  /**
   * Adds an auto job to the coalescing queue.
   *
   * @param job - Job to run.
   */
  private enqueueJob(job: AutoJob): void {
    if (!this.running) {
      return;
    }

    this.pendingJobs.add(job);
    if (!this.drainingJobs) {
      void this.drainJobs();
    }
  }

  /**
   * Drains queued auto jobs in priority order.
   */
  private async drainJobs(): Promise<void> {
    if (this.drainingJobs) {
      return;
    }

    this.drainingJobs = true;
    try {
      while (this.running && this.pendingJobs.size > 0) {
        const job = this.nextPendingJob();
        if (!job) {
          return;
        }
        this.pendingJobs.delete(job);
        await this.runAutoJob(job);
      }
    } finally {
      this.drainingJobs = false;
    }
  }

  /**
   * Returns the highest-priority queued auto job.
   *
   * @returns Next job to run.
   */
  private nextPendingJob(): AutoJob | undefined {
    return AUTO_JOB_PRIORITY.find(job => this.pendingJobs.has(job));
  }

  /**
   * Runs one auto job.
   *
   * @param job - Job to run.
   */
  private async runAutoJob(job: AutoJob): Promise<void> {
    switch (job) {
      case "claim":
        await this.runClaimJob();
        return;
      case "settle":
        await this.runSettleJob();
        return;
      case "refund":
        await this.runRefundJob();
        return;
    }
  }

  /**
   * Runs the claim auto job.
   */
  private async runClaimJob(): Promise<void> {
    const cfg = this.autoSettleConfig;
    try {
      const targets = await this.selectClaimTargets({
        selectClaimChannels: cfg.selectClaimChannels,
      });
      const results = await this.claimFromChannels(targets, {
        maxClaimsPerBatch: cfg.maxClaimsPerBatch ?? 100,
      });

      this.lastClaimTime = Date.now();
      for (const result of results) {
        cfg.onClaim?.(result);
      }
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Runs the settlement auto job.
   */
  private async runSettleJob(): Promise<void> {
    const cfg = this.autoSettleConfig;
    const context = this.buildAutoSettlementContext(Date.now());
    if (!context.pendingSettle) {
      return;
    }

    try {
      if (cfg.shouldSettle && !(await cfg.shouldSettle(context))) {
        return;
      }

      const result = await this.settle();
      this.lastSettleTime = Date.now();
      cfg.onSettle?.(result);
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Runs the refund auto job.
   */
  private async runRefundJob(): Promise<void> {
    const cfg = this.autoSettleConfig;
    if (!cfg.selectRefundChannels) {
      return;
    }

    try {
      const context = this.buildAutoSettlementContext(Date.now());
      const channels = await this.scheme.getStorage().list();
      const targets = await cfg.selectRefundChannels(channels, context);
      for (const result of await this.refundChannels(targets)) {
        cfg.onRefund?.(result);
      }
    } catch (err) {
      cfg.onError?.(err);
    }
  }

  /**
   * Claims vouchers from a provided channel snapshot.
   *
   * @param channels - Channels to inspect for claimable vouchers.
   * @param opts - Claim batching and filtering options.
   * @param opts.maxClaimsPerBatch - Max vouchers per facilitator claim transaction.
   * @param opts.idleSecs - Optional idle filter.
   * @returns Claim results, one per submitted batch.
   */
  private async claimFromChannels(
    channels: Channel[],
    opts: {
      maxClaimsPerBatch: number;
      idleSecs?: number;
    },
  ): Promise<ClaimResult[]> {
    const allClaims = this.getClaimableVouchersFromChannels(
      channels,
      opts.idleSecs !== undefined ? { idleSecs: opts.idleSecs } : undefined,
    );

    if (allClaims.length === 0) {
      return [];
    }

    const results: ClaimResult[] = [];
    for (let i = 0; i < allClaims.length; i += opts.maxClaimsPerBatch) {
      const batch = allClaims.slice(i, i + opts.maxClaimsPerBatch);
      const result = await this.submitClaim(batch);
      results.push(result);
      await this.updateClaimedSessions(batch);
    }

    if (results.length > 0) {
      this.pendingSettle = true;
    }

    return results;
  }

  /**
   * Loads stored channels and applies the configured claim selector, if any.
   *
   * @param opts - Claim options containing an optional target selector.
   * @returns The channel snapshot that should be inspected for claimable vouchers.
   */
  private async selectClaimTargets(
    opts?: Pick<ClaimOptions, "selectClaimChannels">,
  ): Promise<Channel[]> {
    const channels = await this.scheme.getStorage().list();
    if (!opts?.selectClaimChannels) {
      return channels;
    }

    const context = this.buildAutoSettlementContext(Date.now());
    return opts.selectClaimChannels(channels, context);
  }

  /**
   * Refunds each eligible channel independently.
   *
   * @param channels - Channels to refund.
   * @returns Successful refund results.
   */
  private async refundChannels(channels: Channel[]): Promise<RefundResult[]> {
    const results: RefundResult[] = [];
    for (const channel of channels) {
      if (hasLivePendingRequest(channel)) {
        continue;
      }
      results.push(await this.refundChannel(channel));
    }
    return results;
  }

  /**
   * Builds an outstanding voucher claim for a refund payload.
   *
   * @param channel - Channel being refunded.
   * @returns Claim payloads needed before refunding unclaimed balance.
   */
  private buildRefundClaims(channel: Channel): BatchSettlementVoucherClaim[] {
    if (BigInt(channel.chargedCumulativeAmount) <= BigInt(channel.totalClaimed)) {
      return [];
    }

    return [
      {
        voucher: {
          channel: channel.channelConfig,
          maxClaimableAmount: channel.signedMaxClaimable,
        },
        signature: channel.signature as `0x${string}`,
        totalClaimed: channel.chargedCumulativeAmount,
      },
    ];
  }

  /**
   * Builds the policy context passed to interval hooks.
   *
   * @param now - Current wall-clock time in milliseconds.
   * @returns Auto-settlement policy context.
   */
  private buildAutoSettlementContext(now: number): AutoSettlementContext {
    return {
      now,
      lastClaimTime: this.lastClaimTime,
      lastSettleTime: this.lastSettleTime,
      pendingSettle: this.pendingSettle,
    };
  }

  /**
   * Collects claimable vouchers from a provided channel snapshot.
   *
   * @param channels - Channels to inspect.
   * @param opts - Optional idle filter.
   * @param opts.idleSecs - Minimum seconds since last request.
   * @returns Claimable voucher payloads.
   */
  private getClaimableVouchersFromChannels(
    channels: Channel[],
    opts?: { idleSecs?: number },
  ): BatchSettlementVoucherClaim[] {
    const now = Date.now();
    const claims: BatchSettlementVoucherClaim[] = [];

    for (const c of channels) {
      if (BigInt(c.chargedCumulativeAmount) <= BigInt(c.totalClaimed)) {
        continue;
      }
      if (opts?.idleSecs !== undefined) {
        const idleMs = now - c.lastRequestTimestamp;
        if (idleMs < opts.idleSecs * 1000) {
          continue;
        }
      }
      claims.push({
        voucher: {
          channel: c.channelConfig,
          maxClaimableAmount: c.signedMaxClaimable,
        },
        signature: c.signature as `0x${string}`,
        totalClaimed: c.chargedCumulativeAmount,
      });
    }

    return claims;
  }

  /**
   * Filters idle channels that can be cooperatively refunded.
   *
   * @param channels - Channels to inspect.
   * @param idleSecs - Minimum seconds since the last request.
   * @returns Idle refundable channels.
   */
  private getIdleChannelsForRefundFromChannels(channels: Channel[], idleSecs: number): Channel[] {
    const now = Date.now();
    const idleMs = idleSecs * 1000;
    return channels.filter(c => {
      if (BigInt(c.balance) === 0n) return false;
      if (hasLivePendingRequest(c, now)) return false;
      return now - c.lastRequestTimestamp >= idleMs;
    });
  }

  /**
   * Returns channels that have been idle longer than `idleSecs` and still have
   * a non-zero balance (candidates for cooperative refund).
   *
   * @param idleSecs - Minimum seconds since last request for a session to count as idle.
   * @returns Channels meeting the idle and balance criteria.
   */
  private async getIdleChannelsForRefund(idleSecs: number): Promise<Channel[]> {
    const channels = await this.scheme.getStorage().list();
    return this.getIdleChannelsForRefundFromChannels(channels, idleSecs);
  }

  /**
   * Submits a batch of voucher claims to the facilitator.
   *
   * @param claims - Voucher claims to send in one `type: "claim"` payload.
   * @returns Per-batch claim summary (count and transaction hash).
   */
  private async submitClaim(claims: BatchSettlementVoucherClaim[]): Promise<ClaimResult> {
    const authorizerSigner = this.scheme.getReceiverAuthorizerSigner();

    const claimAuthorizerSignature = authorizerSigner
      ? await signClaimBatch(authorizerSigner, claims, this.network)
      : undefined;

    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "claim",
        claims,
        ...(claimAuthorizerSignature ? { claimAuthorizerSignature } : {}),
      },
    };

    const response: SettleResponse = await this.facilitator.settle(
      paymentPayload,
      this.buildPaymentRequirements(),
    );

    if (!response.success) {
      throw new Error(formatFacilitatorFailure("Claim", response));
    }

    return { vouchers: claims.length, transaction: response.transaction };
  }

  /**
   * Builds a settlement payment payload for `settle(receiver, token)`.
   *
   * @returns Payload with `type: "settle"` and receiver/token fields.
   */
  private buildSettlePaymentPayload(): PaymentPayload {
    return {
      x402Version: 2,
      accepted: this.buildPaymentRequirements(),
      payload: {
        type: "settle",
        receiver: this.receiver,
        token: this.token,
      },
    };
  }

  /**
   * Builds a minimal {@link PaymentRequirements} for channel manager operations.
   *
   * @returns Requirements describing batched operations for this manager.
   */
  private buildPaymentRequirements(): PaymentRequirements {
    return {
      scheme: BATCH_SETTLEMENT_SCHEME,
      network: this.network,
      asset: this.token,
      amount: "0",
      payTo: this.receiver,
      maxTimeoutSeconds: 0,
      extra: {},
    };
  }

  /**
   * Updates session records after a successful claim submission so that
   * `getClaimableVouchers` no longer returns already-claimed vouchers.
   *
   * @param claims - Voucher claims that were included in the submitted settlement transaction.
   */
  private async updateClaimedSessions(claims: BatchSettlementVoucherClaim[]): Promise<void> {
    const storage = this.scheme.getStorage();
    for (const claim of claims) {
      const channelId = computeChannelId(claim.voucher.channel, this.network);
      const channel = await storage.get(channelId);
      if (!channel) {
        continue;
      }
      const claimedAmount = BigInt(claim.totalClaimed);
      if (claimedAmount <= BigInt(channel.totalClaimed)) {
        continue;
      }
      await storage.updateChannel(channelId, current => {
        if (!current || claimedAmount <= BigInt(current.totalClaimed)) {
          return current;
        }
        return {
          ...current,
          totalClaimed: claimedAmount.toString(),
        };
      });
    }
  }
}
