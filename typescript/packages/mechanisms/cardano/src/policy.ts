import { DEFAULT_L1_CONFIRMATIONS, MAX_L1_CONFIRMATIONS, MIN_L1_CONFIRMATIONS } from "./constants";
import type { CardanoConfirmationPolicy } from "./types";

/**
 * The shared confirmation policy, resolved from a requirements `extra` block.
 * Every assetTransferMethod carries it at the top level of `extra`; it is bound
 * by exact `accepted` matching and is never part of the Masumi `termsDigest`.
 */
export interface ResolvedCardanoPolicies {
  confirmationPolicy: CardanoConfirmationPolicy;
}

/**
 * Reads the confirmation policy out of a requirements `extra` block, applying
 * the spec default (one confirmation).
 *
 * Total: an unparseable policy yields `null` rather than throwing, so callers
 * can turn it into a rejection reason.
 *
 * @param extra - The requirements' `extra` block, if any.
 * @returns The resolved policies, or `null` when the policy is malformed.
 */
export function resolveCardanoPolicies(
  extra: Record<string, unknown> | undefined,
): ResolvedCardanoPolicies | null {
  const confirmationPolicy = normalizeConfirmationPolicy(extra?.confirmationPolicy);
  if (confirmationPolicy === null) return null;
  return { confirmationPolicy };
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
