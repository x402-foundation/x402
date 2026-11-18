/**
 * ERC-20 Approval Gas Sponsoring Extension for x402
 *
 * Enables gasless Permit2 approval for generic ERC-20 tokens that do NOT
 * implement EIP-2612. The client signs (but does not broadcast) a raw
 * `approve(Permit2, MaxUint256)` transaction, and the facilitator broadcasts
 * it atomically before settling the Permit2 payment.
 *
 * ## For Resource Servers
 *
 * ```typescript
 * import { declareErc20ApprovalGasSponsoringExtension } from '@x402/extensions';
 *
 * const routes = [
 *   {
 *     path: "/api/data",
 *     price: { amount: "1000", asset: "0x...", extra: { assetTransferMethod: "permit2" } },
 *     extensions: {
 *       ...declareErc20ApprovalGasSponsoringExtension(),
 *     },
 *   },
 * ];
 * ```
 *
 * ## For Facilitators
 *
 * ```typescript
 * import {
 *   extractErc20ApprovalGasSponsoringInfo,
 *   validateErc20ApprovalGasSponsoringInfo,
 * } from '@x402/extensions';
 *
 * const info = extractErc20ApprovalGasSponsoringInfo(paymentPayload);
 * if (info && validateErc20ApprovalGasSponsoringInfo(info)) {
 *   // Broadcast the pre-signed approve tx, then call standard settle()
 * }
 * ```
 */

// Export types
export type {
  TransactionRequest,
  Erc20ApprovalGasSponsoringInfo,
  Erc20ApprovalGasSponsoringServerInfo,
  Erc20ApprovalGasSponsoringExtension,
  Erc20ApprovalGasSponsoringSigner,
  Erc20ApprovalGasSponsoringBaseSigner,
  Erc20ApprovalGasSponsoringFacilitatorExtension,
} from "./types";

export {
  ERC20_APPROVAL_GAS_SPONSORING,
  ERC20_APPROVAL_GAS_SPONSORING_VERSION,
  createErc20ApprovalGasSponsoringExtension,
} from "./types";

// Export resource service functions (for servers)
export {
  declareErc20ApprovalGasSponsoringExtension,
  erc20ApprovalGasSponsoringSchema,
} from "./resourceService";

// Export facilitator functions
export {
  extractErc20ApprovalGasSponsoringInfo,
  validateErc20ApprovalGasSponsoringInfo,
} from "./facilitator";
