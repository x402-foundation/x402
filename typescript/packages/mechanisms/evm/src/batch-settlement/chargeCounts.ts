/**
 * @file Claim charge counts carried in ERC-8021 settlement metadata (`m`).
 *
 * `m = { "x402ChargeCounts": [c0, c1, ...] }` has one unsigned integer per claim row, across
 * all `claim` / `claimWithSignature` legs in call order. `ci` is the unattested delta for that
 * row, not a lifetime total.
 *
 * This only reuses the ERC-8021 / builder-code metadata format as a carrier. No builder code
 * is needed, and the metadata composes with `w` / `a` / `s` in the same suffix. The suffix
 * itself is built by `resolveDataSuffix` from the metadata returned here.
 */

/** Key of the charge-count array inside the ERC-8021 `m` field. */
export const CHARGE_COUNTS_METADATA_KEY = "x402ChargeCounts" as const;

/** Settlement metadata carrying one charge-count delta per claim row. */
export type ChargeCountsMetadata = {
  readonly [CHARGE_COUNTS_METADATA_KEY]?: unknown;
};

/**
 * Builds the `m` metadata for a claim transaction.
 *
 * @param counts - One unattested delta per claim row, in call order.
 * @returns Metadata for `resolveDataSuffix`, or `undefined` when there are no claim rows.
 */
export function chargeCountsMetadata(
  counts: readonly (number | bigint)[],
): { readonly x402ChargeCounts: readonly bigint[] } | undefined {
  if (counts.length === 0) {
    return undefined;
  }
  return { [CHARGE_COUNTS_METADATA_KEY]: counts.map(count => BigInt(count)) };
}

/**
 * Reads the charge counts from a parsed ERC-8021 `m` field.
 *
 * Accepts the values a CBOR parser returns (unsigned integers as `bigint`) and plain
 * non-negative safe integers.
 *
 * @param metadata - Parsed `m` field of the top-level suffix, if any.
 * @returns Counts in claim-row order, or `undefined` when absent or malformed.
 */
export function parseChargeCountsMetadata(
  metadata: ChargeCountsMetadata | undefined,
): bigint[] | undefined {
  const value = metadata?.[CHARGE_COUNTS_METADATA_KEY];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const counts: bigint[] = [];
  for (const entry of value) {
    if (typeof entry === "bigint" && entry >= 0n) {
      counts.push(entry);
    } else if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) {
      counts.push(BigInt(entry));
    } else {
      return undefined;
    }
  }
  return counts;
}
