import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import { isCanonicalEcdsaSignature } from "../../../src/exact/facilitator/eip3009";

// secp256k1 n/2 (EIP-2 low-s upper bound) — the boundary value, which is canonical.
const N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// Build a 65-byte ECDSA signature (r || s || v) with a chosen s value. r and v are
// arbitrary here — isCanonicalEcdsaSignature only inspects s.
function sigWithS(s: bigint, v = "1b"): Hex {
  const r = "11".repeat(32);
  return `0x${r}${s.toString(16).padStart(64, "0")}${v}`;
}

describe("isCanonicalEcdsaSignature", () => {
  it("accepts a low-s signature (s < n/2)", () => {
    expect(isCanonicalEcdsaSignature(sigWithS(N_HALF - 1n))).toBe(true);
  });

  it("accepts the boundary s == n/2 (canonical per EIP-2)", () => {
    expect(isCanonicalEcdsaSignature(sigWithS(N_HALF))).toBe(true);
  });

  it("rejects a high-s signature (s > n/2, malleable)", () => {
    expect(isCanonicalEcdsaSignature(sigWithS(N_HALF + 1n))).toBe(false);
  });

  it("returns false for non-65-byte signatures (ERC-1271 / ERC-6492 wrappers are skipped)", () => {
    expect(isCanonicalEcdsaSignature("0x010203")).toBe(false);
  });
});
