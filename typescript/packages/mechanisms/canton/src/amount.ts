/**
 * Canton Coin amount-unit conversion (x402-ENVELOPE upstream convention).
 *
 * The x402 v2 wire field `PaymentRequirements.maxAmountRequired` (this scheme's
 * `amount`) travels in ATOMIC UNITS as an integer string, while the on-ledger
 * Daml `Decimal` the Token Standard / TransferCommand uses is a fixed-scale
 * decimal string. The conversion boundary is fixed across CIP-56 by the Daml
 * `Decimal` scale: **1 CC = 10^10 atomic units** (10 decimal places).
 *
 * The wire `amount` under scheme `"exact"` (the only scheme) is ATOMIC integer
 * units; the on-ledger Daml Decimal is derived EXACTLY at the boundary via these
 * helpers. The maths is pure BigInt/string so the round-trip never drifts by
 * 10^10 (the off-by-scale footgun) and never goes through float.
 *
 * Mirrors `packages/pay-proxy/src/spend-budget-store.ts`'s `toAtomic` (the same
 * "compare as BigInt atomic, never Number()" guardrail) but adds the inverse and
 * a strict integer-atomic parser, and lives in core so client + facilitator
 * share one implementation.
 */

/** Daml Decimal scale for Canton Coin / Amulet — 10 fractional digits. */
export const CC_ATOMIC_SCALE = 10;

const SCALE_FACTOR = 10n ** BigInt(CC_ATOMIC_SCALE);

/**
 * Convert integer atomic units (decimal string, e.g. `"1"`, `"10000000000"`) to
 * a fixed-scale Daml Decimal CC string with exactly `CC_ATOMIC_SCALE` fractional
 * digits (e.g. `"0.0000000001"`, `"1.0000000000"`).
 *
 * Fail-CLOSED: throws on a non-integer / non-numeric / negative input. The
 * output is the canonical fixed-scale form the Token Standard ledger uses.
 *
 * @param atomic
 */
export function atomicToDecimalCC(atomic: string): string {
  if (typeof atomic !== "string" || !/^\d+$/.test(atomic.trim())) {
    throw new Error(`invalid CC atomic amount: ${JSON.stringify(atomic)}`);
  }
  const v = BigInt(atomic.trim());
  const whole = v / SCALE_FACTOR;
  const frac = v % SCALE_FACTOR;
  const fracStr = frac.toString().padStart(CC_ATOMIC_SCALE, "0");
  return `${whole.toString()}.${fracStr}`;
}

/* ------------------------------------------------------------------------- *
 * Wire amount boundary (x402-ENVELOPE atomic units).
 *
 * The amount on the x402 WIRE (PaymentRequirements.amount / the accepted.amount
 * in a PaymentPayload) under scheme "exact" (the only scheme) is ATOMIC integer
 * units (1 CC = 10^10), e.g. "100000000" = 0.01 CC. The on-ledger Daml Decimal
 * is derived EXACTLY via the BigInt converters above.
 *
 * The on-ledger Daml `transferLeg.amount` / `Holding.amount` is ALWAYS a
 * fixed-scale Decimal. These functions are the SINGLE place the wire->ledger
 * unit decision is made, so every comparison site (facilitator verify arms,
 * selectServerRequirements, client builder, verify-before-sign) converts
 * identically — the off-by-10^10 firewall.
 * ------------------------------------------------------------------------- */

/** True iff this x402 scheme string carries the amount in ATOMIC integer units
 *  on the wire. The only scheme is "exact", which is atomic; any other string is
 *
 * @param scheme
 *  - not recognized (and the validated path never reaches here with one). */
export function schemeIsAtomic(scheme: string): boolean {
  return scheme === "exact";
}

/**
 * Convert an x402 WIRE amount to the on-ledger Daml **Decimal** it denotes.
 * Under scheme "exact" (atomic) this is `atomicToDecimalCC`; any unrecognized
 * scheme falls through to passthrough (defensive — the validated path only ever
 * passes "exact"). Fail-CLOSED via the underlying converter (a non-integer
 * atomic value throws rather than silently mis-comparing). Use this at EVERY
 * site that compares a wire amount against an on-ledger Decimal.
 *
 * @param scheme
 * @param wireAmount
 */
export function wireAmountToLedgerDecimal(scheme: string, wireAmount: string): string {
  return schemeIsAtomic(scheme) ? atomicToDecimalCC(wireAmount) : wireAmount;
}
