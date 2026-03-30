/**
 * Exact Stellar payload structure containing a base64 encoded Stellar transaction
 */
export type ExactStellarPayloadV2 = {
  /**
   * Base64 encoded Stellar transaction
   */
  transaction: string;
};
