/**
 * @module @x402/svm - x402 Payment Protocol SVM Implementation
 *
 * This module provides the SVM-specific implementation of the x402 payment protocol.
 */

// Export V2 implementations (default)
export { ExactSvmScheme } from "./exact";
export type { ExactSvmSchemeOptions } from "./exact/facilitator/scheme";
export { UptoSvmScheme } from "./upto";

// Export smart wallet verification helpers
export {
  assertFeePayerIsolated,
  assertSmartWalletLimits,
  validateComputeBudgetLimits,
  extractTransfersFromInnerInstructions,
  verifySmartWalletTransaction,
  verifyPostSettlement,
} from "./exact/facilitator/smartWalletVerification";
export type {
  SmartWalletLimits,
  SmartWalletOptions,
  TransferCheckedInfo,
} from "./exact/facilitator/smartWalletVerification";

// Export signer utilities and types
export { toClientSvmSigner, toFacilitatorSvmSigner } from "./signer";
export type {
  ClientSvmSigner,
  FacilitatorSvmSigner,
  FacilitatorAccountInfo,
  FacilitatorProgramAccount,
  FacilitatorSimulateTransactionOptions,
  FacilitatorRpcClient,
  FacilitatorRpcConfig,
  ClientSvmConfig,
  SvmInnerInstructionsResult,
} from "./signer";

// Export payload types
export type { ExactSvmPayloadV1, ExactSvmPayloadV2, UptoSvmPayloadV2 } from "./types";
export { isUptoSvmPayload } from "./types";

// Export settlement cache (shared across V1/V2 facilitator instances)
export { SettlementCache } from "./settlement-cache";

// Export constants
export * from "./constants";

// Export utilities
export * from "./utils";

export {
  DEFAULT_ASSETS,
  getDefaultAsset,
  findDefaultAsset,
  USDC_MAINNET_ADDRESS,
  USDC_DEVNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
  type SvmDefaultAsset,
} from "./defaultAssets";
