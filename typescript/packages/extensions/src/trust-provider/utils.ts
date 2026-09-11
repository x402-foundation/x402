/**
 * Trust-Provider Extension — aggregation utilities
 */

import type { TrustEvaluation, TrustDecision } from "./types";

/** STRICT: all providers must PASS. Any FAIL => FAIL, any UNCERTAIN => UNCERTAIN. */
export function aggregateStrict(evals: TrustEvaluation[]): TrustDecision {
  if (evals.some((e) => e.decision === "FAIL")) return "FAIL";
  if (evals.some((e) => e.decision === "UNCERTAIN")) return "UNCERTAIN";
  return "PASS";
}

/** QUORUM: majority rules. Ties resolve to UNCERTAIN. */
export function aggregateQuorum(evals: TrustEvaluation[]): TrustDecision {
  const n = evals.length;
  const threshold = Math.ceil(n / 2);
  const fails = evals.filter((e) => e.decision === "FAIL").length;
  const passes = evals.filter((e) => e.decision === "PASS").length;
  if (fails >= threshold) return "FAIL";
  if (passes >= threshold && fails === 0) return "PASS";
  return "UNCERTAIN";
}

/** Resolve aggregation for a given policy. */
export function aggregate(
  evals: TrustEvaluation[],
  policy: { kind: "strict" } | { kind: "quorum" } | { kind: "custom"; combine: (e: TrustEvaluation[]) => TrustDecision },
): TrustDecision {
  switch (policy.kind) {
    case "strict":
      return aggregateStrict(evals);
    case "quorum":
      return aggregateQuorum(evals);
    case "custom":
      return policy.combine(evals);
  }
}
