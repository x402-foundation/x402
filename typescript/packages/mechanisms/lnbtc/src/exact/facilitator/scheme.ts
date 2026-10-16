import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { bindingsEqual, parseBindingExtra } from "../../binding";
import {
  ASSET_TRANSFER_METHOD,
  CAIP_FAMILY,
  DEFAULT_CLOCK_SKEW_SECONDS,
  Errors,
  LNBTC_NETWORKS,
  LnbtcError,
  PAYMENT_FLOW,
  REPLAY_RETENTION_SECONDS,
  SCHEME,
} from "../../constants";
import { canonicalize } from "../../jcs";
import type { Clock, ReplayStore } from "../../types";
import {
  checkExpiry,
  isSupportedNetwork,
  reject,
  unixNow,
  validateCoreTerms,
  validateInvoice,
  validateMethodAndFlow,
  validateSkew,
} from "../../validation";

/**
 * Options for the lnbtc facilitator.
 */
export interface ExactLnbtcFacilitatorOptions {
  /** Restart-durable replay store shared by every instance settling for a receiver. */
  replayStore: ReplayStore;
  /** Clock-skew allowance in seconds (default 60). */
  clockSkewSeconds?: number;
  /** Clock returning Unix seconds. */
  clock?: Clock;
  /** Supported networks mapped to BOLT11 currency (default: mainnet and testnet). */
  networks?: Readonly<Record<string, string>>;
}

// Extra fields checked by dedicated rules rather than the generic equality rule.
const SCHEME_EXTRA_FIELDS = new Set([
  "assetTransferMethod",
  "paymentFlow",
  "invoice",
  "requestHash",
  "requestBindingProfile",
  "requestBindingParams",
]);

/**
 * Facilitator for `exact` on `lnbtc`: verifies the preimage locally against the
 * accepted invoice and consumes the payment hash. Needs no receiver access.
 */
export class ExactLnbtcScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = CAIP_FAMILY;
  private readonly replayStore: ReplayStore;
  private readonly skew: number;
  private readonly clock: Clock;
  private readonly networks: Readonly<Record<string, string>>;

  /**
   * Creates the facilitator scheme.
   *
   * @param options - Replay store, clock, skew, and networks
   */
  constructor(options: ExactLnbtcFacilitatorOptions) {
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    validateSkew(skew);
    this.replayStore = options.replayStore;
    this.skew = skew;
    this.clock = options.clock ?? unixNow;
    this.networks = options.networks ?? LNBTC_NETWORKS;
  }

  /**
   * Advertises the only supported transfer method and flow.
   *
   * @param network - Network identifier
   * @returns Supported-kind extra
   */
  getExtra(network: Network): Record<string, unknown> | undefined {
    if (!isSupportedNetwork(network, this.networks)) return undefined;
    return { assetTransferMethod: ASSET_TRANSFER_METHOD, paymentFlow: PAYMENT_FLOW };
  }

  /**
   * Lightning settlement uses no facilitator signers.
   *
   * @param _network - Network identifier
   * @returns An empty list
   */
  getSigners(_network: string): string[] {
    return [];
  }

  /**
   * The `upfront` flow does not use `/verify`.
   *
   * @param _payload - Payment payload
   * @param _requirements - Payment requirements
   * @returns An invalid result with the payment-flow reason
   */
  async verify(
    _payload: PaymentPayload,
    _requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return { isValid: false, invalidReason: Errors.paymentFlow };
  }

  /**
   * Validates the proof in specification order, then atomically consumes
   * `network:payment_hash`. A replay store error propagates: nothing settles.
   *
   * @param payload - Payment payload carrying `accepted` and the preimage
   * @param requirements - Server-computed requirements, including the expected request hash
   * @returns The settlement result; `transaction` is the payment hash
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;
    const options = { now: this.clock(), skew: this.skew };
    let key: string;
    let paymentHash: string;
    let retainUntil: number;
    try {
      // Step 1, then step 2: once the core fields are equal, checking the
      // requirements' terms covers `accepted` too.
      const accepted = matchCoreFields(payload?.accepted, requirements);
      validateCoreTerms(requirements, this.networks);
      const expected = this.matchExtra(accepted, requirements);

      // Step 4: both invoices present; settlement uses the accepted one.
      requireInvoice(requirements.extra?.invoice);
      requireInvoice(accepted.extra?.invoice);

      // Steps 5-7: invoice terms, preimage, then the paid-but-expired window.
      const invoice = validateInvoice(
        accepted.extra.invoice,
        requirements,
        expected,
        this.networks,
        options,
      );
      validatePreimage(payload.payload?.preimage, invoice.paymentHash);
      checkExpiry(invoice, options, "settlement");

      paymentHash = invoice.paymentHash;
      key = `${network}:${paymentHash}`;
      retainUntil =
        invoice.timestamp + invoice.expirySeconds + this.skew + REPLAY_RETENTION_SECONDS;
    } catch (error) {
      if (error instanceof LnbtcError) return failure(error.reason, network);
      throw error;
    }

    // Only an explicit `true` counts as inserted; anything else fails closed.
    if ((await this.replayStore.consume(key, retainUntil)) !== true) {
      return failure(Errors.duplicateSettlement, network);
    }
    return { success: true, transaction: paymentHash, network };
  }

  /**
   * Step 3: transfer method, flow, request binding, and other declared extras.
   *
   * @param accepted - Client-echoed requirements
   * @param requirements - Server-computed requirements
   * @returns The expected request hash
   */
  private matchExtra(accepted: PaymentRequirements, requirements: PaymentRequirements): string {
    validateMethodAndFlow(requirements.extra);
    validateMethodAndFlow(accepted.extra);
    const expected = parseBindingExtra(requirements.extra);
    const echoed = parseBindingExtra(accepted.extra);
    if (!bindingsEqual(expected, echoed)) reject(Errors.requestMismatch);

    // Both extras are objects here: parseBindingExtra rejected anything else.
    const echoedExtra: Record<string, unknown> = accepted.extra;
    for (const [field, value] of Object.entries(requirements.extra)) {
      if (SCHEME_EXTRA_FIELDS.has(field)) continue;
      if (!Object.prototype.hasOwnProperty.call(echoedExtra, field)) reject(Errors.extraMismatch);
      if (!jcsEqual(value, echoedExtra[field])) reject(Errors.extraMismatch);
    }
    return expected.requestHash;
  }
}

/**
 * Step 1: the echoed core fields equal the requirements.
 *
 * @param accepted - Client-echoed requirements (untrusted)
 * @param requirements - Server-computed requirements
 * @returns The echoed requirements, known to be an object
 */
function matchCoreFields(
  accepted: PaymentRequirements | undefined,
  requirements: PaymentRequirements,
): PaymentRequirements {
  if (typeof accepted !== "object" || accepted === null) reject(Errors.unsupportedScheme);
  if (accepted.scheme !== requirements.scheme) reject(Errors.unsupportedScheme);
  if (accepted.network !== requirements.network) reject(Errors.networkMismatch);
  if (accepted.amount !== requirements.amount) reject(Errors.amountMismatch);
  if (accepted.asset !== requirements.asset) reject(Errors.asset);
  if (accepted.payTo !== requirements.payTo) reject(Errors.payToMismatch);
  if (accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
    reject(Errors.maxTimeoutMismatch);
  }
  return accepted;
}

/**
 * Step 4: an invoice field is present (validated as BOLT11 in step 5).
 *
 * @param invoice - Candidate invoice field
 */
function requireInvoice(invoice: unknown): void {
  if (invoice === undefined || invoice === null || invoice === "") reject(Errors.invoiceMissing);
}

/**
 * Step 6: the preimage is 32 bytes of lowercase hex hashing to the payment hash.
 *
 * @param preimage - Candidate preimage
 * @param paymentHash - Invoice payment hash, lowercase hex
 */
function validatePreimage(preimage: unknown, paymentHash: string): void {
  if (preimage === undefined || preimage === null) reject(Errors.preimageMissing);
  if (typeof preimage !== "string" || !/^[0-9a-f]*$/.test(preimage)) {
    reject(Errors.preimageMalformed);
  }
  if (preimage.length !== 64) reject(Errors.preimageLength);
  if (bytesToHex(sha256(hexToBytes(preimage))) !== paymentHash) {
    reject(Errors.preimageHashMismatch);
  }
}

/**
 * Compares two JSON values by their JCS serialization.
 *
 * @param a - Left value
 * @param b - Right value
 * @returns Whether they serialize identically
 */
function jcsEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

/**
 * Builds a failed settlement response.
 *
 * @param reason - Stable error reason
 * @param network - Requirements network
 * @returns The settlement response
 */
function failure(reason: string, network: Network): SettleResponse {
  return { success: false, errorReason: reason, transaction: "", network };
}
