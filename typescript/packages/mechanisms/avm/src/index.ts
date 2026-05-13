/**
 * @module @x402/avm - x402 Payment Protocol AVM (Algorand) Implementation
 *
 * This module provides the Algorand-specific implementation of the x402 payment protocol.
 *
 * @example Client signer:
 * ```typescript
 * import { toClientAvmSigner } from "@x402/avm";
 *
 * const signer = toClientAvmSigner(process.env.AVM_PRIVATE_KEY!);
 * ```
 *
 * @example Facilitator signer:
 * ```typescript
 * import { toFacilitatorAvmSigner } from "@x402/avm";
 *
 * const signer = toFacilitatorAvmSigner(process.env.AVM_PRIVATE_KEY!);
 * ```
 */

// Exact scheme client
export { ExactAvmScheme } from "./exact";

// Signer helpers and interfaces
export {
  isAvmSignerWallet,
  toClientAvmSigner,
  toFacilitatorAvmSigner,
  getAlgokitSigner,
  ALGOKIT_SIGNER,
} from "./signer";
export type {
  ClientAvmSigner,
  ClientAvmConfig,
  FacilitatorAvmSigner,
  FacilitatorAvmSignerConfig,
} from "./signer";

// Re-export algokit-utils signer types for consumers who want native interop
export type {
  AddressWithTransactionSigner,
  AddressWithSigners,
  TransactionSigner,
} from "@algorandfoundation/algokit-utils/transact";

// Types
export type { ExactAvmPayloadV2 } from "./types";
export { isExactAvmPayload } from "./types";

// Constants
export {
  // CAIP-2 Network Identifiers
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  CAIP2_NETWORKS,
  // Genesis Hashes
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  // USDC Configuration
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
  USDC_DECIMALS,
  USDC_CONFIG,
  // Transaction Limits
  MAX_REASONABLE_FEE_PER_TXN,
  maxReasonableGroupFee,
} from "./constants";

// Re-export algokit-utils constants that consumers may need
export { ALGORAND_ADDRESS_LENGTH } from "@algorandfoundation/algokit-utils/common";
export { ALGORAND_MIN_TX_FEE } from "@algorandfoundation/algokit-utils/amount";

// Utilities
export {
  encodeTransaction,
  decodeTransaction,
  decodeSignedTransaction,
  decodeUnsignedTransaction,
  isValidAlgorandAddress,
  getSenderFromTransaction,
  convertToTokenAmount,
  convertFromTokenAmount,
  getNetworkFromCaip2,
  isAlgorandNetwork,
  isTestnetNetwork,
  getGenesisHashFromTransaction,
  validateGroupId,
  getTransactionId,
  hasSignature,
} from "./utils";
