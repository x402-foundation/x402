/**
 * Exact Hedera payload structure containing a base64 encoded transaction.
 */
export type ExactHederaPayloadV2 = {
  /**
   * Base64 encoded serialized, partially signed Hedera transaction.
   */
  transaction: string;
};

/**
 * A single signed transfer entry.
 * Positive values credit an account, negative values debit an account.
 */
export type HederaTransferEntry = {
  accountId: string;
  amount: string;
};

/**
 * Parsed transaction details used by facilitator verification.
 * Utilities decode Hedera bytes and return this normalized shape.
 */
export type InspectedHederaTransaction = {
  transactionType: string;
  transactionId: string;
  transactionIdAccountId: string;
  hasNonTransferOperations: boolean;
  hbarTransfers: HederaTransferEntry[];
  tokenTransfers: Record<string, HederaTransferEntry[]>;
};
