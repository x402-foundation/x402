import type { PaymentRequirements } from "../types/payments";
import type { SettleResponse } from "../types/facilitator";
import { deepEqual } from "../utils";

/**
 * True when a string field is treated as unset and may be filled by `enrichPaymentRequiredResponse`.
 *
 * @param value - Candidate string from `PaymentRequirements` (e.g. `payTo`, `amount`, `asset`)
 * @returns Whether the field counts as vacant (empty or whitespace-only)
 */
export function isVacantStringField(value: string): boolean {
  return value.trim() === "";
}

/**
 * Deep snapshot of `accepts` entries before any `enrichPaymentRequiredResponse` runs.
 *
 * @param requirements - Payment requirement rows to clone
 * @returns Cloned requirements suitable as an immutable baseline for policy checks
 */
export function snapshotPaymentRequirementsList(
  requirements: PaymentRequirements[],
): PaymentRequirements[] {
  return requirements.map(req => ({
    ...req,
    extra: structuredClone(req.extra),
  }));
}

/**
 * After extension enrichment, each `accepts[i]` must still match the baseline except that
 * **`payTo`**, **`amount`**, and **`asset`** may change only when the baseline value is vacant
 * (whitespace-only string). **`scheme`**, **`network`**, and **`maxTimeoutSeconds`** are never
 * writable by extensions. **`extra`** may gain new keys; values for keys present in the baseline
 * must be unchanged (deep-equal).
 *
 * @param baseline - Snapshot taken before any enrich hooks for this response
 * @param current - Live `accepts` entries after an extension enrich step
 * @param extensionKey - Registered extension key (for error messages)
 * @returns Nothing; throws if the policy is violated
 */
export function assertAcceptsAllowlistedAfterExtensionEnrich(
  baseline: PaymentRequirements[],
  current: PaymentRequirements[],
  extensionKey: string,
): void {
  if (baseline.length !== current.length) {
    throw new Error(
      `[x402] extension "${extensionKey}" violated accepts mutation policy: accepts length changed (${baseline.length} → ${current.length})`,
    );
  }

  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i];
    const c = current[i];

    if (b.scheme !== c.scheme || b.network !== c.network) {
      throw new Error(
        `[x402] extension "${extensionKey}" violated accepts mutation policy: scheme/network are immutable (index ${i})`,
      );
    }
    if (b.maxTimeoutSeconds !== c.maxTimeoutSeconds) {
      throw new Error(
        `[x402] extension "${extensionKey}" violated accepts mutation policy: maxTimeoutSeconds is immutable (index ${i})`,
      );
    }

    for (const field of ["payTo", "amount", "asset"] as const) {
      const bv = b[field];
      const cv = c[field];
      if (!isVacantStringField(bv) && cv !== bv) {
        throw new Error(
          `[x402] extension "${extensionKey}" violated accepts mutation policy: "${field}" may only be set when the resource left it vacant (""); non-vacant values are immutable (index ${i})`,
        );
      }
    }

    for (const key of Object.keys(b.extra)) {
      if (!Object.prototype.hasOwnProperty.call(c.extra, key)) {
        throw new Error(
          `[x402] extension "${extensionKey}" violated accepts mutation policy: extra["${key}"] was removed (index ${i})`,
        );
      }
      if (!deepEqual(c.extra[key], b.extra[key])) {
        throw new Error(
          `[x402] extension "${extensionKey}" violated accepts mutation policy: extra["${key}"] may not be changed (index ${i})`,
        );
      }
    }
  }
}

/**
 * Immutable subset of {@link SettleResponse} compared across settlement extension enrich.
 */
export type SettleResponseCoreSnapshot = Pick<
  SettleResponse,
  "success" | "transaction" | "network" | "amount" | "payer" | "errorReason" | "errorMessage"
>;

/**
 * Captures facilitator-settled fields that extensions must not rewrite.
 *
 * @param result - Settlement response from the facilitator
 * @returns Plain snapshot of core fields for later comparison
 */
export function snapshotSettleResponseCore(result: SettleResponse): SettleResponseCoreSnapshot {
  return {
    success: result.success,
    transaction: result.transaction,
    network: result.network,
    amount: result.amount,
    payer: result.payer,
    errorReason: result.errorReason,
    errorMessage: result.errorMessage,
  };
}

/**
 * Ensures `enrichSettlementResponse` did not rewrite facilitator outcome fields; only
 * `extensions` may be populated via the merger (in addition to in-place adds on `extensions`).
 *
 * @param before - Snapshot taken before extension settlement enrich
 * @param after - Live settlement result after an extension enrich step
 * @param extensionKey - Registered extension key (for error messages)
 * @returns Nothing; throws if a core field changed
 */
export function assertSettleResponseCoreUnchanged(
  before: SettleResponseCoreSnapshot,
  after: SettleResponse,
  extensionKey: string,
): void {
  const keys: (keyof SettleResponseCoreSnapshot)[] = [
    "success",
    "transaction",
    "network",
    "amount",
    "payer",
    "errorReason",
    "errorMessage",
  ];
  for (const k of keys) {
    if (!deepEqual(after[k], before[k])) {
      throw new Error(
        `[x402] extension "${extensionKey}" violated settlement mutation policy: field "${String(k)}" is immutable after facilitator settle`,
      );
    }
  }
}
