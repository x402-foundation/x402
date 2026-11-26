import type { HEDERA_ASSET_TRANSFER_METHODS } from "./constants";
import { isJsonObject, parseTransferExecutorPayload } from "./internal";

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

/**
 * An `extra.assetTransferMethod` value this mechanism defines.
 */
export type HederaAssetTransferMethod = (typeof HEDERA_ASSET_TRANSFER_METHODS)[number];

/**
 * Executor and authorization a client presents for a `transferExecutor` payment.
 */
export type HederaTransferExecutorAuthorization = {
  /**
   * Executor contract id, one of `requirements.extra.executors`.
   */
  executor: string;
  /**
   * 0x-hex authorization the executor validates.
   */
  authorization: string;
};

/**
 * Exact Hedera payload for the `transferExecutor` method.
 */
export type ExactHederaTransferExecutorPayload = HederaTransferExecutorAuthorization & {
  /**
   * Hedera account id debited `amount`.
   */
  payer: string;
};

/**
 * Exact Hedera payload for either asset transfer method. `isCryptoTransferPayload`
 * and `isTransferExecutorPayload` tell the two apart.
 */
export type ExactHederaPayload = ExactHederaPayloadV2 | ExactHederaTransferExecutorPayload;

/**
 * Returns true when the payload has the `cryptoTransfer` shape. Narrows an
 * `ExactHederaPayload`, or an untrusted value.
 *
 * @param payload - Candidate payload
 * @returns True when `payload` is an object with a string `transaction`
 */
export function isCryptoTransferPayload(payload: unknown): payload is ExactHederaPayloadV2 {
  return isJsonObject(payload) && typeof payload.transaction === "string";
}

/**
 * Returns true when the payload is a well-formed `transferExecutor` payload
 * (`payer` and `executor` are Hedera ids, `authorization` is `0x`-prefixed hex).
 * Narrows an `ExactHederaPayload`, or an untrusted value.
 *
 * @param payload - Candidate payload
 * @returns True when `payer`, `executor` and `authorization` are well formed
 */
export function isTransferExecutorPayload(
  payload: unknown,
): payload is ExactHederaTransferExecutorPayload {
  return "payload" in parseTransferExecutorPayload(payload);
}

/**
 * `extra` of an exact Hedera kind advertised in `/supported`.
 */
export type HederaSupportedKindExtra = {
  feePayer: string;
  /**
   * Methods implemented on the network. Absent means `cryptoTransfer` only.
   */
  assetTransferMethods?: HederaAssetTransferMethod[];
  /**
   * Admitted executor contract ids, or `"*"` for any.
   */
  executors?: string[];
};

/**
 * A single NFT movement in a transaction record.
 */
export type HederaNftTransferEntry = {
  tokenId: string;
  serialNumber: string;
  senderAccountId: string | null;
  receiverAccountId: string | null;
};

/**
 * Normalized parent or child entry of a consensus transaction record.
 * Amounts are base-10 integer strings.
 */
export type HederaTransactionRecordEntry = {
  /**
   * Result name, e.g. `SUCCESS`.
   */
  result: string;
  /**
   * Fee charged for this entry in tinybars.
   */
  chargedFee: string;
  hbarTransfers: HederaTransferEntry[];
  tokenTransfers: Record<string, HederaTransferEntry[]>;
  nftTransfers: HederaNftTransferEntry[];
  /**
   * Staking reward credits the record marks as paid.
   */
  stakingRewardTransfers: HederaTransferEntry[];
};

/**
 * Contract log emitted during a transaction. Fields are 0x-hex.
 */
export type HederaContractLog = {
  address: string;
  topics: string[];
  data: string;
};

/**
 * Normalized consensus record of a transaction, children included.
 */
export type HederaTransactionRecord = {
  /**
   * Transaction id in the SDK `0.0.x@seconds.nanos` form.
   */
  transactionId: string;
  /**
   * Result name of the parent transaction.
   */
  status: string;
  /**
   * Fee charged for the parent transaction in tinybars.
   */
  transactionFee: string;
  parent: HederaTransactionRecordEntry;
  children: HederaTransactionRecordEntry[];
  /**
   * Logs of the contract result, nested calls included.
   */
  logs: HederaContractLog[];
};
