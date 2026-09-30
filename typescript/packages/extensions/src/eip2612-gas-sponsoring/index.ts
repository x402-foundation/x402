/**
 * EIP-2612 Gas Sponsoring Extension for x402
 *
 * Enables gasless Permit2 approval for tokens that implement EIP-2612.
 * The client signs an off-chain permit, and the facilitator submits it
 * on-chain via `x402Permit2Proxy.settleWithPermit`.
 *
 * ## For Resource Servers
 *
 * ```typescript
 * import { declareEip2612GasSponsoringExtension } from '@x402/extensions';
 *
 * const routes = [
 *   {
 *     path: "/api/data",
 *     price: "$0.01",
 *     extensions: {
 *       ...declareEip2612GasSponsoringExtension(),
 *     },
 *   },
 * ];
 * ```
 *
 * ## For Facilitators
 *
 * ```typescript
 * import {
 *   extractEip2612GasSponsoringInfo,
 *   validateEip2612GasSponsoringInfo,
 * } from '@x402/extensions';
 *
 * const info = extractEip2612GasSponsoringInfo(paymentPayload);
 * if (info && validateEip2612GasSponsoringInfo(info)) {
 *   // Use settleWithPermit instead of settle
 * }
 * ```
 */

// Export types
export type {
  Eip2612GasSponsoringInfo,
  Eip2612GasSponsoringServerInfo,
  Eip2612GasSponsoringExtension,
} from "./types";

export { EIP2612_GAS_SPONSORING } from "./types";

// Export resource service functions (for servers)
export { declareEip2612GasSponsoringExtension } from "./resourceService";

// Export facilitator functions
export { extractEip2612GasSponsoringInfo, validateEip2612GasSponsoringInfo } from "./facilitator";
