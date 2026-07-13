/**
 * Swap Settlement Extension for x402
 *
 * Enables token-agnostic payments: a payer can satisfy a `PaymentRequirements`
 * entry denominated in one asset (e.g. USDC) while holding a different asset
 * (e.g. WETH, cbBTC) on the same network. The facilitator atomically swaps
 * the payer's input asset and delivers the exact required asset and amount to
 * `payTo` in a single settlement transaction.
 *
 * ## For Resource Servers
 *
 * ```typescript
 * import { declareSwapSettlementExtension } from '@x402/extensions';
 *
 * const routes = [
 *   {
 *     path: "/api/data",
 *     price: "$0.01",
 *     extensions: {
 *       ...declareSwapSettlementExtension({
 *         quoteUrl: "https://facilitator.example.com/x402/swap/quote",
 *         networks: ["eip155:8453"],
 *       }),
 *     },
 *   },
 * ];
 * ```
 *
 * ## For Clients
 *
 * Automatic (wrap a registered scheme client):
 *
 * ```typescript
 * import { withSwapSettlement } from '@x402/extensions';
 *
 * client.register(
 *   "eip155:*",
 *   withSwapSettlement(new ExactEvmScheme(signer), signer, { inputAsset: WETH }),
 * );
 * ```
 *
 * Manual builders:
 *
 * ```typescript
 * import {
 *   buildQuoteRequest,
 *   assertRequirementsHashMatches,
 *   buildSwapWitness,
 *   buildPermit2WitnessTypedData,
 *   buildSwapSettlementExtension,
 * } from '@x402/extensions';
 *
 * const quote = await requestQuote(buildQuoteRequest(requirements, payer, inputAsset));
 * assertRequirementsHashMatches(requirements, quote); // MUST pass before signing
 * const witness = buildSwapWitness(quote, requirements);
 * const typedData = buildPermit2WitnessTypedData({ ... , witness });
 * const signature = await signer.signTypedData(typedData);
 * ```
 *
 * ## For Facilitators
 *
 * ```typescript
 * import {
 *   extractSwapSettlementInfo,
 *   validateSwapSettlementInfo,
 * } from '@x402/extensions';
 *
 * const info = extractSwapSettlementInfo(paymentPayload);
 * if (info && validateSwapSettlementInfo(info)) {
 *   // Look up the quote, verify the authorization, settle via the settler
 * }
 * ```
 */

// Export types
export type {
  SwapAuthorizationMethod,
  SwapSettlementServerInfo,
  SwapQuoteRequest,
  SwapQuoteAuthorizationMethodStatus,
  SwapQuoteResponse,
  SwapWitness,
  Permit2Authorization,
  Eip3009Authorization,
  Eip2612Authorization,
  AllowanceAuthorization,
  SwapSettlementPayloadInfo,
  SwapSettlementExtension,
  SwapSettlementDeclareConfig,
} from "./types";

export { SWAP_SETTLEMENT_KEY, SWAP_SETTLEMENT } from "./types";

// Export canonical encoding functions (shared by clients and facilitators)
export {
  jcsSerialize,
  computeRequirementsHash,
  computeQuoteIdHash,
  deriveEip3009Nonce,
} from "./canonical";

// Export client functions
export {
  CANONICAL_PERMIT2_ADDRESS,
  SWAP_WITNESS_TYPE_STRING,
  PERMIT2_SWAP_WITNESS_TYPES,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  SWAP_SETTLEMENT_INTENT_TYPES,
  buildQuoteRequest,
  assertRequirementsHashMatches,
  buildSwapWitness,
  buildPermit2WitnessTypedData,
  buildEip3009TypedData,
  buildIntentTypedData,
  buildSwapSettlementExtension,
  extractSwapSettlementServerInfo,
} from "./client";
export type {
  BuildPermit2WitnessTypedDataParams,
  BuildEip3009TypedDataParams,
  BuildIntentTypedDataParams,
} from "./client";

// Export the settler contract ABI (for facilitator implementations)
export { swapSettlerABI, quoteComponents } from "./abi";

// Export the client scheme wrapper (automatic swap settlement)
export { withSwapSettlement } from "./clientScheme";
export type { SwapSettlementSigner, WithSwapSettlementOptions } from "./clientScheme";

// Export resource service functions (for servers)
export {
  declareSwapSettlementExtension,
  swapSettlementResourceServerExtension,
} from "./resourceService";

// Export facilitator functions
export { extractSwapSettlementInfo, validateSwapSettlementInfo } from "./facilitator";
