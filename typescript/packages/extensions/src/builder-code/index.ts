/**
 * Builder Code Extension for x402 (ERC-8021)
 *
 * Enables attribution tracking for x402 payments by appending ERC-8021
 * Schema 2 builder codes to settlement transaction calldata.
 *
 * Three parties can attach their builder code:
 * - Agent (client): Sets the "a" field via BuilderCodeClientExtension
 * - Service (server): Declares in 402 response via declareBuilderCodeExtension()
 * - Facilitator: Adds to "s" array at settlement via BuilderCodeFacilitatorExtension
 *
 * ## Usage
 *
 * ### For Agents (Clients)
 *
 * ```typescript
 * import { createBuilderCodeClientExtension } from '@x402/extensions/builder-code';
 *
 * const client = new x402Client();
 * client.registerExtension(createBuilderCodeClientExtension({
 *   builderCode: "bc_my_agent",
 * }));
 * ```
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
 */

// Types
export type {
  BuilderCodeExtensionData,
  BuilderCodeFacilitatorConfig,
  BuilderCodeClientConfig,
} from "./types";

export {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  ERC_8021_MARKER,
  SCHEMA_2_ID,
} from "./types";

// CBOR encoding
export { encodeBuilderCodeSuffix } from "./cbor";

// Client
export { createBuilderCodeClientExtension } from "./client";

// Resource Server
export {
  declareBuilderCodeExtension,
  builderCodeResourceServerExtension,
} from "./resourceServer";

// Facilitator
export { BuilderCodeFacilitatorExtension } from "./facilitator";
