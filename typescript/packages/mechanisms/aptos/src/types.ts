/**
 * Exact Aptos payload structure containing a base64 encoded transaction
 */
export type ExactAptosPayload = {
  /**
   * Base64 encoded JSON containing transaction and senderAuthenticator byte arrays
   */
  transaction: string;
};

/**
 * Decoded Aptos payment payload structure
 */
export type DecodedAptosPayload = {
  /**
   * Transaction bytes as number array
   */
  transaction: number[];
  /**
   * Sender authenticator bytes as number array
   */
  senderAuthenticator: number[];
};
