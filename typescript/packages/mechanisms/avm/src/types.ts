/**
 * AVM (Algorand) Types for x402 Payment Protocol
 *
 * Defines payload structures and type guards for Algorand transactions.
 */

/**
 * V2 Payload for Algorand exact payment scheme
 *
 * Contains an atomic transaction group with a designated payment transaction.
 * Transactions are encoded as base64 msgpack.
 *
 * @example
 * ```typescript
 * const payload: ExactAvmPayloadV2 = {
 *   paymentGroup: [
 *     "gqNzaWfEQ...", // Fee payer transaction (signed by facilitator)
 *     "gqNzaWfEQ...", // ASA transfer (signed by client)
 *   ],
 *   paymentIndex: 1,  // Payment is the second transaction
 * };
 * ```
 */
export interface ExactAvmPayloadV2 {
  /**
   * Array of base64-encoded msgpack transactions forming an atomic group.
   * May include unsigned transactions (for fee payer) that the facilitator will sign.
   */
  paymentGroup: string[];

  /**
   * Zero-based index of the payment transaction within paymentGroup.
   * This transaction must be an ASA transfer to the payTo address.
   */
  paymentIndex: number;
}

/**
 * Type guard to check if a payload is an ExactAvmPayloadV2
 *
 * @param payload - The payload to check
 * @returns True if the payload is a valid ExactAvmPayloadV2
 */
export function isExactAvmPayload(payload: unknown): payload is ExactAvmPayloadV2 {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "paymentGroup" in payload &&
    "paymentIndex" in payload &&
    Array.isArray((payload as ExactAvmPayloadV2).paymentGroup) &&
    typeof (payload as ExactAvmPayloadV2).paymentIndex === "number" &&
    (payload as ExactAvmPayloadV2).paymentGroup.every(item => typeof item === "string")
  );
}

// Transaction and SignedTransaction types are provided by @algorandfoundation/algokit-utils/transact
// Use those directly instead of custom type definitions.
