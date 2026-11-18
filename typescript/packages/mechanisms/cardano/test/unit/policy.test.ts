import { describe, expect, it } from "vitest";

import {
  confirmationsSatisfy,
  normalizeConfirmationPolicy,
  resolveCardanoPolicies,
} from "../../src/policy";

describe("confirmation policy", () => {
  it("normalizes an absent policy to one confirmation", () => {
    expect(normalizeConfirmationPolicy(undefined)).toEqual({ l1Confirmations: 1 });
  });

  it("accepts the full -1..20 range", () => {
    for (const value of [-1, 0, 1, 20]) {
      expect(normalizeConfirmationPolicy({ l1Confirmations: value })).toEqual({
        l1Confirmations: value,
      });
    }
  });

  it("rejects out-of-range, non-integer and non-numeric values", () => {
    expect(normalizeConfirmationPolicy({ l1Confirmations: -2 })).toBeNull();
    expect(normalizeConfirmationPolicy({ l1Confirmations: 21 })).toBeNull();
    expect(normalizeConfirmationPolicy({ l1Confirmations: 1.5 })).toBeNull();
    expect(normalizeConfirmationPolicy({ l1Confirmations: "1" })).toBeNull();
  });

  it("treats confirmationPolicy as a closed object", () => {
    expect(normalizeConfirmationPolicy({ l1Confirmations: 1, extra: true })).toBeNull();
    expect(normalizeConfirmationPolicy({})).toBeNull();
    expect(normalizeConfirmationPolicy([])).toBeNull();
  });

  it("treats greater evidence as satisfying a lower threshold", () => {
    // Canonical inclusion (0) satisfies a mempool threshold (-1).
    expect(confirmationsSatisfy(0, -1)).toBe(true);
    expect(confirmationsSatisfy(5, 1)).toBe(true);
    expect(confirmationsSatisfy(1, 1)).toBe(true);
    // Mempool-only evidence does not satisfy canonical inclusion.
    expect(confirmationsSatisfy(-1, 0)).toBe(false);
    expect(confirmationsSatisfy(0, 1)).toBe(false);
  });
});

describe("resolveCardanoPolicies", () => {
  it("applies the default for an absent extra", () => {
    expect(resolveCardanoPolicies(undefined)).toEqual({
      confirmationPolicy: { l1Confirmations: 1 },
    });
  });

  it("reads a declared policy", () => {
    expect(resolveCardanoPolicies({ confirmationPolicy: { l1Confirmations: 0 } })).toEqual({
      confirmationPolicy: { l1Confirmations: 0 },
    });
  });

  it("ignores unrelated extra keys and returns null for a malformed policy", () => {
    expect(resolveCardanoPolicies({ assetTransferMethod: "script" })).toEqual({
      confirmationPolicy: { l1Confirmations: 1 },
    });
    expect(resolveCardanoPolicies({ confirmationPolicy: { l1Confirmations: 99 } })).toBeNull();
  });
});
