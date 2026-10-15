/**
 * Trust-Provider Extension — Resource Server hooks
 *
 * Implements onBeforeSettle to gate payment settlement on behavioral trust scores.
 * Queries configured trust providers in parallel, aggregates decisions, and
 * aborts settlement if trust evaluation fails.
 */

import type { ResourceServerExtension } from "@x402/core/types";
import type {
  TrustQuery,
  TrustEvaluation,
  TrustDecision,
  TrustProviderExtensionConfig,
  TrustProviderDeclaration,
} from "./types";
import { TRUST_PROVIDER } from "./types";
import { aggregate } from "./utils";

/**
 * Creates a trust-provider declaration for PaymentRequired.extensions.
 *
 * Resource servers call this to advertise that trust evaluation is performed
 * before settlement. Clients can inspect this to understand trust requirements.
 */
export function declareTrustProviderExtension(
  config: TrustProviderExtensionConfig,
): TrustProviderDeclaration {
  return {
    info: {
      providers: config.providers.map((p) => p.name),
      policy: config.policy.kind,
      failureMode: config.failureMode,
    },
  };
}

/**
 * Creates a ResourceServerExtension that gates settlement on trust evaluation.
 *
 * The onBeforeSettle hook:
 * 1. Constructs a TrustQuery from the settlement context
 * 2. Queries all configured providers in parallel (with timeout)
 * 3. Aggregates decisions per the configured policy
 * 4. Returns void (proceed) on PASS, abort on FAIL/UNCERTAIN
 *
 * The enrichSettlementResponse hook adds advisory trust headers to the response.
 */
export function createTrustProviderExtension(
  config: TrustProviderExtensionConfig,
): ResourceServerExtension {
  const timeout = config.perProviderTimeoutMs ?? 5000;

  // Store last evaluation results for enrichSettlementResponse
  let lastEvaluations: TrustEvaluation[] = [];
  let lastDecision: TrustDecision = "UNCERTAIN";

  return {
    key: TRUST_PROVIDER,

    hooks: {
      onBeforeSettle: async (_declaration, context) => {
        const query: TrustQuery = {
          schema: "x402-trust-query-v0.1",
          payer: {
            wallet: context.paymentPayload?.payload?.authorization?.from,
          },
          resource: {
            url: context.requirements?.resource?.url ?? "",
            method: context.requirements?.resource?.method,
            amount: context.requirements?.maxAmountRequired
              ? {
                  value: context.requirements.maxAmountRequired.amount,
                  currency: context.requirements.maxAmountRequired.asset?.symbol ?? "USDC",
                  chain: context.requirements.maxAmountRequired.asset?.network ?? "unknown",
                }
              : undefined,
          },
          requested_at: new Date().toISOString(),
        };

        const evaluations = await Promise.all(
          config.providers.map(async (provider) => {
            try {
              return await Promise.race([
                provider.evaluate(query),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("timeout")), timeout),
                ),
              ]);
            } catch {
              return {
                schema: "x402-trust-evaluation-v0.1" as const,
                provider: provider.name,
                provider_url: "error",
                decision: (config.failureMode === "fail-closed" ? "UNCERTAIN" : "PASS") as TrustDecision,
                reason_code: "provider_error",
                evaluated_at: new Date().toISOString(),
              };
            }
          }),
        );

        lastEvaluations = evaluations;
        const decision = aggregate(evaluations, config.policy);
        lastDecision = decision;

        if (decision === "FAIL") {
          return {
            abort: true,
            reason: "trust_evaluation_failed",
            message: `Trust gate blocked settlement: ${evaluations.map((e) => e.reason_code).join(", ")}`,
          };
        }

        if (decision === "UNCERTAIN" && config.failureMode === "fail-closed") {
          return {
            abort: true,
            reason: "trust_evaluation_uncertain",
            message: "Trust evaluation inconclusive under fail-closed policy",
          };
        }

        // PASS or UNCERTAIN+fail-open: proceed with settlement
      },
    },

    enrichSettlementResponse: async () => {
      if (lastEvaluations.length === 0) return undefined;

      const topEval = lastEvaluations[0];
      return {
        decision: lastDecision,
        score: topEval?.score,
        evidence_uri: topEval?.evidence_uri,
        provider: topEval?.provider,
      };
    },
  };
}
