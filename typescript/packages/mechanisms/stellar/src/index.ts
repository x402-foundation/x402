/**
 * Stellar blockchain support for x402 protocol.
 *
 * This package provides Stellar network support for the x402 payment protocol,
 * including client signing, server validation, and facilitator settlement.
 *
 * @module
 */

// Exact scheme client
export { ExactStellarScheme } from "./exact";

// Upto scheme client; the server and facilitator are exported from ./upto/server and ./upto/facilitator
export { UptoStellarScheme } from "./upto/client";
export type { UptoStellarExtra, UptoStellarPayload } from "./upto/types";
export {
  UPTO_DEPLOYMENTS,
  UPTO_TESTNET_DEPLOYMENT,
  uptoStandardCodes,
  uptoStellarCodes,
  type UptoContractDeployment,
} from "./upto";

// Types
export * from "./types";

// Constants
export * from "./constants";

// Signers
export * from "./signer";

// Errors
export * from "./errors";

// Utilities
export * from "./utils";
export * from "./shared";

export {
  DEFAULT_ASSETS,
  getDefaultAsset,
  findDefaultAsset,
  type StellarDefaultAsset,
} from "./defaultAssets";
