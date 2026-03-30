/**
 * Sign-In-With-X Extension for x402 v2
 *
 * CAIP-122 compliant wallet authentication for payment-protected resources.
 * Allows clients to prove control of a wallet that may have previously paid
 * for a resource, enabling servers to grant access without requiring repurchase.
 *
 * Auth-only routes (accepts: []) are supported — the SIWX request hook
 * grants access on a valid signature alone, no payment required.
 *
 * @module sign-in-with-x
 */

// Constants
export { SIGN_IN_WITH_X, SIWxPayloadSchema } from "./types";
export { SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET } from "./solana";

// Types
export type {
  SIWxExtension,
  SIWxExtensionInfo,
  SIWxExtensionSchema,
  SIWxPayload,
  DeclareSIWxOptions,
  SignatureScheme,
  SignatureType,
  SIWxValidationResult,
  SIWxValidationOptions,
  SIWxVerifyResult,
  EVMMessageVerifier,
  SIWxVerifyOptions,
  SupportedChain,
} from "./types";
export type { CompleteSIWxInfo } from "./client";

// Server
export { declareSIWxExtension } from "./declare";
export { siwxResourceServerExtension } from "./server";
export { parseSIWxHeader } from "./parse";
export { validateSIWxMessage } from "./validate";
export { verifySIWxSignature } from "./verify";
export { buildSIWxSchema } from "./schema";

// Client
export { createSIWxMessage } from "./message";
export { createSIWxPayload } from "./client";
export { encodeSIWxHeader } from "./encode";
export { wrapFetchWithSIWx } from "./fetch";
export {
  getEVMAddress,
  getSolanaAddress,
  signEVMMessage,
  signSolanaMessage,
  type SIWxSigner,
  type EVMSigner,
  type SolanaSigner,
} from "./sign";

// Chain utilities - EVM
export { formatSIWEMessage, verifyEVMSignature, extractEVMChainId, isEVMSigner } from "./evm";

// Chain utilities - Solana
export {
  formatSIWSMessage,
  verifySolanaSignature,
  decodeBase58,
  encodeBase58,
  extractSolanaChainReference,
  isSolanaSigner,
} from "./solana";

// Storage
export { type SIWxStorage, InMemorySIWxStorage } from "./storage";

// Hooks
export {
  createSIWxSettleHook,
  createSIWxRequestHook,
  createSIWxClientHook,
  type CreateSIWxHookOptions,
  type SIWxHookEvent,
} from "./hooks";
