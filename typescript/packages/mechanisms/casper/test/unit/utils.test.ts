import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  chainNameFromNetwork,
  getNetworkConfig,
  hexToBytes,
  isCanonicalSecp256k1Signature,
  isValidCasperAddress,
  isValidContractPackageHash,
} from "../../src/utils";

describe("Casper utils", () => {
  it("validates Casper address and contract package hash formats", () => {
    expect(isValidCasperAddress("00" + "a".repeat(64))).toBe(true);
    expect(isValidCasperAddress("01" + "a".repeat(64))).toBe(true);
    expect(isValidCasperAddress("02" + "a".repeat(64))).toBe(false);
    expect(isValidCasperAddress("00" + "a".repeat(63))).toBe(false);
    expect(isValidContractPackageHash("a".repeat(64))).toBe(true);
    expect(isValidContractPackageHash("0x" + "a".repeat(64))).toBe(false);
  });

  it("round-trips hex bytes", () => {
    const bytes = hexToBytes("0x000102ff");
    expect(Array.from(bytes)).toEqual([0, 1, 2, 255]);
    expect(bytesToHex(bytes)).toBe("000102ff");
  });

  it("rejects odd-length hex strings", () => {
    expect(() => hexToBytes("abc")).toThrow("even number of characters");
  });

  it("extracts chain names from CAIP-2 network identifiers", () => {
    expect(chainNameFromNetwork("casper:casper-test")).toBe("casper-test");
    expect(chainNameFromNetwork("casper-test")).toBe("casper-test");
  });

  it("returns known network config and rejects unknown networks", () => {
    expect(getNetworkConfig("casper:casper-test")).toMatchObject({
      chainName: "casper-test",
    });
    expect(() => getNetworkConfig("casper:unknown")).toThrow("unsupported Casper network");
  });

  it("enforces canonical low-s secp256k1 signatures", () => {
    const lowS = new Uint8Array(65);
    lowS[0] = 0x02;
    lowS[64] = 1;
    expect(isCanonicalSecp256k1Signature(lowS)).toBe(true);

    const highS = new Uint8Array(65).fill(0xff);
    highS[0] = 0x02;
    expect(isCanonicalSecp256k1Signature(highS)).toBe(false);

    const ed25519 = new Uint8Array(65).fill(0xff);
    ed25519[0] = 0x01;
    expect(isCanonicalSecp256k1Signature(ed25519)).toBe(true);
  });
});
