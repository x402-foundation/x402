import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { PaymentCreationContext } from "@x402/core/client";
import { bindingsEqual } from "../../binding";
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  Errors,
  HTTP_PROFILE,
  LNBTC_NETWORKS,
  LnbtcError,
  SCHEME,
} from "../../constants";
import type { Clock, LightningPayer, RequestBindingProvider } from "../../types";
import {
  checkExpiry,
  reject,
  unixNow,
  validateInvoice,
  validateRequirements,
  validateSkew,
} from "../../validation";

/**
 * Options for the lnbtc client.
 */
export interface ExactLnbtcClientOptions {
  /** Payer node adapter; must return the preimage for paid invoices. */
  payer: LightningPayer;
  /**
   * Returns the binding of the request being paid for, computed by the
   * application from the intended request (`httpRequestBinding` or
   * `mcpToolCallBinding`), never from the payment challenge.
   */
  requestBinding: RequestBindingProvider;
  /** Clock-skew allowance in seconds (default 60). */
  clockSkewSeconds?: number;
  /** Clock returning Unix seconds. */
  clock?: Clock;
  /** Supported networks mapped to BOLT11 currency (default: mainnet and testnet). */
  networks?: Readonly<Record<string, string>>;
}

/**
 * Client for `exact` on `lnbtc`: validates the request-bound invoice, pays it,
 * and returns the verified preimage.
 */
export class ExactLnbtcScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  readonly schemeHooks: SchemeClientHooks;
  private readonly options: ExactLnbtcClientOptions;
  private readonly skew: number;
  private readonly clock: Clock;
  private readonly networks: Readonly<Record<string, string>>;

  /**
   * Creates the client scheme.
   *
   * @param options - Payer adapter, request binding provider, clock, and skew
   */
  constructor(options: ExactLnbtcClientOptions) {
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    validateSkew(skew);
    this.options = options;
    this.skew = skew;
    this.clock = options.clock ?? unixNow;
    this.networks = options.networks ?? LNBTC_NETWORKS;
    this.schemeHooks = { onBeforePaymentCreation: ctx => this.checkResource(ctx) };
  }

  /**
   * Validates the challenge against the intended request, pays the invoice,
   * and verifies the returned preimage.
   *
   * @param x402Version - Protocol version
   * @param requirements - Selected payment requirements
   * @param context - Spend cap from the client's spend controls, if any
   * @returns The payload carrying the preimage
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const advertised = validateRequirements(requirements, this.networks);
    assertWithinCap(requirements.amount, context?.maxAmountPerPayment);
    const intended = await this.options.requestBinding();
    if (!bindingsEqual(intended, advertised)) reject(Errors.requestMismatch);

    const invoiceText = requirements.extra.invoice as string;
    const options = { now: this.clock(), skew: this.skew };
    const invoice = validateInvoice(
      invoiceText,
      requirements,
      intended.requestHash,
      this.networks,
      options,
    );
    checkExpiry(invoice, options, "unexpired");

    const payment = await this.options.payer.payInvoice(invoiceText, requirements.network);
    if (payment.invoice !== invoiceText) reject(Errors.payerInvoiceMismatch);
    if (payment.paymentHash !== invoice.paymentHash) reject(Errors.payerPaymentHashMismatch);
    if (payment.amountMsat !== invoice.amountMsat) reject(Errors.payerAmountMismatch);
    if (payment.status === "in_flight") reject(Errors.paymentInFlight);
    if (payment.status !== "paid") reject(Errors.paymentNotPaid);
    const preimage: unknown = payment.preimage;
    if (preimage === undefined || preimage === null) reject(Errors.payerPreimageRequired);
    if (typeof preimage !== "string" || !/^[0-9a-f]{64}$/.test(preimage)) {
      reject(Errors.payerPreimageMalformed);
    }
    if (bytesToHex(sha256(hexToBytes(preimage))) !== invoice.paymentHash) {
      reject(Errors.payerPreimageHashMismatch);
    }
    return { x402Version, payload: { preimage } };
  }

  /**
   * For `http:1`, requires `PaymentRequired.resource.url` to equal the
   * intended request URL before any payment.
   *
   * @param ctx - Payment creation context
   * @returns An abort result on mismatch
   */
  private async checkResource(
    ctx: PaymentCreationContext,
  ): Promise<void | { abort: true; reason: string }> {
    try {
      const intended = await this.options.requestBinding();
      if (
        intended.requestBindingProfile === HTTP_PROFILE &&
        ctx.paymentRequired.resource?.url !== intended.resourceUrl
      ) {
        return { abort: true, reason: Errors.requestMismatch };
      }
    } catch (error) {
      if (error instanceof LnbtcError) return { abort: true, reason: error.reason };
      throw error;
    }
  }
}

/**
 * Refuses an amount above the client's atomic spend cap. Core spend controls
 * already filter requirements; this keeps the scheme safe on its own.
 *
 * @param amount - Required millisatoshis (validated positive integer)
 * @param cap - Atomic cap from spend controls, if any
 */
function assertWithinCap(amount: string, cap: string | undefined): void {
  if (cap === undefined) return;
  if (!/^[0-9]+$/.test(cap) || BigInt(amount) > BigInt(cap)) {
    throw new Error(`lnbtc amount ${amount} msat exceeds maxAmountPerPayment ${cap}`);
  }
}
