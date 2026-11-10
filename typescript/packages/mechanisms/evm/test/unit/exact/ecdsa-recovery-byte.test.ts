import { describe, it, expect } from "vitest";
import { splitEip2612Signature } from "../../../src/shared/permit2";

const R = "11".repeat(32);
const S = "22".repeat(32);

// Some signers (e.g. KMS/HSM backends) return the recovery byte as the raw y-parity (0/1).
// ecrecover-based permit() implementations only accept 27/28, so it must be normalized.
const cases = [
  ["00", 27],
  ["01", 28],
  ["1b", 27],
  ["1c", 28],
] as const;

describe("splitEip2612Signature recovery byte", () => {
  it.each(cases)("returns v=%s as %i", (vByte, expected) => {
    expect(splitEip2612Signature(`0x${R}${S}${vByte}`)).toEqual({
      v: expected,
      r: `0x${R}`,
      s: `0x${S}`,
    });
  });

  it("still rejects signatures that are not 65 bytes", () => {
    expect(() => splitEip2612Signature(`0x${R}${S}`)).toThrow(/65 bytes/);
  });
});
