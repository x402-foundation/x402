/**
 * Algorand Network Constants for x402 AVM Implementation
 *
 * CAIP-2 Network Identifiers use the format: algorand:<genesis-hash-base64>
 * Genesis hashes uniquely identify Algorand networks.
 */

// ============================================================================
// CAIP-2 Network Identifiers (V2)
// ============================================================================

/**
 * CAIP-2 network identifier for Algorand Mainnet
 * Format: algorand:<genesis-hash-base64>
 */
export const ALGORAND_MAINNET_CAIP2 = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

/**
 * CAIP-2 network identifier for Algorand Testnet
 * Format: algorand:<genesis-hash-base64>
 */
export const ALGORAND_TESTNET_CAIP2 = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

/**
 * All supported CAIP-2 network identifiers
 */
export const CAIP2_NETWORKS = [ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2] as const;

// ============================================================================
// Genesis Hashes
// ============================================================================

/**
 * Algorand Mainnet genesis hash (base64 encoded)
 */
export const ALGORAND_MAINNET_GENESIS_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

/**
 * Algorand Testnet genesis hash (base64 encoded)
 */
export const ALGORAND_TESTNET_GENESIS_HASH = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

// ============================================================================
// USDC ASA (Algorand Standard Asset) Configuration
// ============================================================================

/**
 * USDC ASA ID on Algorand Mainnet
 *
 * @see https://algoexplorer.io/asset/31566704
 */
export const USDC_MAINNET_ASA_ID = "31566704";

/**
 * USDC ASA ID on Algorand Testnet
 *
 * @see https://testnet.algoexplorer.io/asset/10458941
 */
export const USDC_TESTNET_ASA_ID = "10458941";

/**
 * USDC decimals (same across all networks)
 */
export const USDC_DECIMALS = 6;

/**
 * USDC configuration per network
 */
export const USDC_CONFIG: Record<string, { asaId: string; name: string; decimals: number }> = {
  [ALGORAND_MAINNET_CAIP2]: {
    asaId: USDC_MAINNET_ASA_ID,
    name: "USDC",
    decimals: USDC_DECIMALS,
  },
  [ALGORAND_TESTNET_CAIP2]: {
    asaId: USDC_TESTNET_ASA_ID,
    name: "USDC",
    decimals: USDC_DECIMALS,
  },
};

// ============================================================================
// Transaction Limits
// ============================================================================

/**
 * Maximum reasonable fee per transaction in microAlgos (5000 µAlgo).
 *
 * Algorand transaction fees are calculated as:
 *   fee = max(current_fee_per_byte * transaction_size_in_bytes, min_fee)
 *
 * Under normal (non-congested) conditions, current_fee_per_byte is 0,
 * so fee = min_fee = 1000 µAlgo (0.001 ALGO).
 *
 * During network congestion, fees can rise. This constant is set to 5x
 * the minimum fee (5000 µAlgo) as a reasonable upper bound per transaction.
 *
 * For fee payer transactions that cover an entire group via fee pooling,
 * use `maxReasonableGroupFee(groupSize)` which multiplies this per-txn
 * cap by the number of transactions in the group.
 */
export const MAX_REASONABLE_FEE_PER_TXN = 5000;

/**
 * Calculates the maximum reasonable fee for a fee payer transaction
 * that covers an entire atomic group via fee pooling.
 *
 * @param groupSize - Number of transactions in the atomic group
 * @returns Maximum acceptable fee in microAlgos
 */
export function maxReasonableGroupFee(groupSize: number): number {
  return MAX_REASONABLE_FEE_PER_TXN * groupSize;
}

// Address validation: use isValidAddress() from @algorandfoundation/algokit-utils/common
// Address length: use ALGORAND_ADDRESS_LENGTH from @algorandfoundation/algokit-utils/common
