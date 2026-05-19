/**
 * Builder Code Extension for x402 (ERC-8021)
 *
 * Enables attribution tracking for x402 payments by appending ERC-8021
 * Schema 2 builder codes to settlement transaction calldata.
 *
 * Two parties attach their builder code:
 * - Service (server): Declares as "a" (app) in 402 response via declareBuilderCodeExtension()
 * - Facilitator: Adds as "w" (wallet) at settlement via BuilderCodeFacilitatorExtension
 *
 * The service can optionally include related on-chain services in the "s" array
 * (e.g., Morpho, Aerodrome) to attribute protocols it depends on.
 *
 * ## Usage
 *
 * ### For Services (Resource Servers)
 *
 * ```typescript
 * import { declareBuilderCodeExtension, BUILDER_CODE } from '@x402/extensions/builder-code';
 *
 * // In paywall config extensions
 * extensions: {
 *   [BUILDER_CODE]: declareBuilderCodeExtension("bc_my_service"),
 * }
 *
 * // With related on-chain services
 * extensions: {
 *   [BUILDER_CODE]: declareBuilderCodeExtension("bc_my_service", ["bc_morpho", "bc_aerodrome"]),
 * }
 * ```
 *
 * ### For Facilitators
 *
 * ```typescript
 * import { BuilderCodeFacilitatorExtension } from '@x402/extensions/builder-code';
 *
 * const facilitator = new x402Facilitator();
 * facilitator.registerExtension(new BuilderCodeFacilitatorExtension({
 *   builderCode: "bc_my_facilitator",
 * }));
 * ```
 *
 * Facilitator HTTP handlers must forward `paymentRequiredExtensions` from the
 * resource server on `/verify` and `/settle`. The client echoes the server
 * declaration in `paymentPayload.extensions`; the facilitator validates that
 * echo against the independent server source before encoding on-chain attribution.
 */

// Types
export type {
  BuilderCodeExtensionData,
  BuilderCodeFacilitatorConfig,
  SettlementCalldataContext,
} from "./types";

export { BUILDER_CODE, BUILDER_CODE_PATTERN, ERC_8021_MARKER, SCHEMA_2_ID } from "./types";

// CBOR encoding
export { encodeBuilderCodeSuffix, parseBuilderCodeSuffixFromCalldata } from "./cbor";

// Resource Server
export {
  BUILDER_CODE_SCHEMA,
  type BuilderCodeRequiredExtension,
  declareBuilderCodeExtension,
  builderCodeResourceServerExtension,
} from "./server";

// Facilitator
export { BuilderCodeFacilitatorExtension } from "./facilitator";
