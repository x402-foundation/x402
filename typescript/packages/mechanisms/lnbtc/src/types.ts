import type { Network } from "@x402/core/types";
import type { RequestBinding } from "./binding";

/**
 * Scheme-specific payment payload: the 32-byte preimage as lowercase hex.
 */
export interface ExactLnbtcPayload {
  preimage: string;
}

/**
 * Result of asking a payer node to pay an invoice.
 */
export interface LightningPayment {
  /** The invoice that was paid, byte-identical to the one requested. */
  invoice: string;
  /** Payment hash, 64 lowercase hex characters. */
  paymentHash: string;
  /** Invoice amount in millisatoshis, excluding routing fees. */
  amountMsat: bigint;
  status: "paid" | "unpaid" | "in_flight";
  /** Preimage, 64 lowercase hex characters; required when `status` is `paid`. */
  preimage?: string;
}

/**
 * Client-side Lightning node adapter. Credentials stay in the application.
 */
export interface LightningPayer {
  /**
   * Pays a BOLT11 invoice for exactly its amount and returns the result.
   *
   * @param invoice - BOLT11 invoice to pay
   * @param network - Concrete lnbtc network
   * @returns The payment result; `paid` must carry the preimage
   */
  payInvoice(invoice: string, network: Network): Promise<LightningPayment>;
}

/**
 * Parameters for creating a request-bound invoice.
 */
export interface CreateInvoiceParams {
  amountMsat: bigint;
  /** Request hash to sign as the BOLT11 description hash, lowercase hex. */
  descriptionHash: string;
  expirySeconds: number;
  network: Network;
}

/**
 * Server-side Lightning node adapter. The resource server must have exclusive
 * invoice-issuance authority for the node key used as `payTo`.
 */
export interface LightningReceiver {
  /**
   * Creates a fresh invoice with a new preimage and payment hash.
   *
   * @param params - Exact amount, description hash, expiry, and network
   * @returns The BOLT11 invoice
   */
  createInvoice(params: CreateInvoiceParams): Promise<string>;
}

/**
 * Restart-durable, atomic store of consumed `network:payment_hash` keys. Every
 * facilitator instance settling for the same receiver must share one store.
 */
export interface ReplayStore {
  /**
   * Atomically records a key as consumed.
   *
   * @param key - Canonical consumption key `network:payment_hash`
   * @param retainUntil - Unix seconds the entry must be kept until, at least
   * @returns `true` if inserted, `false` if the key already existed
   */
  consume(key: string, retainUntil: number): Promise<boolean>;
}

/**
 * Returns the binding for the request currently being paid for or served.
 */
export type RequestBindingProvider = () => RequestBinding | Promise<RequestBinding>;

/**
 * Clock returning Unix seconds.
 */
export type Clock = () => number;
