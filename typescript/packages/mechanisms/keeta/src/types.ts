/**
 * Exact Keeta payload structure containing a base64 encoded block
 */
export type ExactKeetaPayload = {
  /**
   * Base64 encoded ASN.1 DER-serialized signed block
   */
  block: string;
};
