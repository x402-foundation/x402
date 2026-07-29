/**
 * Builder Code Extension for x402 (ERC-8021)
 *
 * Enables attribution tracking for x402 payments by appending ERC-8021
 * Schema 2 builder codes to settlement transaction calldata.
 *
 * Three parties attach their builder code:
 * - Server: Declares `a` (app) in 402 response via declareBuilderCodeExtension()
 * - Client: Echoes `a` and adds `s` (service) via BuilderCodeClientExtension
 * - Facilitator: Optionally adds `w` (wallet) at settlement via BuilderCodeFacilitatorExtension
 *
 * ## Usage
 *
 * ### For Services (Resource Servers)
 *
 * ```typescript
 * import { declareBuilderCodeExtension, BUILDER_CODE } from '@x402/extensions/builder-code';
 *
 * extensions: {
 *   [BUILDER_CODE]: declareBuilderCodeExtension("bc_my_service"),
 * }
 * ```
 *
 * ### For Clients
 *
 * ```typescript
 * import { BuilderCodeClientExtension } from '@x402/extensions/builder-code';
 *
 * client.registerExtension(new BuilderCodeClientExtension("bc_my_client"));
 * ```
 *
 * ### For Facilitators
 *
 * ```typescript
 * import { BuilderCodeFacilitatorExtension } from '@x402/extensions/builder-code';
 *
 * facilitator.registerExtension(new BuilderCodeFacilitatorExtension({
 *   builderCode: "bc_my_facilitator", // optional
 * }));
 * ```
 */

// Types
export type {
  BuilderCodeExtensionData,
  BuilderCodeFacilitatorConfig,
  DataSuffixContext,
} from "./types";

export {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  ERC_8021_MARKER,
  MAX_SERVICE_CODES,
  SCHEMA_2_ID,
} from "./types";

// CBOR encoding
export { encodeBuilderCodeSuffix, parseBuilderCodeSuffixFromCalldata } from "./cbor";

// Resource Server
export {
  BUILDER_CODE_SCHEMA,
  type BuilderCodeRequiredExtension,
  declareBuilderCodeExtension,
  builderCodeResourceServerExtension,
} from "./server";

// Client
export { BuilderCodeClientExtension } from "./client";

// Facilitator
export { BuilderCodeFacilitatorExtension } from "./facilitator";
