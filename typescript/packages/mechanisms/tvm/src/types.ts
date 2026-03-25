/**
 * TVM payment payload — the scheme-specific data inside PaymentPayload.payload.
 *
 * Minimal: only settlementBoc (internal message BoC) and asset (token master).
 * All other fields (from, to, amount, publicKey) are derived from the BoC
 * by the facilitator, per TON Core team review.
 */
export interface TvmPaymentPayload {
  /** Internal message BoC (base64) containing signed W5 body + optional stateInit */
  settlementBoc: string;
  /** Jetton master contract address (raw format: 0:hex) */
  asset: string;
}
