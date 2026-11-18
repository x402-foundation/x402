import type { Network } from "@x402/core/types";
import { AccountId, Transaction, TransferTransaction } from "@hiero-ledger/sdk";
import { HBAR_ASSET_ID, HEDERA_ENTITY_ID_REGEX, SUPPORTED_HEDERA_NETWORKS } from "./constants";
import type {
  HederaTransferEntry,
  ExactHederaPayloadV2,
  InspectedHederaTransaction,
} from "./types";

/**
 * Validate a Hedera account or token id string.
 *
 * @param entityId - Entity id to validate
 * @returns True when valid
 */
export function isValidHederaEntityId(entityId: string): boolean {
  return HEDERA_ENTITY_ID_REGEX.test(entityId);
}

/**
 * Returns true when the network is supported by this Hedera mechanism.
 *
 * @param network - Network identifier
 * @returns True when supported
 */
export function isSupportedHederaNetwork(
  network: string,
): network is (typeof SUPPORTED_HEDERA_NETWORKS)[number] {
  return SUPPORTED_HEDERA_NETWORKS.includes(network as (typeof SUPPORTED_HEDERA_NETWORKS)[number]);
}

/**
 * Assert that a Hedera CAIP-2 network is supported by this mechanism.
 *
 * @param network - Network identifier
 */
export function assertSupportedHederaNetwork(network: string): asserts network is Network {
  if (!isSupportedHederaNetwork(network)) {
    throw new Error(`Unsupported Hedera network: ${network}`);
  }
}

/**
 * Returns true if the asset identifier is native HBAR.
 *
 * @param asset - Asset identifier
 * @returns True if HBAR
 */
export function isHbarAsset(asset: string): boolean {
  return asset === HBAR_ASSET_ID;
}

/**
 * Validate that an asset is either HBAR or an HTS token id.
 *
 * @param asset - Asset identifier
 * @returns True when valid
 */
export function isValidHederaAsset(asset: string): boolean {
  return isHbarAsset(asset) || isValidHederaEntityId(asset);
}

/**
 * Extract transaction string from exact hedera payload.
 *
 * @param payload - Hedera payload
 * @returns Base64 transaction string
 */
export function extractTransactionFromPayload(payload: ExactHederaPayloadV2): string {
  if (!payload || typeof payload.transaction !== "string" || payload.transaction.length === 0) {
    throw new Error("invalid_exact_hedera_payload_transaction");
  }
  return payload.transaction;
}

/**
 * Decode and inspect a Hedera transaction from base64 bytes.
 *
 * @param transactionBase64 - Base64-encoded Hedera transaction
 * @returns Normalized inspected transaction details
 */
export function inspectHederaTransaction(transactionBase64: string): InspectedHederaTransaction {
  const bytes = Buffer.from(transactionBase64, "base64");
  const transaction = Transaction.fromBytes(bytes);
  const isTransferTransaction = transaction instanceof TransferTransaction;
  const hbarTransfers = isTransferTransaction
    ? normalizeHbarTransfers(transaction.hbarTransfers)
    : [];
  const tokenTransfers = isTransferTransaction
    ? normalizeTokenTransfers(transaction.tokenTransfers)
    : {};
  const transactionType = transaction.constructor?.name;
  const transactionId = transaction.transactionId?.toString?.();
  const transactionIdAccountId = transaction.transactionId?.accountId?.toString?.();

  if (!transactionType || !transactionId || !transactionIdAccountId) {
    throw new Error("invalid_hedera_transaction_metadata");
  }

  return {
    transactionType,
    transactionId,
    transactionIdAccountId,
    hasNonTransferOperations: !isTransferTransaction,
    hbarTransfers,
    tokenTransfers,
  };
}

/**
 * Sums a transfer list and returns net amount.
 *
 * @param transfers - Transfer entries
 * @returns Net sum
 */
export function sumTransfers(transfers: HederaTransferEntry[]): bigint {
  return transfers.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
}

/**
 * Returns net transfer value received by an account.
 *
 * @param transfers - Transfer entries
 * @param accountId - Account to calculate for
 * @returns Net amount
 */
export function getNetForAccount(transfers: HederaTransferEntry[], accountId: string): bigint {
  return transfers
    .filter(entry => hederaAccountIdsEqual(entry.accountId, accountId))
    .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
}

/**
 * Returns all account ids with positive net receipts.
 *
 * @param transfers - Transfer entries
 * @returns Receiver ids
 */
export function getPositiveReceivers(transfers: HederaTransferEntry[]): string[] {
  const net = new Map<string, bigint>();
  for (const entry of transfers) {
    net.set(entry.accountId, (net.get(entry.accountId) ?? 0n) + BigInt(entry.amount));
  }
  return [...net.entries()].filter(([, value]) => value > 0n).map(([accountId]) => accountId);
}

/**
 * Canonicalize a Hedera account id or alias when possible.
 *
 * @param accountIdOrAlias - Account or alias value
 * @returns Canonical id/alias, or original when parsing fails
 */
export function normalizeHederaAccountIdentifier(accountIdOrAlias: string): string {
  try {
    return AccountId.fromString(accountIdOrAlias).toString();
  } catch {
    return accountIdOrAlias;
  }
}

/**
 * Returns true when two account identifiers refer to the same account/alias.
 *
 * @param left - Left identifier
 * @param right - Right identifier
 * @returns True when canonicalized identifiers match
 */
export function hederaAccountIdsEqual(left: string, right: string): boolean {
  return normalizeHederaAccountIdentifier(left) === normalizeHederaAccountIdentifier(right);
}

/**
 * Normalize SDK hbar transfers into shared transfer shape.
 *
 * @param hbarTransfers - Public Hedera SDK hbar transfer map
 * @returns Normalized transfer entries
 */
function normalizeHbarTransfers(
  hbarTransfers: TransferTransaction["hbarTransfers"],
): HederaTransferEntry[] {
  const normalizedTransfers: HederaTransferEntry[] = [];
  for (const [accountId, amount] of hbarTransfers) {
    normalizedTransfers.push({
      accountId: accountId.toString(),
      amount: amount.toTinybars().toString(),
    });
  }
  return normalizedTransfers;
}

/**
 * Group SDK token transfers by token id.
 *
 * @param tokenTransfers - Public Hedera SDK token transfer map
 * @returns Token transfer map keyed by token id
 */
function normalizeTokenTransfers(
  tokenTransfers: TransferTransaction["tokenTransfers"],
): Record<string, HederaTransferEntry[]> {
  const grouped: Record<string, HederaTransferEntry[]> = {};
  for (const [tokenId, accountTransfers] of tokenTransfers) {
    const normalizedTokenId = tokenId.toString();
    if (!grouped[normalizedTokenId]) {
      grouped[normalizedTokenId] = [];
    }
    for (const [accountId, amount] of accountTransfers) {
      grouped[normalizedTokenId].push({
        accountId: accountId.toString(),
        amount: amount.toString(),
      });
    }
  }
  return grouped;
}
