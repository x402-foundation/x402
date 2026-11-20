/**
 * Trust-Provider Extension for x402
 *
 * Gates payment settlement on behavioral trust evaluation from external providers.
 * Uses the onBeforeSettle hook to query trust providers, aggregate decisions,
 * and block settlement for untrusted agents.
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   createTrustProviderExtension,
 *   declareTrustProviderExtension,
 *   TRUST_PROVIDER,
 * } from '@x402/extensions/trust-provider';
 *
 * const config = {
 *   providers: [{
 *     name: 'dominion-observatory',
 *     evaluate: async (query) => {
 *       const res = await fetch(
 *         'https://dominion-observatory.sgdata.workers.dev/api/agent-query/' + query.payer.agent_id
 *       );
 *       const data = await res.json();
 *       return {
 *         schema: 'x402-trust-evaluation-v0.1',
 *         provider: 'dominion-observatory',
 *         provider_url: 'https://dominion-observatory.sgdata.workers.dev',
 *         decision: data.server.trust_score >= 60 ? 'PASS' : data.server.trust_score < 40 ? 'FAIL' : 'UNCERTAIN',
 *         score: data.server.trust_score / 100,
 *         evaluated_at: new Date().toISOString(),
 *       };
 *     },
 *   }],
 *   policy: { kind: 'strict' },
 *   failureMode: 'fail-closed',
 * };
 *
 * // Register with resource server
 * const extension = createTrustProviderExtension(config);
 * server.registerExtension(extension);
 *
 * // Include in PaymentRequired response
 * const paymentRequired = {
 *   extensions: {
 *     [TRUST_PROVIDER]: declareTrustProviderExtension(config),
 *   },
 * };
 * ```
 */

export type {
  TrustQuery,
  TrustEvaluation,
  TrustDecision,
  TrustProviderConfig,
  TrustProviderExtensionConfig,
  TrustProviderDeclaration,
  AggregationPolicy,
} from "./types";

export { TRUST_PROVIDER } from "./types";

export { aggregateStrict, aggregateQuorum, aggregate } from "./utils";

export {
  createTrustProviderExtension,
  declareTrustProviderExtension,
} from "./resourceServer";
