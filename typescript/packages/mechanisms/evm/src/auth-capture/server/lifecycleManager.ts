import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { getEvmChainId } from "../../utils";
import { AUTH_CAPTURE_SCHEME } from "../constants";
import { parseAuthCaptureExtra, type NormalizedAuthCaptureExtra } from "../extra";
import { buildCapturePayload, buildRefundPayload, buildVoidPayload } from "../lifecyclePayload";
import type {
  AuthorizerSigner,
  CaptureOptions,
  CapturePayload,
  RefundPayload,
  VoidPayload,
} from "../types";
import { applyCaptureBalances, type AuthorizedPayment } from "./storage";
import type { AuthCaptureEvmScheme } from "./scheme";

export interface AuthCaptureLifecycleManagerConfig {
  scheme: AuthCaptureEvmScheme;
  facilitator: FacilitatorClient;
}

/**
 * Out-of-band capture / void / refund against stored authorized payments.
 * Storage and the receiver-authorizer signer are read through the scheme.
 */
export class AuthCaptureLifecycleManager {
  /**
   * Create a facilitator-bound lifecycle manager.
   *
   * @param config - Scheme (storage + signer) and facilitator client.
   */
  constructor(private readonly config: AuthCaptureLifecycleManagerConfig) {}

  /**
   * Capture a stored authorized payment through the facilitator.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @param opts - Capture amount, fees, and optional void-remainder.
   * @returns Facilitator settle response.
   */
  async capture(paymentInfoHash: `0x${string}`, opts?: CaptureOptions): Promise<SettleResponse> {
    const record = await this.requireRecord(paymentInfoHash);
    const extra = extraFromRecord(record);
    const chainId = getEvmChainId(record.network);
    const amount = opts?.amount ?? record.capturableAmount;
    const payload = await buildCapturePayload({
      record: {
        paymentInfo: record.paymentInfo,
        paymentInfoHash: record.paymentInfoHash,
        capturableAmount: record.capturableAmount,
        refundableAmount: record.refundableAmount,
        saltNonce: this.requireSaltNonce(record),
      },
      extra,
      signer: this.requireSigner(),
      chainId,
      amount,
      feeBps: opts?.feeBps,
      feeAmount: opts?.feeAmount,
      feeReceiver: opts?.feeReceiver,
      voidRemainder: opts?.voidRemainder,
    });
    const response = await this.settleLifecycle(record, payload);
    if (response.success) {
      await applyCaptureBalances(
        this.config.scheme.getStorage(),
        record.paymentInfoHash,
        amount,
        Boolean(opts?.voidRemainder),
      );
    }
    return response;
  }

  /**
   * Void the remaining hold on a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @returns Facilitator settle response.
   */
  async voidPayment(paymentInfoHash: `0x${string}`): Promise<SettleResponse> {
    const record = await this.requireRecord(paymentInfoHash);
    const extra = extraFromRecord(record);
    const payload = await buildVoidPayload({
      record: {
        paymentInfo: record.paymentInfo,
        paymentInfoHash: record.paymentInfoHash,
        saltNonce: this.requireSaltNonce(record),
      },
      extra,
      signer: this.requireSigner(),
      chainId: getEvmChainId(record.network),
    });
    const response = await this.settleLifecycle(record, payload);
    if (response.success) {
      await this.config.scheme
        .getStorage()
        .update(record.paymentInfoHash, current =>
          current ? { ...current, capturableAmount: "0" } : current,
        );
    }
    return response;
  }

  /**
   * Refund captured funds on a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @param opts - Refund amount.
   * @param opts.amount - Atomic refund amount in token base units.
   * @returns Facilitator settle response.
   */
  async refund(paymentInfoHash: `0x${string}`, opts: { amount: string }): Promise<SettleResponse> {
    const record = await this.requireRecord(paymentInfoHash);
    const extra = extraFromRecord(record);
    const payload = await buildRefundPayload({
      record: {
        paymentInfo: record.paymentInfo,
        paymentInfoHash: record.paymentInfoHash,
        capturableAmount: record.capturableAmount,
        refundableAmount: record.refundableAmount,
        saltNonce: this.requireSaltNonce(record),
      },
      extra,
      signer: this.requireSigner(),
      chainId: getEvmChainId(record.network),
      amount: opts.amount,
    });
    const response = await this.settleLifecycle(record, payload);
    if (response.success) {
      await this.config.scheme.getStorage().update(record.paymentInfoHash, current => {
        if (!current) return current;
        const next = BigInt(current.refundableAmount) - BigInt(opts.amount);
        return { ...current, refundableAmount: next.toString() };
      });
    }
    return response;
  }

  /**
   * Read a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @returns The record, or undefined.
   */
  async getAuthorizedPayment(
    paymentInfoHash: `0x${string}`,
  ): Promise<AuthorizedPayment | undefined> {
    return this.config.scheme.getStorage().get(paymentInfoHash);
  }

  /**
   * List stored authorized payments.
   *
   * @returns All records in storage.
   */
  async listAuthorizedPayments(): Promise<AuthorizedPayment[]> {
    return this.config.scheme.getStorage().list();
  }

  /**
   * POST a signed lifecycle payload to the configured facilitator client.
   *
   * @param record - Stored payment.
   * @param payload - Capture, void, or refund envelope.
   * @returns Facilitator settle response.
   */
  private async settleLifecycle(
    record: AuthorizedPayment,
    payload: CapturePayload | VoidPayload | RefundPayload,
  ): Promise<SettleResponse> {
    const requirements = buildRequirements(record);
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: payload as unknown as Record<string, unknown>,
    };
    return this.config.facilitator.settle(paymentPayload, requirements);
  }

  /**
   * Load a stored payment or throw.
   *
   * @param paymentInfoHash - Storage key.
   * @returns The record.
   */
  private async requireRecord(paymentInfoHash: `0x${string}`): Promise<AuthorizedPayment> {
    const record = await this.config.scheme.getStorage().get(paymentInfoHash);
    if (!record) {
      throw new Error(`AuthCapture: no authorized payment ${paymentInfoHash}`);
    }
    return record;
  }

  /**
   * Bound-payment `saltNonce` from storage, required for lifecycle settles.
   *
   * @param record - Stored payment.
   * @returns The 32-byte nonce.
   */
  private requireSaltNonce(record: AuthorizedPayment): `0x${string}` {
    if (!record.saltNonce) {
      throw new Error(
        "AuthCapture: saltNonce is required for lifecycle settles (salt binding is on)",
      );
    }
    return record.saltNonce;
  }

  /**
   * Receiver-authorizer signer from the scheme, or throw if helpers were called without it.
   *
   * @returns Authorizer signer.
   */
  private requireSigner(): AuthorizerSigner {
    const signer = this.config.scheme.getReceiverAuthorizerSigner();
    if (!signer) {
      throw new Error(
        "AuthCapture lifecycle helpers require a receiverAuthorizerSigner on AuthCaptureEvmScheme",
      );
    }
    return signer;
  }
}

/**
 * Rebuild extra from a stored authorized-payment record.
 *
 * @param record - Stored payment.
 * @returns Extra sufficient to reconstruct and settle lifecycle payloads.
 */
function extraFromRecord(record: AuthorizedPayment): NormalizedAuthCaptureExtra {
  const parsed = parseAuthCaptureExtra({
    captureAuthorizer: record.paymentInfo.operator,
    captureDeadline: record.paymentInfo.authorizationExpiry,
    refundDeadline: record.paymentInfo.refundExpiry,
    feeRecipient: record.paymentInfo.feeReceiver,
    minFeeBps: record.paymentInfo.minFeeBps,
    maxFeeBps: record.paymentInfo.maxFeeBps,
    name: record.name,
    version: record.version,
    paymentFlow: record.paymentFlow,
    operatorType: record.operatorType,
    assetTransferMethod: record.assetTransferMethod,
    receiverAuthorizer: record.receiverAuthorizer,
    policy: record.policy,
    captureMode: record.paymentFlow === "escrow" ? "deferred" : "sync",
    authCaptureEscrow: record.authCaptureEscrow,
  });
  if ("error" in parsed) {
    throw new Error(`AuthCapture: invalid stored extra: ${parsed.error}`);
  }
  return parsed.extra;
}

/**
 * PaymentRequirements for a facilitator lifecycle settle from a stored record.
 *
 * @param record - Stored payment.
 * @returns Requirements whose extra matches the original collect.
 */
function buildRequirements(record: AuthorizedPayment): PaymentRequirements {
  return {
    scheme: AUTH_CAPTURE_SCHEME,
    network: record.network,
    asset: record.paymentInfo.token,
    amount: record.paymentInfo.maxAmount,
    payTo: record.paymentInfo.receiver,
    maxTimeoutSeconds: 1,
    extra: extraFromRecord(record) as unknown as Record<string, unknown>,
  };
}
