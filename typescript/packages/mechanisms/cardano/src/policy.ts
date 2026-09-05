import {
  DEFAULT_L1_CONFIRMATIONS,
  MAX_L1_CONFIRMATIONS,
  MIN_L1_CONFIRMATIONS,
  SUBMISSION_POLICY_CLIENT,
  SUBMISSION_POLICY_EITHER,
  SUBMISSION_POLICY_SERVER,
} from "./constants";
import type {
  CardanoConfirmationPolicy,
  CardanoSubmissionMode,
  CardanoSubmissionPolicy,
} from "./types";

/**
 * The shared submission and confirmation policies, resolved from a
 * requirements `extra` block. Every assetTransferMethod carries these at the
 * top level of `extra`; they are bound by exact `accepted` matching and are
 * never part of the Masumi `termsDigest`.
 */
export interface ResolvedCardanoPolicies {
  submissionPolicy: CardanoSubmissionPolicy;
  confirmationPolicy: CardanoConfirmationPolicy;
}

/**
 * Reads the submission and confirmation policy out of a requirements `extra`
 * block, applying the spec defaults (`server`, one confirmation).
 *
 * Total: an unparseable policy yields `null` rather than throwing, so callers
 * can turn it into a rejection reason.
 *
 * @param extra - The requirements' `extra` block, if any.
 * @returns The resolved policies, or `null` when either field is malformed.
 */
export function resolveCardanoPolicies(
  extra: Record<string, unknown> | undefined,
): ResolvedCardanoPolicies | null {
  const submissionPolicy = normalizeSubmissionPolicy(extra?.submissionPolicy);
  if (submissionPolicy === null) return null;
  const confirmationPolicy = normalizeConfirmationPolicy(extra?.confirmationPolicy);
  if (confirmationPolicy === null) return null;
  return { submissionPolicy, confirmationPolicy };
}

/**
 * Normalizes `extra.submissionPolicy`. An absent value is `server`.
 *
 * @param value - The raw declared value.
 * @returns The policy, or `null` when the value is not one of the three literals.
 */
export function normalizeSubmissionPolicy(value: unknown): CardanoSubmissionPolicy | null {
  if (value === undefined) return SUBMISSION_POLICY_SERVER;
  if (
    value === SUBMISSION_POLICY_SERVER ||
    value === SUBMISSION_POLICY_CLIENT ||
    value === SUBMISSION_POLICY_EITHER
  ) {
    return value;
  }
  return null;
}

/**
 * Normalizes `extra.confirmationPolicy`, a closed object whose only member is
 * an integer `l1Confirmations` from `-1` through `20`. An absent policy is
 * `{ l1Confirmations: 1 }`.
 *
 * @param value - The raw declared value.
 * @returns The policy, or `null` when it is malformed or out of range.
 */
export function normalizeConfirmationPolicy(value: unknown): CardanoConfirmationPolicy | null {
  if (value === undefined) return { l1Confirmations: DEFAULT_L1_CONFIRMATIONS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "l1Confirmations") return null;
  const l1Confirmations = (value as CardanoConfirmationPolicy).l1Confirmations;
  if (
    typeof l1Confirmations !== "number" ||
    !Number.isInteger(l1Confirmations) ||
    l1Confirmations < MIN_L1_CONFIRMATIONS ||
    l1Confirmations > MAX_L1_CONFIRMATIONS
  ) {
    return null;
  }
  return { l1Confirmations };
}

/**
 * Normalizes `payload.submissionMode`. An absent value is `server`; `either` is
 * a policy and is never a valid payload mode.
 *
 * @param value - The raw payload value.
 * @returns The mode, or `null` when the value is neither literal.
 */
export function normalizeSubmissionMode(value: unknown): CardanoSubmissionMode | null {
  if (value === undefined) return SUBMISSION_POLICY_SERVER;
  if (value === SUBMISSION_POLICY_SERVER || value === SUBMISSION_POLICY_CLIENT) return value;
  return null;
}

/**
 * Whether a policy admits a normalized payload submission mode.
 *
 * @param policy - The declared requirements policy.
 * @param mode - The normalized payload mode.
 * @returns True when the mode is selectable under the policy.
 */
export function submissionModeAllowed(
  policy: CardanoSubmissionPolicy,
  mode: CardanoSubmissionMode,
): boolean {
  return policy === SUBMISSION_POLICY_EITHER || policy === mode;
}

/**
 * Whether observed L1 evidence meets a required threshold. `confirmations` is
 * the strongest verified evidence: `-1` for authenticated mempool acceptance,
 * `0` for canonical block inclusion, and `n` for `n` newer canonical blocks.
 * Greater evidence always satisfies a lower threshold.
 *
 * @param observed - The strongest verified evidence level.
 * @param required - The threshold from `confirmationPolicy.l1Confirmations`.
 * @returns True when the evidence suffices.
 */
export function confirmationsSatisfy(observed: number, required: number): boolean {
  return observed >= required;
}
