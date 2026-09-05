import { describe, expect, it } from "vitest";

import {
  confirmationsSatisfy,
  normalizeConfirmationPolicy,
  normalizeSubmissionMode,
  normalizeSubmissionPolicy,
  resolveCardanoPolicies,
  submissionModeAllowed,
} from "../../src/policy";

describe("submission policy", () => {
  it("normalizes an absent policy to server", () => {
    expect(normalizeSubmissionPolicy(undefined)).toBe("server");
  });

  it("accepts the three literals and rejects anything else", () => {
    expect(normalizeSubmissionPolicy("server")).toBe("server");
    expect(normalizeSubmissionPolicy("client")).toBe("client");
    expect(normalizeSubmissionPolicy("either")).toBe("either");
    expect(normalizeSubmissionPolicy("both")).toBeNull();
    expect(normalizeSubmissionPolicy(null)).toBeNull();
  });

  it("normalizes an absent payload mode to server and rejects 'either'", () => {
    expect(normalizeSubmissionMode(undefined)).toBe("server");
    expect(normalizeSubmissionMode("client")).toBe("client");
    // `either` is a policy, never a payload mode.
    expect(normalizeSubmissionMode("either")).toBeNull();
  });

  it("matches the spec's policy/mode table", () => {
    const table: Array<
      [Parameters<typeof submissionModeAllowed>[0], "server" | "client", boolean]
    > = [
      ["server", "server", true],
      ["server", "client", false],
      ["client", "client", true],
      ["client", "server", false],
      ["either", "server", true],
      ["either", "client", true],
    ];
    for (const [policy, mode, expected] of table) {
      expect(submissionModeAllowed(policy, mode)).toBe(expected);
    }
  });
});

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
  it("applies both defaults for an absent extra", () => {
    expect(resolveCardanoPolicies(undefined)).toEqual({
      submissionPolicy: "server",
      confirmationPolicy: { l1Confirmations: 1 },
    });
  });

  it("reads declared policies", () => {
    expect(
      resolveCardanoPolicies({
        submissionPolicy: "either",
        confirmationPolicy: { l1Confirmations: 0 },
      }),
    ).toEqual({ submissionPolicy: "either", confirmationPolicy: { l1Confirmations: 0 } });
  });

  it("returns null when either policy is malformed", () => {
    expect(resolveCardanoPolicies({ submissionPolicy: "nobody" })).toBeNull();
    expect(resolveCardanoPolicies({ confirmationPolicy: { l1Confirmations: 99 } })).toBeNull();
  });
});
