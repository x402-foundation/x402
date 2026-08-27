import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { DeepReadonly } from "@x402/core/types";
import type {
  SettleContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
} from "@x402/core/server";
import { getEvmChainId } from "../../utils";
import { computePaymentInfoHash, isNonZeroAddress } from "../nonce";
import { parseAuthCaptureExtra, type NormalizedAuthCaptureExtra } from "../extra";
import {
  buildCaptureEnrichment,
  buildChargeCompletionEnrichment,
  buildVoidEnrichment,
  paymentInfoFromCollect,
} from "../lifecyclePayload";
import type { AuthCaptureCollectPayload, AuthorizerSigner, PaymentInfoStruct } from "../types";
import { isAuthCaptureCollectPayload, isEip3009Payload } from "../types";
import {
  applyCaptureBalances,
  type AuthorizedPayment,
  type AuthorizedPaymentStorage,
} from "./storage";

export interface AuthCaptureSettlementHooksConfig {
  storage: AuthorizedPaymentStorage;
  receiverAuthorizerSigner?: AuthorizerSigner;
}

/**
 * Narrow a wire payload to a collect envelope, or undefined.
 *
 * @param payload - `PaymentPayload.payload`.
 * @returns Collect payload when the shape matches.
 */
function asCollectPayload(
  payload: DeepReadonly<PaymentPayload>["payload"],
): AuthCaptureCollectPayload | undefined {
  return isAuthCaptureCollectPayload(payload) ? payload : undefined;
}

/**
 * Client-signed authorize amount from a collect payload (EIP-3009 value or Permit2 permitted amount).
 *
 * @param collect - Verified collect envelope.
 * @returns Atomic amount in token base units.
 */
function signedCollectAmount(collect: AuthCaptureCollectPayload): string {
  return isEip3009Payload(collect)
    ? collect.authorization.value
    : collect.permit2Authorization.permitted.amount;
}

/**
 * In-request settlement hooks: payload enrichment, cancel void, persist, and
 * deferred-settle skip. Storage and the receiver-authorizer signer only —
 * out-of-band capture/void/refund live on `AuthCaptureLifecycleManager`.
 */
export class AuthCaptureSettlementHooks {
  private readonly authorizeResults = new WeakMap<object, SettleResponse>();

  /**
   * Create settlement hooks bound to storage and an optional authorizer signer.
   *
   * @param config - Storage and optional receiver-authorizer signer.
   */
  constructor(private readonly config: AuthCaptureSettlementHooksConfig) {}

  /**
   * Additive payload enrichment for sync capture, bound charge, and cancel void.
   *
   * @param ctx - Settle context from core.
   * @returns Fields to merge into the client payload, or void when not applicable.
   */
  async enrichSettlementPayload(ctx: SettleContext): Promise<Record<string, unknown> | void> {
    if (ctx.phase === "before-handler") return;
    const extraParsed = parseAuthCaptureExtra(ctx.requirements.extra);
    if ("error" in extraParsed) return;
    const extra = extraParsed.extra;
    const collect = asCollectPayload(ctx.paymentPayload.payload);
    if (!collect) return;

    const signer = this.config.receiverAuthorizerSigner;
    if (!signer) return;

    if (ctx.phase === "cancel") {
      if (extra.paymentFlow !== "escrow") return;
      const requirements = ctx.requirements as PaymentRequirements;
      const paymentInfo = paymentInfoFromCollect(collect, requirements, extra);
      const chainId = getEvmChainId(ctx.requirements.network);
      return buildVoidEnrichment({
        paymentInfo,
        extra,
        signer,
        chainId,
        paymentInfoHash: computePaymentInfoHash(chainId, paymentInfo, extra.deployment.escrow),
      });
    }

    if (ctx.phase !== "after-handler") return;

    const chainId = getEvmChainId(ctx.requirements.network);

    if (extra.paymentFlow === "authorization" && isNonZeroAddress(extra.receiverAuthorizer)) {
      return buildChargeCompletionEnrichment({
        collect,
        requirements: ctx.requirements as PaymentRequirements,
        extra,
        signer,
        chainId,
        amount: ctx.requirements.amount,
      });
    }

    if (extra.paymentFlow === "escrow" && extra.captureMode !== "deferred") {
      const requirements = ctx.requirements as PaymentRequirements;
      const authorizeRequirements: PaymentRequirements = {
        ...requirements,
        amount: signedCollectAmount(collect),
      };
      const paymentInfo = paymentInfoFromCollect(collect, authorizeRequirements, extra);
      const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo, extra.deployment.escrow);
      const stored = await this.config.storage.get(paymentInfoHash);
      const trustedPaymentInfo = stored?.paymentInfo ?? paymentInfo;
      return buildCaptureEnrichment({
        collect,
        requirements: authorizeRequirements,
        paymentInfo: trustedPaymentInfo,
        extra,
        signer,
        chainId,
        capturable: stored?.capturableAmount ?? trustedPaymentInfo.maxAmount,
        refundable: stored?.refundableAmount ?? "0",
        amount: requirements.amount,
      });
    }
  }

  /**
   * On handler failure after a before-handler authorize, settle a void.
   *
   * @param context - Cancellation context.
   * @returns Requirements to settle, or void when there is no hold to release.
   */
  async settleOnCancel(
    context: VerifiedPaymentCanceledContext,
  ): Promise<PaymentRequirements | void> {
    const extraParsed = parseAuthCaptureExtra(context.requirements.extra);
    if ("error" in extraParsed) return;
    const extra = extraParsed.extra;
    if (extra.paymentFlow !== "escrow") return;
    if (!this.config.receiverAuthorizerSigner || !isNonZeroAddress(extra.receiverAuthorizer)) {
      return;
    }
    return context.requirements as PaymentRequirements;
  }

  /**
   * Skip the after-handler facilitator settle for deferred escrow; echo the authorize receipt.
   *
   * @param ctx - Settle context.
   * @returns Skip directive with the prior authorize result, or void.
   */
  async handleBeforeSettle(
    ctx: SettleContext,
  ): Promise<void | { skip: true; result: SettleResponse }> {
    if (ctx.phase !== "after-handler") return;
    const extraParsed = parseAuthCaptureExtra(ctx.requirements.extra);
    if ("error" in extraParsed) return;
    if (extraParsed.extra.paymentFlow !== "escrow") return;
    if (extraParsed.extra.captureMode !== "deferred") return;
    const prior = this.authorizeResults.get(ctx.paymentPayload);
    if (!prior) return;
    return { skip: true, result: prior };
  }

  /**
   * Persist authorized-payment records and update balances after a successful settle.
   *
   * @param ctx - Settle result context.
   * @returns Nothing.
   */
  async handleAfterSettle(ctx: SettleResultContext): Promise<void> {
    if (!ctx.result.success) return;
    const extraParsed = parseAuthCaptureExtra(ctx.requirements.extra);
    if ("error" in extraParsed) return;
    const extra = extraParsed.extra;
    const collect = asCollectPayload(ctx.paymentPayload.payload);

    if (ctx.phase === "before-handler" && collect) {
      this.authorizeResults.set(ctx.paymentPayload, ctx.result as SettleResponse);
      await this.persistCollect(collect, ctx, extra, "authorize");
      return;
    }
    if (ctx.phase === "after-handler" && extra.paymentFlow === "authorization" && collect) {
      await this.persistCollect(collect, ctx, extra, "charge");
      return;
    }
    if (
      ctx.phase === "after-handler" &&
      extra.paymentFlow === "escrow" &&
      extra.captureMode !== "deferred"
    ) {
      const type = (ctx.paymentPayload.payload as Record<string, unknown>).type;
      if (type === "capture") {
        const amount = ctx.result.amount ?? ctx.requirements.amount;
        const voidRemainder =
          (ctx.paymentPayload.payload as Record<string, unknown>).voidAuthorizerSignature !==
          undefined;
        const paymentInfo = (ctx.paymentPayload.payload as Record<string, unknown>).paymentInfo as
          | PaymentInfoStruct
          | undefined;
        if (paymentInfo) {
          const hash = computePaymentInfoHash(
            getEvmChainId(ctx.requirements.network),
            paymentInfo,
            extra.deployment.escrow,
          );
          await applyCaptureBalances(this.config.storage, hash, amount, voidRemainder);
        }
      }
    }
    if (ctx.phase === "cancel") {
      const paymentInfo = (ctx.paymentPayload.payload as Record<string, unknown>).paymentInfo as
        | PaymentInfoStruct
        | undefined;
      if (paymentInfo) {
        const hash = computePaymentInfoHash(
          getEvmChainId(ctx.requirements.network),
          paymentInfo,
          extra.deployment.escrow,
        );
        await this.config.storage.update(hash, current =>
          current ? { ...current, capturableAmount: "0" } : current,
        );
      }
    }
  }

  /**
   * Store a payment record after a successful collect settle.
   *
   * @param collect - Client collect payload.
   * @param ctx - Settle result context.
   * @param extra - Normalized extra used for reconstruction.
   * @param operation - `"authorize"` (hold) or `"charge"` (already captured).
   * @returns Nothing.
   */
  private async persistCollect(
    collect: AuthCaptureCollectPayload,
    ctx: SettleResultContext,
    extra: NormalizedAuthCaptureExtra,
    operation: "authorize" | "charge",
  ): Promise<void> {
    const paymentInfo = paymentInfoFromCollect(
      collect,
      ctx.requirements as PaymentRequirements,
      extra,
    );
    const chainId = getEvmChainId(ctx.requirements.network);
    const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo, extra.deployment.escrow);
    const signedAmount = isEip3009Payload(collect)
      ? collect.authorization.value
      : collect.permit2Authorization.permitted.amount;
    const settledAmount = ctx.result.amount ?? signedAmount;
    const saltNonce = "saltNonce" in collect ? collect.saltNonce : undefined;

    const record: AuthorizedPayment = {
      paymentInfoHash,
      paymentInfo,
      ...(saltNonce ? { saltNonce } : {}),
      receiverAuthorizer: extra.receiverAuthorizer,
      policy: extra.policy,
      network: ctx.requirements.network,
      capturableAmount: operation === "authorize" ? signedAmount : "0",
      refundableAmount: operation === "charge" ? settledAmount : "0",
      collectTransaction: ctx.result.transaction,
      createdAt: Date.now(),
      name: extra.name,
      version: extra.version,
      paymentFlow: extra.paymentFlow,
      operatorType: extra.operatorType,
      assetTransferMethod: extra.assetTransferMethod,
      authCaptureEscrow: extra.authCaptureEscrow,
    };
    // First write wins. A second collect for the same paymentInfoHash cannot succeed onchain
    // (the escrow marks it collected), so reaching here twice means a retry, and the stored
    // balances are then the authoritative ones — out-of-band capture/refund or a cancel void
    // may already have moved them.
    await this.config.storage.update(paymentInfoHash, current => current ?? record);
  }
}
