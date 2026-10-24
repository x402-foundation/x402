import { secp256k1 } from "@noble/curves/secp256k1";
import type { PaymentRequirements } from "@x402/core/types";
import { parseBindingExtra, type RequestBindingExtra } from "./binding";
import { decodeInvoice, type DecodedInvoice } from "./bolt11";
import {
  ASSET,
  ASSET_TRANSFER_METHOD,
  Errors,
  LnbtcError,
  type LnbtcErrorReason,
  PAYMENT_FLOW,
  SCHEME,
} from "./constants";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const COMPRESSED_PUBKEY = /^0[23][0-9a-f]{64}$/;

/**
 * Throws an {@link LnbtcError} with the given reason.
 *
 * @param reason - Stable reason
 * @returns Never returns
 */
export function reject(reason: LnbtcErrorReason): never {
  throw new LnbtcError(reason);
}

/**
 * Validates the core requirement terms (step 2 of facilitator validation).
 *
 * @param req - Payment requirements
 * @param networks - Supported networks mapped to BOLT11 currency
 */
export function validateCoreTerms(
  req: PaymentRequirements,
  networks: Readonly<Record<string, string>>,
): void {
  if (req.scheme !== SCHEME) reject(Errors.unsupportedScheme);
  if (!isSupportedNetwork(req.network, networks)) reject(Errors.unsupportedNetwork);
  if (req.asset !== ASSET) reject(Errors.asset);
  if (typeof req.amount !== "string" || !POSITIVE_INTEGER.test(req.amount)) reject(Errors.amount);
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) {
    reject(Errors.maxTimeout);
  }
  if (!isCompressedPubkey(req.payTo)) reject(Errors.payToMalformed);
}

/**
 * Validates the transfer method and payment flow of an `extra` object.
 *
 * @param extra - Requirements `extra`
 */
export function validateMethodAndFlow(extra: Record<string, unknown> | undefined): void {
  // Only an omitted method defaults; an explicit value (even null) must be "bolt11".
  const method =
    extra?.assetTransferMethod === undefined ? ASSET_TRANSFER_METHOD : extra.assetTransferMethod;
  if (method !== ASSET_TRANSFER_METHOD) reject(Errors.assetTransferMethod);
  if (extra?.paymentFlow !== PAYMENT_FLOW) reject(Errors.paymentFlow);
}

/**
 * Validates every requirement field a client or server checks before paying or
 * issuing: core terms, method, flow, and binding fields.
 *
 * @param req - Payment requirements
 * @param networks - Supported networks mapped to BOLT11 currency
 * @returns The validated binding fields
 */
export function validateRequirements(
  req: PaymentRequirements,
  networks: Readonly<Record<string, string>>,
): RequestBindingExtra {
  validateCoreTerms(req, networks);
  validateMethodAndFlow(req.extra);
  return parseBindingExtra(req.extra);
}

/**
 * Options for invoice validation.
 */
export interface InvoiceCheckOptions {
  /** Validation time, Unix seconds. */
  now: number;
  /** Non-negative clock-skew allowance, seconds. */
  skew: number;
}

/**
 * Strictly decodes an invoice and checks it against the requirements: the
 * facilitator's step 5, and the client and server pre-payment checks except
 * expiry (see {@link checkExpiry}).
 *
 * @param invoice - BOLT11 invoice text
 * @param req - Requirements whose terms the invoice must match
 * @param expectedRequestHash - The expected request hash, lowercase hex
 * @param networks - Supported networks mapped to BOLT11 currency
 * @param options - Time and expiry policy
 * @returns The decoded invoice
 */
export function validateInvoice(
  invoice: unknown,
  req: PaymentRequirements,
  expectedRequestHash: string,
  networks: Readonly<Record<string, string>>,
  options: InvoiceCheckOptions,
): DecodedInvoice {
  if (invoice === undefined || invoice === null || invoice === "") reject(Errors.invoiceMissing);
  if (typeof invoice !== "string") reject(Errors.invoiceDecodeFailed);
  let decoded: DecodedInvoice;
  try {
    decoded = decodeInvoice(invoice);
  } catch {
    reject(Errors.invoiceDecodeFailed);
  }
  if (decoded.descriptionHashes.length !== 1 || decoded.inlineDescriptionCount !== 0) {
    reject(Errors.invoiceDescription);
  }
  if (decoded.descriptionHashes[0] !== expectedRequestHash) reject(Errors.invoiceRequestMismatch);
  if (decoded.payee !== req.payTo) reject(Errors.invoicePayeeMismatch);
  if (decoded.currency !== networks[req.network]) reject(Errors.invoiceCurrencyMismatch);
  if (decoded.amountMsat !== BigInt(req.amount)) reject(Errors.invoiceAmountMismatch);
  if (decoded.expirySeconds !== req.maxTimeoutSeconds) reject(Errors.invoiceExpiryMismatch);
  if (decoded.timestamp > options.now + options.skew) reject(Errors.invoiceCreatedInFuture);
  return decoded;
}

/**
 * Applies an expiry policy to a decoded invoice.
 *
 * @param invoice - Decoded invoice
 * @param options - Validation time and skew
 * @param policy - `unexpired`: the invoice must not have expired at `now`
 *   (client, server). `settlement`: the paid-but-expired window, valid through
 *   `invoice_end + skew` inclusive (facilitator).
 */
export function checkExpiry(
  invoice: DecodedInvoice,
  options: InvoiceCheckOptions,
  policy: "unexpired" | "settlement",
): void {
  const end = invoice.timestamp + invoice.expirySeconds;
  const expired = policy === "settlement" ? options.now > end + options.skew : options.now >= end;
  if (expired) reject(Errors.invoiceExpired);
}

/**
 * Checks that a network is one of the configured networks (own keys only, so
 * names such as `constructor` never match).
 *
 * @param network - Candidate network
 * @param networks - Supported networks mapped to BOLT11 currency
 * @returns Whether the network is supported
 */
export function isSupportedNetwork(
  network: unknown,
  networks: Readonly<Record<string, string>>,
): network is string {
  return typeof network === "string" && Object.prototype.hasOwnProperty.call(networks, network);
}

/**
 * Validates a clock-skew allowance.
 *
 * @param skew - Seconds
 */
export function validateSkew(skew: number): void {
  if (!Number.isSafeInteger(skew) || skew < 0) {
    throw new RangeError("clock skew must be a non-negative integer number of seconds");
  }
}

/**
 * Checks for a lowercase compressed secp256k1 public key on the curve.
 *
 * @param value - Candidate
 * @returns Whether it is valid
 */
export function isCompressedPubkey(value: unknown): value is string {
  if (typeof value !== "string" || !COMPRESSED_PUBKEY.test(value)) return false;
  try {
    secp256k1.ProjectivePoint.fromHex(value).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/**
 * Current Unix time in whole seconds.
 *
 * @returns Seconds since the epoch
 */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
