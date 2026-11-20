import type { PaymentRequirements } from "@x402/core/types";
import { decodeBolt11 } from "../utils";
import { createInMemorySettlementCache, type SettlementCache } from "../settlementCache";
import type { ExactBip122Payload, LightningReceiver, DecodedBolt11 } from "../types";
import {
  SUPPORTED_NETWORKS,
  ASSET,
  PAY_TO_ANONYMOUS,
  PAYMENT_METHOD_LIGHTNING,
  SETTLEMENT_TTL_BUFFER_MS,
  ERR_UNSUPPORTED_NETWORK,
  ERR_INVALID_ASSET,
  ERR_INVALID_PAY_TO,
  ERR_INVALID_PAYMENT_METHOD,
  ERR_MISSING_INVOICE,
  ERR_INVOICE_SUBSTITUTION,
  ERR_INVOICE_EXPIRED,
  ERR_AMOUNT_MISMATCH,
  ERR_DUPLICATE_SETTLEMENT,
  ERR_INVOICE_NOT_PAID,
  ERR_INVOICE_IN_FLIGHT,
} from "../constants";

export interface ExactBip122FacilitatorOptions {
  receiver: LightningReceiver;
  settlementCache?: SettlementCache;
  /** Override BOLT11 decoder for testing. */
  decodeBolt11Fn?: (invoice: string) => DecodedBolt11;
  /** Override clock for testing. Returns ms epoch. */
  nowFn?: () => number;
}

export interface VerifyResult {
  verified: boolean;
  paymentHash?: string;
  amountMsat?: number;
  reason?: string;
}

export interface SettleResult {
  settled: boolean;
  paymentHash?: string;
  reason?: string;
}

/**
 * x402 facilitator-side scheme for Bitcoin Lightning (bip122/exact).
 *
 * Implements the 10-step verification defined in PR #1311:
 *  1. Validate network (bip122:*)
 *  2. Validate asset (BTC)
 *  3. Validate payTo (anonymous)
 *  4. Validate paymentMethod (lightning)
 *  5. Check invoice presence in requirements
 *  6. Invoice substitution guard — payload.invoice must match requirements.extra.invoice
 *  7. Decode BOLT11 — extract payment_hash, amount_msat, expiresAt
 *  8. Expiry check — reject expired invoices before hitting the node
 *  9. Amount check — decoded msat must match requirements.amount exactly
 * 10. Replay cache — reject already-settled payment_hash
 * 11. Node check — call receiver.lookupInvoice, handle in-flight
 *
 * settle() marks the payment_hash in the cache with TTL = (expiresAt - now) + buffer.
 *
 * @example
 * ```ts
 * import { ExactBip122FacilitatorScheme } from "@x402/bip122/exact/facilitator";
 *
 * const facilitator = new ExactBip122FacilitatorScheme({
 *   receiver: myLightningReceiver,
 * });
 *
 * const result = await facilitator.verify(payload, requirements);
 * ```
 */
export class ExactBip122FacilitatorScheme {
  readonly scheme = "exact";

  private readonly receiver: LightningReceiver;
  private readonly cache: SettlementCache;
  private readonly decodeFn: (invoice: string) => DecodedBolt11;
  private readonly nowFn: () => number;

  constructor(options: ExactBip122FacilitatorOptions) {
    this.receiver = options.receiver;
    this.cache = options.settlementCache ?? createInMemorySettlementCache();
    this.decodeFn = options.decodeBolt11Fn ?? decodeBolt11;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  async verify(
    payload: ExactBip122Payload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    // Step 1 — network
    if (!SUPPORTED_NETWORKS.includes(requirements.network as (typeof SUPPORTED_NETWORKS)[number])) {
      return fail(`${ERR_UNSUPPORTED_NETWORK}: ${requirements.network}`);
    }

    // Step 2 — asset
    if (requirements.asset && requirements.asset !== ASSET) {
      return fail(`${ERR_INVALID_ASSET}: expected BTC, got ${requirements.asset}`);
    }

    // Step 3 — payTo
    if (requirements.payTo && requirements.payTo !== PAY_TO_ANONYMOUS) {
      return fail(`${ERR_INVALID_PAY_TO}: expected anonymous`);
    }

    // Step 4 — paymentMethod
    const pm = requirements.extra?.paymentMethod;
    if (pm && pm !== PAYMENT_METHOD_LIGHTNING) {
      return fail(`${ERR_INVALID_PAYMENT_METHOD}: expected lightning, got ${pm}`);
    }

    // Step 5 — invoice in requirements
    const requiredInvoice = requirements.extra?.invoice;
    if (!requiredInvoice || typeof requiredInvoice !== "string") {
      return fail(ERR_MISSING_INVOICE);
    }

    // Step 6 — invoice substitution guard (must check BEFORE decode)
    // A misbehaving client could submit a different paid invoice from a prior request.
    if (payload.invoice !== requiredInvoice) {
      return fail(ERR_INVOICE_SUBSTITUTION);
    }

    // Step 7 — decode BOLT11
    let decoded: DecodedBolt11;
    try {
      decoded = this.decodeFn(payload.invoice);
    } catch (e) {
      return fail(`invalid_invoice: ${(e as Error).message}`);
    }

    // Step 8 — expiry check
    // Note: most Lightning backends don't surface "expired" as a distinct status.
    // We check explicitly: expiresAt is timestamp + expiry (seconds), compare to now (ms).
    const nowSec = this.nowFn() / 1000;
    if (decoded.expiresAt < nowSec) {
      return fail(ERR_INVOICE_EXPIRED);
    }

    // Step 9 — amount match (string compare to avoid float precision issues)
    const requiredMsat = Number(requirements.amount);
    if (decoded.amountMsat !== requiredMsat) {
      return fail(
        `${ERR_AMOUNT_MISMATCH}: invoice ${decoded.amountMsat} msat ≠ required ${requiredMsat} msat`,
      );
    }

    // Step 10 — replay cache
    if (this.cache.isSettled(decoded.paymentHash)) {
      return fail(ERR_DUPLICATE_SETTLEMENT);
    }

    // Step 11 — node check
    const status = await this.receiver.lookupInvoice(payload.invoice, requirements.network);

    if (!status) {
      return fail(ERR_INVOICE_NOT_PAID);
    }

    if (status.status === "in_flight") {
      return fail(ERR_INVOICE_IN_FLIGHT);
    }

    if (status.status !== "paid") {
      return fail(ERR_INVOICE_NOT_PAID);
    }

    return { verified: true, paymentHash: decoded.paymentHash, amountMsat: decoded.amountMsat };
  }

  async settle(
    payload: ExactBip122Payload,
    requirements: PaymentRequirements,
  ): Promise<SettleResult> {
    let decoded: DecodedBolt11;
    try {
      decoded = this.decodeFn(payload.invoice);
    } catch (e) {
      return { settled: false, reason: `invalid_invoice: ${(e as Error).message}` };
    }

    if (this.cache.isSettled(decoded.paymentHash)) {
      return { settled: false, reason: ERR_DUPLICATE_SETTLEMENT };
    }

    const status = await this.receiver.lookupInvoice(payload.invoice, requirements.network);
    if (!status || status.status !== "paid") {
      return { settled: false, reason: ERR_INVOICE_NOT_PAID };
    }

    const nowMs = this.nowFn();
    const expiresAtMs = decoded.expiresAt * 1000;
    const ttlMs = Math.max(expiresAtMs - nowMs, 0) + SETTLEMENT_TTL_BUFFER_MS;
    this.cache.markSettled(decoded.paymentHash, ttlMs);

    return { settled: true, paymentHash: decoded.paymentHash };
  }
}

function fail(reason: string): VerifyResult {
  return { verified: false, reason };
}
