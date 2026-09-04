/**
 * Authorization Evidence Extension
 *
 * Pre-payment authorization evidence for agent-originated payments: before a
 * payment is verified, the resource server checks an operator-signed spend
 * mandate through an External Verifier Contract v1 (EVC) verifier and fails
 * closed on every abnormal path. The verifier is a pluggable subprocess; any
 * EVC-conformant implementation works (`npx @bolyra/evc-conformance` runs the
 * published 28-vector host suite against this extension's host boundary).
 *
 * ## Usage
 *
 * ### For Resource Servers
 *
 * ```typescript
 * import {
 *   createAuthorizationEvidenceResourceServerExtension,
 *   createCommandVerifier,
 *   declareAuthorizationEvidenceExtension,
 * } from "@x402/extensions/authorization-evidence";
 *
 * server.registerExtension(
 *   createAuthorizationEvidenceResourceServerExtension({
 *     audience: "api.example.com",
 *     verifier: createCommandVerifier({ command: ["bolyra", "verify"] }),
 *   }),
 * );
 *
 * // Declaring the extension on a route makes evidence mandatory there.
 * const routes = {
 *   "GET /api/report": {
 *     accepts: [...],
 *     extensions: { ...declareAuthorizationEvidenceExtension() },
 *   },
 * };
 * ```
 *
 * ### For Clients
 *
 * ```typescript
 * import { AuthorizationEvidenceClientExtension } from "@x402/extensions/authorization-evidence";
 *
 * const extension = new AuthorizationEvidenceClientExtension(async info => {
 *   return loadMandatePresentation();
 * });
 * ```
 */

// Export types
export type {
  AuthorizationEvidenceDeclaration,
  AuthorizationEvidenceExtension,
  AuthorizationEvidenceInfo,
  AuthorizationEvidenceServerOptions,
  AuthorizationEvidenceVerifier,
  CommandVerifierOptions,
  DeclareAuthorizationEvidenceOptions,
  EvcDecision,
  EvcFailureClass,
  EvcNonceEntry,
  EvidenceNonceStore,
  PaymentRequirementLike,
} from "./types";
export {
  AUTHORIZATION_EVIDENCE,
  AUTHORIZATION_EVIDENCE_PROFILE,
  DEFAULT_CHALLENGE_TTL_SECONDS,
  DEFAULT_VERIFIER_MAX_STDOUT_BYTES,
  DEFAULT_VERIFIER_TIMEOUT_MS,
} from "./types";

// Export schema
export { authorizationEvidenceSchema } from "./schema";

// Export resource server functions
export { declareAuthorizationEvidenceExtension } from "./declare";
export {
  createAuthorizationEvidenceResourceServerExtension,
  mintChallengeNonce,
  validateChallengeNonce,
} from "./server";

// Export verification building blocks
export {
  buildEvidenceVerifierRequest,
  createCommandVerifier,
  createInMemoryNonceStore,
  decideAuthorizationEvidence,
  denialReason,
} from "./verify";
export type { EvidenceChallenge } from "./verify";
export { runEvcVerifier } from "./evcHost";

// Export client functions
export { AuthorizationEvidenceClientExtension } from "./client";
export type { EvidenceProvider } from "./client";
