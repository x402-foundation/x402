/**
 * Trust-Provider Extension — wire types
 *
 * Defines the trust query, evaluation, and configuration types
 * used by the onBeforeSettle hook to gate settlement on behavioral trust.
 */

export const TRUST_PROVIDER = "trust-provider" as const;

export type TrustDecision = "PASS" | "FAIL" | "UNCERTAIN";

export interface TrustQuery {
  schema: "x402-trust-query-v0.1";
  payer: {
    wallet?: string;
    agent_id?: string;
    session_id?: string;
  };
  resource: {
    url: string;
    method?: string;
    amount?: {
      value: string;
      currency: string;
      chain: string;
    };
  };
  context?: {
    category?: string;
    risk_band?: "low" | "medium" | "high";
  };
  requested_at: string;
}

export interface TrustEvaluation {
  schema: "x402-trust-evaluation-v0.1";
  provider: string;
  provider_url: string;
  decision: TrustDecision;
  score?: number;
  evidence_uri?: string;
  reason_code?: string;
  ttl_seconds?: number;
  evaluated_at: string;
}

export type AggregationPolicy =
  | { kind: "strict" }
  | { kind: "quorum" }
  | { kind: "custom"; combine: (evals: TrustEvaluation[]) => TrustDecision };

export interface TrustProviderConfig {
  name: string;
  evaluate: (query: TrustQuery) => Promise<TrustEvaluation>;
}

export interface TrustProviderExtensionConfig {
  providers: TrustProviderConfig[];
  policy: AggregationPolicy;
  failureMode: "fail-closed" | "fail-open";
  perProviderTimeoutMs?: number;
}

export interface TrustProviderDeclaration {
  info: {
    providers: string[];
    policy: string;
    failureMode: string;
  };
}
