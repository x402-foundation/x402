/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param-description, jsdoc/require-returns */
import { type Address } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type {
  PaymentPayloadContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "@x402/core/types";

import { findDefaultAsset } from "../../defaultAssets";
import { buildTopUpPaymentChannelTransaction, parseU64 } from "../../payment-channels/open";
import { requireTokenProgramHint } from "../../payment-channels/requirements";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { discoverChannelsByPayer, type ProgramAccountScan } from "../../payment-channels/discovery";
import { ChannelStatus } from "../../payment-channels/generated/types/channelStatus";
import type { ClientSvmConfig } from "../../signer";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../utils";
import { MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY } from "../constants";
import { BatchError } from "../errors";
import {
  BATCH_SETTLEMENT_SCHEME,
  isBatchPayload,
  isBatchVoucher,
  type BatchChannelState,
  type BatchPayload,
  type BatchVoucher,
  type BatchVoucherState,
} from "../types";
import {
  type BatchClientSigner,
  BatchChannelTracker,
  buildDepositPayload,
  buildRefundPayload,
  credentialFor,
} from "./channel";
import {
  DEFAULT_DEPOSIT_MULTIPLIER,
  MIN_DEPOSIT_MULTIPLIER,
  OPERATION_KEY_SEPARATOR,
} from "./constants";
import {
  alignRefundRequirements,
  type BatchRefundOptions,
  type RefundPayloadOptions,
  refundBatchChannel,
} from "./refund";
import {
  type BatchServerSignedChannelsPolicy,
  type ResolvedServerSignedTrust,
  ServerSignedTrustPolicy,
  UntrustedOperatorError,
} from "./trust";
import type {
  OpenChannel,
  PaymentResponseContext,
  PendingChannel,
  PendingPayment,
  ResolvedTerms,
} from "./types";

/** A serializable, confirmed client channel allocation. */
export interface BatchClientChannelRecord {
  channelConfig: OpenChannel["tracker"]["channelConfig"];
  channelId: string;
  chargedCumulativeAmount: string;
  deposit: string;
  /** Whether the top-level allocation is confirmed while `pending` is in flight. */
  hasConfirmedState?: boolean | undefined;
  pending?:
    | {
        amount: string;
        chargedCumulativeAmount: string;
        deposit: string;
        operationKey?: string | undefined;
        payment: PendingPayment;
      }
    | Array<{
        amount: string;
        chargedCumulativeAmount: string;
        deposit: string;
        operationKey: string;
        payment: PendingPayment;
      }>;
}

/** Optional durable storage for confirmed client allocations. */
export interface BatchClientChannelStorage {
  get(key: string): Promise<BatchClientChannelRecord | undefined>;
  set(key: string, record: BatchClientChannelRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface BatchSvmClientConfig extends ClientSvmConfig {
  /** Fixed deposit target. Overrides server hints and `depositPolicy`. */
  depositAmount?: bigint | string | undefined;
  /** Policy used to size deposits when `depositAmount` is not set. */
  depositPolicy?: { depositMultiplier?: number | undefined } | undefined;
  /** Persists confirmed state and a replayable pending allocation. */
  channelStorage?: BatchClientChannelStorage | undefined;
  /**
   * Channel-derivation salt. Defaults to `0`.
   *
   * A random salt would open a fresh channel on every start, stranding the
   * escrow in the last one behind a forced close. Change it only to run
   * several channels against the same server on purpose.
   */
  salt?: bigint | string | undefined;
  /**
   * Scan the chain for a channel this wallet already opened when no local
   * record exists. On by default; a client that keeps durable storage and
   * wants to avoid the scan can turn it off.
   */
  discoverChannels?: boolean | undefined;
  /**
   * Which resource operators may hold this client's voucher-signing authority,
   * and how much escrow to lock under them.
   *
   * A 402 advertising `extra.voucherSigner: "server"` asks the client to open
   * a channel whose onchain `authorized_signer` is the operator. Unless that
   * key is listed in `allowedOperators` the client refuses the accept and,
   * through its creation-failure hook, pays the same resource's client-signed
   * accept instead when one is offered. Omit to never enter server mode.
   */
  serverSignedChannelsPolicy?: BatchServerSignedChannelsPolicy | undefined;
}

export class BatchSvmScheme implements SchemeNetworkClient {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  findDefaultAsset = findDefaultAsset;
  readonly schemeHooks: SchemeClientHooks = {
    onPaymentCreationFailure: async ctx => this.fallBackToClientSigned(ctx),
    onPaymentResponse: async ctx => {
      const recovered = await this.handlePaymentResponse(ctx);
      return recovered ? { recovered: true } : undefined;
    },
  };
  private readonly channels = new Map<string, OpenChannel>();
  private readonly pending = new Map<string, PendingChannel>();
  private readonly trust: ServerSignedTrustPolicy;
  /** Spend-cap context core passed for an accept, reused when falling back to its client-signed twin. */
  private readonly creationContexts = new WeakMap<PaymentRequirements, PaymentPayloadContext>();

  constructor(
    private readonly signer: BatchClientSigner,
    private readonly config: BatchSvmClientConfig = {},
  ) {
    const multiplier = config.depositPolicy?.depositMultiplier;
    if (
      multiplier !== undefined &&
      (!Number.isInteger(multiplier) || multiplier < MIN_DEPOSIT_MULTIPLIER)
    ) {
      throw new Error(`depositMultiplier must be an integer >= ${MIN_DEPOSIT_MULTIPLIER}`);
    }
    this.trust = new ServerSignedTrustPolicy(config.serverSignedChannelsPolicy);
  }

  /**
   * Optional core `PaymentPolicy` (`x402Client.registerPolicy`) that drops
   * untrusted server-signed accepts before selection and prefers trusted ones
   * over the same route's client-signed accept, so a client that trusts an
   * operator gets metered pricing even when the server lists the fixed-price
   * accept first. Transport-agnostic: it reads only the accepts.
   *
   * Not required for safety. Without it the scheme still refuses untrusted
   * accepts and falls back to the client-signed accept through its
   * creation-failure hook.
   *
   * @param _x402Version - Protocol version (unused)
   * @param accepts - Offered payment requirements
   * @returns Filtered and reordered accepts
   */
  readonly paymentPolicy = (
    _x402Version: number,
    accepts: PaymentRequirements[],
  ): PaymentRequirements[] => this.trust.filterAccepts(accepts);

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    if (context) this.creationContexts.set(requirements, context);
    const terms = await this.resolveTerms(requirements);
    const charge = parseU64(requirements.amount, "amount");
    const authorizationExpiresAt =
      Math.floor(Date.now() / 1000) + Math.max(1, requirements.maxTimeoutSeconds);
    if (charge === 0n) throw new Error("batch-settlement amount must be positive");
    const key = this.channelKey(requirements, terms.feePayer, terms.withdrawDelay);
    const existing = await this.loadChannel(key);
    const channelPending = [...this.pending.values()].filter(candidate => candidate.key === key);
    // Keep one in-flight allocation per channel. Server vouchers are cumulative,
    // so serial requests are what let the client derive each charge from its
    // exact locally confirmed watermark.
    const blocking = channelPending[0];
    if (blocking) {
      if (blocking.amount !== requirements.amount) {
        throw new Error("batch-settlement channel has a pending allocation for a different amount");
      }
      if (terms.voucherSigner === "server") {
        throw new Error("batch-settlement server-signed channel has a pending request");
      }
      return blocking.payment;
    }
    if (existing) {
      const reserved = channelPending.reduce(
        (sum, candidate) => sum + BigInt(candidate.amount),
        0n,
      );
      const cumulative = existing.tracker.cumulative + reserved + charge;
      if (cumulative <= existing.deposit) {
        const requestId = terms.voucherSigner === "server" ? crypto.randomUUID() : undefined;
        const payload: Extract<BatchPayload, { type: "authorization" | "voucher" }> =
          requestId === undefined
            ? {
                channelConfig: existing.tracker.channelConfig,
                type: "voucher",
                voucher: (await credentialFor("client", existing.tracker, charge)).voucher,
              }
            : {
                authorization: (
                  await credentialFor("server", existing.tracker, charge, {
                    requestId,
                    expiresAt: authorizationExpiresAt,
                  })
                ).authorization,
                channelConfig: existing.tracker.channelConfig,
                type: "authorization",
              };
        const payment: PendingPayment = {
          x402Version,
          payload,
        };
        const next = {
          ...existing,
          amount: requirements.amount,
          confirmed: existing,
          cumulative,
          key,
          operationKey: requestId ? `${key}${OPERATION_KEY_SEPARATOR}${requestId}` : key,
          payment,
        };
        this.pending.set(next.operationKey, next);
        await this.persistPending(next);
        return payment;
      }
      if (channelPending.length > 0) {
        throw new Error("batch-settlement channel has insufficient unreserved capacity");
      }
      const topUpAmount = this.resolveDepositAmount(
        requirements,
        charge,
        cumulative - existing.deposit,
        context,
        terms.trust,
        existing.deposit,
      );
      const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
      const blockhash = await resolveBlockhash(rpc, requirements);
      const topUp = await buildTopUpPaymentChannelTransaction({
        amount: topUpAmount,
        blockhash,
        channelId: existing.tracker.channelId,
        feePayer: terms.feePayer,
        memo: terms.memo,
        mint: requirements.asset,
        payer: this.signer,
        tokenProgram: terms.tokenProgram,
      });
      const topUpRequestId = crypto.randomUUID();
      const topUpCredential =
        terms.voucherSigner === "server"
          ? await credentialFor("server", existing.tracker, charge, {
              requestId: topUpRequestId,
              expiresAt: authorizationExpiresAt,
            })
          : await credentialFor("client", existing.tracker, charge);
      const payment: PendingPayment = {
        x402Version,
        payload: {
          channelConfig: existing.tracker.channelConfig,
          deposit: { amount: topUpAmount.toString(), transaction: topUp.transaction },
          type: "deposit",
          ...topUpCredential,
        },
      };
      const next = {
        ...existing,
        amount: requirements.amount,
        confirmed: existing,
        cumulative,
        deposit: existing.deposit + topUpAmount,
        key,
        operationKey: key,
        payment,
      };
      this.pending.set(next.operationKey, next);
      await this.persistPending(next);
      return payment;
    }

    // Before funding a second channel, look for one this wallet already opened.
    const discovered = await this.discoverChannel(requirements, terms);
    if (discovered) {
      this.channels.set(key, discovered);
      await this.config.channelStorage?.set(key, this.toStorageRecord(discovered));
      return this.createPaymentPayload(x402Version, requirements, context);
    }

    if (
      this.config.depositAmount !== undefined &&
      parseU64(this.config.depositAmount, "depositAmount") < charge
    ) {
      throw new Error("depositAmount must cover the current request");
    }
    const deposit = this.resolveDepositAmount(
      requirements,
      charge,
      charge,
      context,
      terms.trust,
      0n,
    );
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const [blockhash, openSlot] = await Promise.all([
      resolveBlockhash(rpc, requirements),
      resolveOpenSlot(rpc, requirements),
    ]);
    const built = await buildDepositPayload({
      blockhash,
      depositAmount: deposit,
      feePayer: terms.feePayer,
      firstCharge: charge,
      memo: terms.memo,
      mint: requirements.asset,
      openSlot,
      payer: this.signer,
      receiver: requirements.payTo,
      receiverAuthorizer: terms.receiverAuthorizer,
      salt: this.salt(),
      tokenProgram: terms.tokenProgram,
      withdrawDelay: terms.withdrawDelay,
      voucherSigner: terms.voucherSigner,
      ...(terms.voucherSigner === "server" ? { authorizationExpiresAt } : {}),
      ...(terms.operator ? { operator: terms.operator } : {}),
    });
    const payment: PendingPayment = { payload: built.payload, x402Version };
    const next = {
      amount: requirements.amount,
      cumulative: charge,
      deposit,
      key,
      operationKey: built.payload.authorization
        ? `${key}${OPERATION_KEY_SEPARATOR}${built.payload.authorization.requestId}`
        : key,
      payment,
      tracker: built.tracker,
    };
    this.pending.set(next.operationKey, next);
    await this.persistPending(next);
    return payment;
  }

  /**
   * Close the channel backing `url` and refund its unused escrow.
   *
   * Probes the route for the requirements the channel was opened against and
   * sends a zero-charge voucher at the confirmed cumulative amount. The server
   * closes the channel cooperatively, or, when the facilitator has no receiver
   * binding, the payer-signed `request_close` starts a forced
   * close whose escrow comes back after the grace period.
   *
   * @param url - Any protected route on the channel to close
   * @param options - Fetch override, or requirements to skip the probe
   * @returns The settlement response describing the close
   */
  async refund(url: string, options?: BatchRefundOptions) {
    return refundBatchChannel(
      (x402Version, requirements, payloadOptions) =>
        this.createRefundPayload(x402Version, requirements, payloadOptions),
      url,
      options,
    );
  }

  /**
   * Build the payer-signed portable refund operation for the cached channel.
   *
   * @param x402Version
   * @param requirements
   * @param options - Whether to include a payer-signed `request_close`
   */
  async createRefundPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    options?: RefundPayloadOptions,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const cached = this.findCachedChannelForRoute(requirements);
    const lookupRequirements = cached
      ? this.requirementsForRefund(requirements, cached)
      : requirements;
    const terms = await this.resolveRefundTerms(lookupRequirements, cached);
    const key = this.channelKey(lookupRequirements, terms.feePayer, terms.withdrawDelay);
    // A client with no local record is exactly the one that needs to close a
    // channel it can no longer pay from, so fall back to the chain.
    const existing =
      (await this.loadChannel(key)) ??
      cached ??
      (await this.discoverChannel(lookupRequirements, terms));
    if (!existing) throw new Error("no batch-settlement channel to refund");
    const blockhash = options?.withTransaction
      ? await resolveBlockhash(
          createRpcClient(lookupRequirements.network, this.config.rpcUrl),
          lookupRequirements,
        )
      : undefined;
    const serverMode = existing.tracker.channelConfig.voucherSigner === "server";
    const expiresAt = Math.floor(Date.now() / 1000) + lookupRequirements.maxTimeoutSeconds;
    const credential = serverMode
      ? await credentialFor("server", existing.tracker, 0n, {
          requestId: crypto.randomUUID(),
          expiresAt,
        })
      : await credentialFor("client", existing.tracker, 0n, undefined, true);
    return {
      x402Version,
      payload: await buildRefundPayload({
        blockhash,
        channelConfig: existing.tracker.channelConfig,
        channelId: existing.tracker.channelId,
        feePayer: terms.feePayer,
        memo: terms.memo,
        payer: this.signer,
        ...credential,
      }),
    };
  }

  /**
   * Pay the same resource client-signed when the selected accept needed an
   * operator this client does not trust.
   *
   * The fallback is restricted to a client-signed batch-settlement accept on
   * the same network and asset for no more than the refused accept's amount,
   * so it can never widen what the client's spend controls already allowed
   * for the selected accept; the spend-cap context core resolved for that
   * accept is reused as-is.
   *
   * @param ctx - Core's creation-failure context
   * @returns A recovered payload for the client-signed accept, or nothing
   */
  private async fallBackToClientSigned(
    ctx: Parameters<NonNullable<SchemeClientHooks["onPaymentCreationFailure"]>>[0],
  ): Promise<void | { recovered: true; payload: PaymentPayload }> {
    if (!(ctx.error instanceof UntrustedOperatorError)) return undefined;
    const refused = ctx.selectedRequirements;
    if (!/^\d+$/.test(refused.amount)) return undefined;
    const fallback = ctx.paymentRequired.accepts.find(
      accept =>
        accept !== refused &&
        accept.scheme === BATCH_SETTLEMENT_SCHEME &&
        accept.network === refused.network &&
        accept.asset === refused.asset &&
        (accept.extra?.voucherSigner ?? "client") === "client" &&
        /^\d+$/.test(accept.amount) &&
        BigInt(accept.amount) <= BigInt(refused.amount),
    );
    if (!fallback) return undefined;
    const partial = await this.createPaymentPayload(
      ctx.paymentRequired.x402Version,
      fallback,
      this.creationContexts.get(refused),
    );
    return {
      recovered: true,
      payload: {
        ...partial,
        accepted: fallback,
        resource: ctx.paymentRequired.resource,
        ...(ctx.paymentRequired.extensions ? { extensions: ctx.paymentRequired.extensions } : {}),
      },
    };
  }

  private salt(): bigint {
    return this.config.salt === undefined ? 0n : parseU64(this.config.salt, "salt");
  }

  private resolveDepositAmount(
    requirements: PaymentRequirements,
    requestAmount: bigint,
    needed: bigint,
    context: PaymentPayloadContext | undefined,
    trust: ResolvedServerSignedTrust | undefined,
    existingDeposit: bigint,
  ): bigint {
    const multiplier = this.config.depositPolicy?.depositMultiplier ?? DEFAULT_DEPOSIT_MULTIPLIER;
    const configured =
      this.config.depositAmount === undefined
        ? undefined
        : parseU64(this.config.depositAmount, "depositAmount");
    const announced = parseAnnouncedMinDeposit(requirements.extra?.minDeposit, requestAmount);
    const target = configured ?? announced ?? requestAmount * BigInt(multiplier);
    let proposed = target > needed ? target : needed;
    const maxDeposit = maxDepositFromSpendCap(context?.maxAmountPerPayment, multiplier);
    if (maxDeposit !== undefined && needed > maxDeposit) {
      throw new Error(
        `Required deposit ${needed} exceeds depositMultiplier × spendControls.maxAmountPerPayment (${maxDeposit}). ` +
          "Raise maxAmountPerPayment or depositMultiplier.",
      );
    }
    if (maxDeposit !== undefined && proposed > maxDeposit) proposed = maxDeposit;
    // In server mode the escrow is what a dishonest operator could take, so
    // the trust grant's cap wins over every hint, including the server's own
    // `minDeposit`, and over this client's fixed `depositAmount`.
    if (trust?.maxDeposit !== undefined) {
      const room = trust.maxDeposit - existingDeposit;
      if (needed > room) {
        throw new Error(
          `Required deposit ${needed} exceeds the remaining serverSignedChannelsPolicy maxDeposit ` +
            `(${trust.maxDeposit} total, ${existingDeposit} already escrowed). ` +
            "Raise maxDeposit for this operator or use a client-signed accept.",
        );
      }
      if (proposed > room) proposed = room;
    }
    return proposed;
  }

  /**
   * Find a channel this wallet already opened against these terms.
   *
   * A client with no local record would otherwise open a second channel and
   * leave the first one's escrow to a forced close. The scan is filtered on
   * `payer`, and every row's PDA is rederived from its own fields before it is
   * trusted, so a crafted account cannot pass itself off as a channel.
   *
   * The adopted cumulative base is the onchain settled watermark: the charges
   * above it exist only in vouchers this client no longer has, and the server
   * rebuilds from the same watermark, so both sides agree.
   *
   * @param requirements
   * @param terms
   * @param terms.feePayer
   * @param terms.withdrawDelay
   * @param terms.tokenProgram
   * @param terms.receiverAuthorizer
   * @param terms.voucherSigner
   * @param terms.operator
   */
  private async discoverChannel(
    requirements: PaymentRequirements,
    terms: ResolvedTerms,
  ): Promise<OpenChannel | undefined> {
    if (this.config.discoverChannels === false) return undefined;
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const scan: ProgramAccountScan = async (programId, filters) =>
      (await rpc
        .getProgramAccounts(programId as Address, {
          commitment: "confirmed",
          encoding: "base64",
          filters: filters as never,
        })
        .send()) as never;
    let found;
    try {
      found = await discoverChannelsByPayer(scan, this.signer.address);
    } catch {
      // Discovery is an optimization over opening a new channel, never a
      // precondition for paying.
      return undefined;
    }
    const salt = this.salt();
    const usable = found.filter(
      candidate =>
        candidate.channel.status === ChannelStatus.Open &&
        candidate.channel.closureStartedAt === 0n &&
        candidate.channel.payee === terms.feePayer &&
        candidate.channel.mint === requirements.asset &&
        candidate.channel.authorizedSigner === (terms.operator ?? this.signer.address) &&
        candidate.channel.gracePeriod === terms.withdrawDelay &&
        candidate.channel.salt === salt,
    );
    // Prefer the newest, so a channel opened after an earlier one was drained
    // wins.
    usable.sort((left, right) => (left.channel.openSlot < right.channel.openSlot ? 1 : -1));
    const channel = usable[0];
    if (!channel) return undefined;
    return {
      deposit: channel.channel.deposit,
      tracker: new BatchChannelTracker(
        channel.channelId,
        {
          openSlot: Number(channel.channel.openSlot),
          payer: channel.channel.payer,
          payerAuthorizer: channel.channel.authorizedSigner,
          receiver: requirements.payTo,
          receiverAuthorizer: terms.receiverAuthorizer,
          salt: channel.channel.salt.toString(),
          token: channel.channel.mint,
          withdrawDelay: channel.channel.gracePeriod,
          ...(terms.voucherSigner === "server" ? { voucherSigner: "server" as const } : {}),
        },
        this.signer,
        channel.channel.settlement.settled,
      ),
    };
  }

  private async loadChannel(key: string): Promise<OpenChannel | undefined> {
    const cached = this.channels.get(key);
    if (cached) return cached;
    const saved = await this.config.channelStorage?.get(key);
    if (!saved) return undefined;
    if (saved.pending) {
      const savedPending = Array.isArray(saved.pending) ? saved.pending : [saved.pending];
      if (savedPending.length === 0) return this.hydrateAndCache(key, saved);
      const confirmed = saved.hasConfirmedState ? this.hydrateChannel(saved) : undefined;
      if (confirmed) this.channels.set(key, confirmed);
      const tracker =
        confirmed?.tracker ??
        new BatchChannelTracker(saved.channelId, saved.channelConfig, this.signer);
      for (const pending of savedPending) {
        const operationKey = pending.operationKey ?? key;
        this.pending.set(operationKey, {
          confirmed,
          tracker,
          amount: pending.amount,
          cumulative: parseU64(pending.chargedCumulativeAmount, "stored pending cumulative"),
          deposit: parseU64(pending.deposit, "stored pending deposit"),
          key,
          operationKey,
          payment: pending.payment,
        });
      }
      return confirmed;
    }
    return this.hydrateAndCache(key, saved);
  }

  private hydrateAndCache(key: string, record: BatchClientChannelRecord): OpenChannel {
    const channel = this.hydrateChannel(record);
    this.channels.set(key, channel);
    return channel;
  }

  private persistPending(pending: PendingChannel): Promise<void> | undefined {
    const allPending = [...this.pending.values()].filter(
      candidate => candidate.key === pending.key,
    );
    const confirmed = this.channels.get(pending.key) ?? pending.confirmed;
    const recordChannel = confirmed ?? {
      deposit: pending.deposit ?? 0n,
      tracker: pending.tracker,
    };
    return this.config.channelStorage?.set(
      pending.key,
      this.toStorageRecord(recordChannel, {
        hasConfirmedState: confirmed !== undefined,
        pending: allPending.map(item => ({
          amount: item.amount,
          chargedCumulativeAmount: item.cumulative.toString(),
          deposit: item.deposit.toString(),
          operationKey: item.operationKey,
          payment: item.payment,
        })),
      }),
    );
  }

  /**
   * Reconcile local channel state with the server's answer.
   *
   * Returns whether the client resynchronized and the request should be
   * retried.
   *
   * @param ctx
   */
  private async handlePaymentResponse(ctx: PaymentResponseContext): Promise<boolean> {
    const payload = ctx.paymentPayload.payload;
    if (
      !isBatchPayload(payload) ||
      (payload.type !== "authorization" && payload.type !== "voucher" && payload.type !== "deposit")
    ) {
      return false;
    }
    const requestId =
      payload.type === "authorization"
        ? payload.authorization.requestId
        : payload.type === "deposit"
          ? payload.authorization?.requestId
          : undefined;
    const voucherChannelId =
      payload.type === "voucher"
        ? payload.voucher.channelId
        : payload.type === "deposit"
          ? payload.voucher?.channelId
          : undefined;
    const findPending = () =>
      [...this.pending.values()].find(candidate =>
        requestId
          ? candidate.payment.payload.type !== "voucher" &&
            candidate.payment.payload.authorization?.requestId === requestId
          : candidate.tracker.channelId === voucherChannelId,
      );
    let pending = findPending();
    if (!pending && this.config.channelStorage) {
      // A recovered HTTP response can be the first call on a fresh client.
      // Restore its exact pending allocation without creating another request.
      const terms = await this.resolveTerms(ctx.requirements);
      await this.loadChannel(
        this.channelKey(ctx.requirements, terms.feePayer, terms.withdrawDelay),
      );
      pending = findPending();
    }
    if (!pending) return false;
    this.pending.delete(pending.operationKey);

    if (!ctx.settleResponse?.success) {
      await this.restoreConfirmedChannel(pending);
      // A corrective 402 carries the base the server is actually charging
      // from. Adopting it — against this client's own signature — turns a
      // dead channel back into a usable one.
      return ctx.paymentRequired ? this.adoptCorrectiveState(pending, ctx.paymentRequired) : false;
    }

    // The response is the server's report, not this client's accounting. The
    // charge is capped at the price this request advertised, the cumulative is
    // computed locally and only cross-checked against the server's, and the
    // escrow comes from the deposit this client itself signed.
    const extra = ctx.settleResponse.extra as
      | {
          commitmentId?: unknown;
          chargedAmount?: unknown;
          channelState?: { balance?: unknown; chargedCumulativeAmount?: unknown };
          voucher?: BatchVoucher;
        }
      | undefined;
    const requestAmount = parseU64(ctx.requirements.amount, "requirements.amount");
    const localPrior = pending.confirmed?.tracker.cumulative ?? 0n;
    let charged: bigint;
    let confirmedCumulative: bigint;
    if (pending.tracker.channelConfig.voucherSigner === "server") {
      const voucher = extra?.voucher;
      const cumulative =
        isBatchVoucher(voucher) && /^\d+$/.test(voucher.maxClaimableAmount)
          ? BigInt(voucher.maxClaimableAmount)
          : undefined;
      if (
        !isBatchVoucher(voucher) ||
        cumulative === undefined ||
        voucher.channelId !== pending.tracker.channelId ||
        voucher.expiresAt !== 0 ||
        !(await verifyVoucherSignature({
          message: encodeVoucherMessageBytes({
            channelId: pending.tracker.channelId,
            cumulativeAmount: cumulative ?? 0n,
            expiresAt: BigInt(voucher.expiresAt),
          }),
          signatureBase58: voucher.signature,
          signerBase58: pending.tracker.channelConfig.payerAuthorizer,
        }))
      ) {
        await this.restoreConfirmedChannel(pending);
        throw new Error("batch-settlement PAYMENT-RESPONSE has an invalid server voucher");
      }
      if (cumulative < localPrior || cumulative - localPrior > requestAmount) {
        await this.restoreConfirmedChannel(pending);
        return false;
      }
      charged = cumulative - localPrior;
      confirmedCumulative = localPrior + charged;
    } else {
      charged =
        typeof extra?.chargedAmount === "string" && /^\d+$/.test(extra.chargedAmount)
          ? BigInt(extra.chargedAmount)
          : -1n;
      if (charged !== requestAmount) {
        throw new Error("batch-settlement PAYMENT-RESPONSE charged an unexpected amount");
      }
      confirmedCumulative = localPrior + charged;
    }
    const reported = extra?.channelState?.chargedCumulativeAmount;
    if (
      // The commitment identifier is opaque to the client: the spec only
      // requires it to be non-empty (section 4.4). The server's own cumulative,
      // when reported, must still agree with the one derived here.
      typeof extra?.commitmentId !== "string" ||
      extra.commitmentId === "" ||
      (typeof reported === "string" && reported !== confirmedCumulative.toString())
    ) {
      // The server confirmed something this client did not submit. Leave local
      // state untouched rather than adopt an accounting it cannot derive; the
      // next request resynchronizes through a corrective 402.
      await this.restoreConfirmedChannel(pending);
      return false;
    }
    // A deposit's escrow is what this client signed for, not what the server
    // reports holding.
    const deposited =
      payload.type === "deposit" ? parseU64(payload.deposit.amount, "deposit.amount") : 0n;
    if (confirmedCumulative > pending.tracker.cumulative) {
      pending.tracker.commit(confirmedCumulative);
    }
    pending.deposit = (pending.confirmed?.deposit ?? 0n) + deposited;
    const confirmed = { deposit: pending.deposit, tracker: pending.tracker };
    this.channels.set(pending.key, confirmed);
    const remaining = [...this.pending.values()].find(candidate => candidate.key === pending.key);
    if (remaining) await this.persistPending(remaining);
    else await this.config.channelStorage?.set(pending.key, this.toStorageRecord(confirmed));
    return false;
  }

  /**
   * Adopt the cumulative base from a corrective 402.
   *
   * The snapshot is only the server's word for what it has charged, so it is
   * accepted only against `voucherState`: an Ed25519 signature over the
   * 50-byte voucher message, which only this client's own authorizer key could
   * have produced. Without that proof the server has no accepted voucher, and
   * the client resynchronizes from the onchain settled watermark instead.
   *
   * @param pending
   * @param paymentRequired
   * @param paymentRequired.error
   * @param paymentRequired.accepts
   */
  private async adoptCorrectiveState(
    pending: PendingChannel,
    paymentRequired: { error?: string | undefined; accepts: PaymentRequirements[] },
  ): Promise<boolean> {
    if (paymentRequired.error !== BatchError.CUMULATIVE_AMOUNT_MISMATCH) return false;
    const accept = paymentRequired.accepts.find(
      candidate =>
        candidate.scheme === BATCH_SETTLEMENT_SCHEME &&
        (candidate.extra?.channelState as BatchChannelState | undefined)?.channelId ===
          pending.tracker.channelId,
    );
    const channelState = accept?.extra?.channelState as BatchChannelState | undefined;
    if (!channelState?.chargedCumulativeAmount) return false;
    const charged = parseU64(channelState.chargedCumulativeAmount, "chargedCumulativeAmount");
    const claimed = parseU64(channelState.totalClaimed, "totalClaimed");
    // A server may never claim to have charged less than the chain has already
    // settled, nor more than the client signed for.
    if (charged < claimed) return false;
    if (pending.tracker.channelConfig.voucherSigner === "server") {
      // In server mode `voucherState` is signed by the operator, so its
      // signature proves nothing about what this client authorized. The only
      // bound the client can assert itself is what it agreed to: its confirmed
      // watermark plus the ceilings of its own requests whose outcome it never
      // saw. Anything above that is an operator claim it has no basis to adopt.
      const unresolved = [...this.pending.values()]
        .filter(candidate => candidate.key === pending.key)
        .reduce((sum, candidate) => sum + parseU64(candidate.amount, "pending amount"), 0n);
      const authorized =
        (pending.confirmed?.tracker.cumulative ?? 0n) +
        parseU64(pending.amount, "pending amount") +
        unresolved;
      if (charged > authorized) return false;
    }

    const voucherState = accept?.extra?.voucherState as BatchVoucherState | undefined;
    if (voucherState) {
      const signed = parseU64(voucherState.signedMaxClaimable, "signedMaxClaimable");
      if (charged > signed) return false;
      const verified = await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId: pending.tracker.channelId,
          cumulativeAmount: signed,
          expiresAt: BigInt(voucherState.expiresAt),
        }),
        signatureBase58: voucherState.signature,
        signerBase58: pending.tracker.channelConfig.payerAuthorizer,
      });
      if (!verified) return false;
    } else if (charged !== claimed) {
      // No proof: the only base a client may adopt unproven is the one the
      // chain itself reports as settled.
      return false;
    }

    const adopted: OpenChannel = {
      deposit: parseU64(channelState.balance, "channelState.balance"),
      tracker: new BatchChannelTracker(
        pending.tracker.channelId,
        pending.tracker.channelConfig,
        this.signer,
        charged,
      ),
    };
    this.channels.set(pending.key, adopted);
    await this.config.channelStorage?.set(pending.key, this.toStorageRecord(adopted));
    return true;
  }

  private hydrateChannel(record: BatchClientChannelRecord): OpenChannel {
    return {
      deposit: parseU64(record.deposit, "stored deposit"),
      tracker: new BatchChannelTracker(
        record.channelId,
        record.channelConfig,
        this.signer,
        parseU64(record.chargedCumulativeAmount, "stored chargedCumulativeAmount"),
      ),
    };
  }

  private toStorageRecord(
    channel: OpenChannel,
    options?: { hasConfirmedState?: boolean; pending?: BatchClientChannelRecord["pending"] },
  ): BatchClientChannelRecord {
    return {
      channelConfig: channel.tracker.channelConfig,
      channelId: channel.tracker.channelId,
      chargedCumulativeAmount: channel.tracker.cumulative.toString(),
      deposit: channel.deposit.toString(),
      ...(options?.hasConfirmedState ? { hasConfirmedState: true } : {}),
      ...(options?.pending ? { pending: options.pending } : {}),
    };
  }

  private findCachedChannelForRoute(requirements: PaymentRequirements): OpenChannel | undefined {
    for (const channel of this.channels.values()) {
      const config = channel.tracker.channelConfig;
      if (config.receiver === requirements.payTo && config.token === requirements.asset) {
        return channel;
      }
    }
    return undefined;
  }

  /**
   * Align probed refund requirements with how the open channel was authorized.
   *
   * A refund probe takes the first Solana accept, which may be client-signed
   * even when this wallet paid through a server-signed accept on the same route.
   *
   * @param probed
   * @param cached
   */
  private async resolveRefundTerms(
    probed: PaymentRequirements,
    cached?: OpenChannel,
  ): Promise<ResolvedTerms> {
    if (cached?.tracker.channelConfig.voucherSigner === "server") {
      const clientProbed: PaymentRequirements = {
        ...probed,
        extra: {
          ...probed.extra,
          operator: undefined,
          voucherSigner: "client",
        },
      };
      const terms = await this.resolveTerms(clientProbed);
      return {
        ...terms,
        operator: cached.tracker.channelConfig.payerAuthorizer,
        voucherSigner: "server",
      };
    }
    return this.resolveTerms(probed);
  }

  private requirementsForRefund(
    probed: PaymentRequirements,
    cached: OpenChannel,
  ): PaymentRequirements {
    return alignRefundRequirements(probed, cached.tracker.channelConfig);
  }

  private async restoreConfirmedChannel(pending: PendingChannel): Promise<void> {
    const remaining = [...this.pending.values()].find(candidate => candidate.key === pending.key);
    if (remaining) {
      await this.persistPending(remaining);
      return;
    }
    if (!pending.confirmed) {
      await this.config.channelStorage?.delete(pending.key);
      return;
    }
    this.channels.set(pending.key, pending.confirmed);
    await this.config.channelStorage?.set(pending.key, this.toStorageRecord(pending.confirmed));
  }

  private channelKey(
    requirements: PaymentRequirements,
    feePayer: string,
    withdrawDelay: number,
  ): string {
    return [
      requirements.network,
      requirements.asset,
      requirements.payTo,
      feePayer,
      withdrawDelay,
      requirements.extra?.receiverAuthorizer ?? "",
      requirements.extra?.voucherSigner ?? "client",
      requirements.extra?.operator ?? "",
    ].join(":");
  }

  private async resolveTerms(requirements: PaymentRequirements): Promise<ResolvedTerms> {
    const extra = requirements.extra;
    if (!extra) throw new Error("requirements.extra is required");
    if (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") {
      throw new Error('extra.paymentFlow must be "authorization" when present');
    }
    const feePayer = extra.feePayer;
    if (typeof feePayer !== "string" || feePayer.length === 0) {
      throw new Error("extra.feePayer must be a non-empty string");
    }
    const withdrawDelay = extra.withdrawDelay;
    if (
      typeof withdrawDelay !== "number" ||
      !Number.isInteger(withdrawDelay) ||
      withdrawDelay < MIN_WITHDRAW_DELAY ||
      withdrawDelay > MAX_WITHDRAW_DELAY ||
      withdrawDelay < requirements.maxTimeoutSeconds
    ) {
      throw new Error("extra.withdrawDelay is outside the allowed range");
    }
    const tokenProgram = requireTokenProgramHint(
      extra,
      "extra.tokenProgram is not a supported SPL token program",
    );
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const mint = await fetchMint(rpc, requirements.asset as Address);
    if (mint.programAddress.toString() !== tokenProgram) {
      throw new Error("extra.tokenProgram does not own requirements.asset");
    }
    const receiverAuthorizer = extra.receiverAuthorizer;
    if (typeof receiverAuthorizer !== "string" || receiverAuthorizer.length === 0) {
      throw new Error("extra.receiverAuthorizer must be a non-empty string");
    }
    const memo = extra.memo;
    if (memo !== undefined && typeof memo !== "string") {
      throw new Error("extra.memo must be a string when present");
    }
    const voucherSigner = extra.voucherSigner ?? "client";
    if (voucherSigner !== "client" && voucherSigner !== "server") {
      throw new Error('extra.voucherSigner must be "client" or "server"');
    }
    const operator = extra.operator;
    if (voucherSigner === "server" && (typeof operator !== "string" || operator.length === 0)) {
      throw new Error("extra.operator is required for operator voucher signing");
    }
    if (voucherSigner === "client" && operator !== undefined) {
      throw new Error("extra.operator is only valid for operator voucher signing");
    }
    // Server mode hands the operator this client's onchain signing authority.
    // That is never implied by a 402; it has to be a key this client listed,
    // and `grantFor` throws `UntrustedOperatorError` otherwise so the
    // creation-failure hook can fall back to a client-signed accept.
    const trust = voucherSigner === "server" ? this.trust.grantFor(requirements) : undefined;
    return {
      feePayer,
      ...(memo !== undefined ? { memo } : {}),
      receiverAuthorizer,
      tokenProgram,
      withdrawDelay,
      voucherSigner,
      ...(typeof operator === "string" ? { operator } : {}),
      ...(trust ? { trust } : {}),
    };
  }
}

function parseAnnouncedMinDeposit(value: unknown, requestAmount: bigint): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed >= requestAmount && parsed > 0n ? parsed : undefined;
}

function maxDepositFromSpendCap(
  maxAmountPerPayment: string | undefined,
  depositMultiplier: number,
): bigint | undefined {
  if (
    maxAmountPerPayment === undefined ||
    !/^\d+$/.test(maxAmountPerPayment) ||
    BigInt(maxAmountPerPayment) <= 0n
  ) {
    return undefined;
  }
  return BigInt(maxAmountPerPayment) * BigInt(depositMultiplier);
}
