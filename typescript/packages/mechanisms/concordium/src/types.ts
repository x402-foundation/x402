/**
 * Concordium x402 V2 types.
 *
 * Defines the sponsored-transaction payload that replaces the legacy
 * `{ txHash, sender }` V1 shape. The client now sends a partially-signed
 * V1 transaction; the facilitator adds the sponsor signature and broadcasts.
 */

export type TransactionStatus = "pending" | "committed" | "finalized" | "failed";

export interface TransactionInfo {
  txHash: string;
  status: TransactionStatus;
  sender: string;
  recipient?: string;
  amount?: string;
  /** "CCD" for native CCD, token symbol for PLT (e.g. "EURR") */
  asset?: string;
}

export interface SignableV1TransactionHeader {
  /** Sender's Concordium account address (base58check) */
  sender: string;
  /** Account sequence number (nonce) */
  nonce: number;
  /**
   * Unix timestamp (seconds) after which the transaction expires.
   * Must be in the future; SHOULD NOT exceed now + 600 s per spec.
   */
  expiry: number;
  /** Number of sender credential signatures */
  numSignatures: number;
  /** Sponsor information */
  sponsor: {
    /** Facilitator's account address (base58check) */
    address?: string;
    /**
     * Backward-compat alias used by some SDK JSON shapes.
     * Prefer `address`.
     */
    account?: string;
    /** Number of sponsor credential signatures */
    numSignatures: number;
  };
}

/** Native CCD simple transfer */
export interface SimpleTransferPayload {
  type: "transfer";
  /** Recipient address (base58check) */
  toAddress: string;
  /** Amount in microCCD (atomic units) */
  amount: string;
}

/** Native CCD transfer with memo */
export interface SimpleTransferWithMemoPayload {
  type: "transferWithMemo";
  /** Recipient address (base58check) */
  toAddress: string;
  /** Amount in microCCD (atomic units) */
  amount: string;
  /** Optional memo bytes (hex-encoded) */
  memo?: string;
}

/** PLT / CIS-2 token update (must contain exactly one operation per spec rule 9) */
export interface TokenUpdatePayload {
  type: "tokenUpdate";
  /** Transfer operations — spec requires exactly 1 */
  tokenId: string;
  operations: string;
}

export type SignableV1TransactionPayload =
  | SimpleTransferPayload
  | SimpleTransferWithMemoPayload
  | TokenUpdatePayload;

/**
 * Concordium credential-indexed signature map.
 * Structure: `{ credentialIndex: { keyIndex: hexEncodedSignature } }`
 */
export type CredentialSignatureMap = Record<string, Record<string, string>>;

/**
 * Partially-signed Concordium V1 sponsored transaction.
 *
 * From the client:
 * - `signatures.sender` is populated with the client's credential signature(s).
 * - `signatures.sponsor` is an empty object `{}`.
 *
 * The facilitator calls `addSponsorSignature()` during settlement to populate
 * `signatures.sponsor` before broadcasting.
 */
export interface SignableV1Transaction {
  /** Must be exactly 1 (V1 sponsored format) */
  version: 1;
  header: SignableV1TransactionHeader;
  payload: SignableV1TransactionPayload;
  signatures: {
    /** Populated by client */
    sender: CredentialSignatureMap;
    /** Empty `{}` from client; populated by facilitator */
    sponsor: CredentialSignatureMap;
  };
}

/**
 * x402 V2 payment payload for the Concordium `exact` scheme.
 *
 * Sent as the `payload` field of `PaymentPayload` (x402Version: 2).
 *
 * @example
 * ```json
 * {
 *   "signedTransaction": { "version": 1, "header": { ... }, ... }
 * }
 * ```
 */
export interface ExactConcordiumPayloadV2 {
  /** Partially-signed V1 sponsored transaction (sponsor slot empty) */
  signedTransaction: SignableV1Transaction;
}
