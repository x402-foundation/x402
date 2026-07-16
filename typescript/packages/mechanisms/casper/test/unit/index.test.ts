import { describe, expect, it } from "vitest";
import {
  CASPER_CAIP2_FAMILY,
  NETWORK_CASPER_TESTNET,
  bytesToHex,
  isValidCasperAddress,
} from "../../src";

describe("@x402/casper exports", () => {
  it("exports constants and utilities from root", () => {
    expect(CASPER_CAIP2_FAMILY).toBe("casper:*");
    expect(NETWORK_CASPER_TESTNET).toBe("casper:casper-test");
    expect(bytesToHex(new Uint8Array([0xab]))).toBe("ab");
    expect(isValidCasperAddress("00" + "a".repeat(64))).toBe(true);
  });
});
