/**
 * BSV x402 V2 types.
 *
 * The payload mirrors the BRC-29 payment message (as used by BRC-121
 * "Simple 402 Payments"): a fully-signed, fully-funded BSV transaction in
 * BEEF format plus the BRC-42 derivation metadata the recipient's wallet
 * needs to take custody of the payment output via `internalizeAction`.
 */

/**
 * x402 V2 payment payload for the BSV `exact` scheme.
 *
 * Sent as the `payload` field of `PaymentPayload` (x402Version: 2).
 *
 * @example
 * ```json
 * {
 *   "transaction": "AQEBAQ...",
 *   "derivationPrefix": "aGVsbG8gd28=",
 *   "derivationSuffix": "MTcwMDAwMDAwMDAwMA==",
 *   "senderIdentityKey": "02ab...ef",
 *   "outputIndex": 0
 * }
 * ```
 */
export interface ExactBsvPayloadV2 {
  /**
   * Base64-encoded BEEF (BRC-62) / Atomic BEEF (BRC-95) transaction as
   * returned by BRC-100 `createAction`. Fully signed and funded by the
   * client, including SPV ancestry.
   */
  transaction: string;

  /** Base64-encoded BRC-29 derivation prefix (payment-wide random nonce) */
  derivationPrefix: string;

  /**
   * Base64-encoded BRC-29 derivation suffix. Per BRC-121, the decoded value
   * MUST be a decimal Unix timestamp in milliseconds; verifiers reject
   * payloads whose timestamp falls outside the freshness window.
   */
  derivationSuffix: string;

  /** Client identity public key (compressed secp256k1 hex) */
  senderIdentityKey: string;

  /** Zero-based index of the payment output in the transaction */
  outputIndex: number;
}
