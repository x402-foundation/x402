import { describe, expect, it } from "vitest";
import { bytesToHex, isValidCasperAddress } from "../../src";

describe("@x402/casper exports", () => {
  it("exports utilities from root", () => {
    expect(bytesToHex(new Uint8Array([0xab]))).toBe("ab");
    expect(isValidCasperAddress("00" + "a".repeat(64))).toBe(true);
  });
});
