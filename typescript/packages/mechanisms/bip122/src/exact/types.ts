export type LightningPaymentStatus = "unpaid" | "in_flight" | "paid";

export interface LightningInvoiceStatus {
  invoice: string;
  paymentHash: string;
  amountMsat: number;
  /** Unix timestamp (seconds) when the invoice expires: timestamp + expiry from BOLT11 */
  expiresAt: number;
  status: LightningPaymentStatus;
  payer?: string;
  settledAt?: number;
}

/** Minimal decoded BOLT11 fields required for verification. */
export interface DecodedBolt11 {
  paymentHash: string;
  /** Amount in millisatoshis */
  amountMsat: number;
  /** Unix timestamp (seconds) of invoice creation */
  timestamp: number;
  /** Invoice expiry in seconds */
  expiry: number;
  /** Absolute expiry: timestamp + expiry */
  expiresAt: number;
}

/** x402 payload sent by the client after paying the invoice. */
export interface ExactBip122Payload {
  /** The BOLT11 invoice that was paid. */
  invoice: string;
}

/** Protocol for objects that can pay Lightning invoices (client-side). */
export interface LightningPayer {
  /** Pay a BOLT11 invoice. Resolves when payment is complete. */
  payInvoice(invoice: string, network: string): Promise<void>;
}

/** Protocol for objects that can issue and look up Lightning invoices (server-side). */
export interface LightningReceiver {
  /** Create a BOLT11 invoice for the given amount. Returns the invoice string. */
  createInvoice(
    amountMsat: number,
    memo: string,
    expirySeconds: number,
    network: string,
  ): Promise<string>;
  /**
   * Look up the status of a previously-issued invoice.
   * Returns null if the invoice is unknown.
   * Note: "expired" is NOT a distinct status on most backends — callers must
   * check expiresAt independently via the decoded BOLT11.
   */
  lookupInvoice(invoice: string, network: string): Promise<LightningInvoiceStatus | null>;
}
