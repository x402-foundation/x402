import { describe, it, expect } from "vitest";
import {
  CONCORDIUM_MAINNET_CAIP2,
  CONCORDIUM_TESTNET_CAIP2,
  CONCORDIUM_WILDCARD_CAIP2,
  CONCORDIUM_MAINNET_GRPC,
  CONCORDIUM_TESTNET_GRPC,
  CONCORDIUM_ADDRESS_REGEX,
  CCD_DECIMALS,
  CCD_ASSET_IDENTIFIER,
  MAX_EXPIRY_OFFSET_SECONDS,
  DEFAULT_FINALIZATION_TIMEOUT_MS,
  getConcordiumGrpcUrl,
  getExplorerTxUrl,
  getExplorerAccountUrl,
  parseGrpcUrl,
} from "../../src/constants";

describe("Concordium Constants", () => {
  describe("Network identifiers", () => {
    it("should have correct CAIP-2 format for mainnet", () => {
      expect(CONCORDIUM_MAINNET_CAIP2).toBe("ccd:9dd9ca4d19e9393877d2c44b70f89acb");
    });

    it("should have correct CAIP-2 format for testnet", () => {
      expect(CONCORDIUM_TESTNET_CAIP2).toBe("ccd:4221332d34e1694168c2a0c0b3fd0f27");
    });

    it("should have wildcard identifier", () => {
      expect(CONCORDIUM_WILDCARD_CAIP2).toBe("ccd:*");
    });

    it("all CAIP-2 identifiers should start with ccd:", () => {
      expect(CONCORDIUM_MAINNET_CAIP2).toMatch(/^ccd:/);
      expect(CONCORDIUM_TESTNET_CAIP2).toMatch(/^ccd:/);
      expect(CONCORDIUM_WILDCARD_CAIP2).toMatch(/^ccd:/);
    });
  });

  describe("CONCORDIUM_ADDRESS_REGEX", () => {
    it("should match valid base58check addresses", () => {
      expect(
        CONCORDIUM_ADDRESS_REGEX.test("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW"),
      ).toBe(true);
      expect(
        CONCORDIUM_ADDRESS_REGEX.test("3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN"),
      ).toBe(true);
    });

    it("should reject addresses with invalid characters (0, O, I, l)", () => {
      expect(
        CONCORDIUM_ADDRESS_REGEX.test("0FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW"),
      ).toBe(false);
      expect(
        CONCORDIUM_ADDRESS_REGEX.test("OFmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW"),
      ).toBe(false);
      expect(
        CONCORDIUM_ADDRESS_REGEX.test("IFmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW"),
      ).toBe(false);
      expect(
        CONCORDIUM_ADDRESS_REGEX.test("lFmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW"),
      ).toBe(false);
    });

    it("should reject addresses that are too short or too long", () => {
      expect(CONCORDIUM_ADDRESS_REGEX.test("4Fmi")).toBe(false);
      expect(CONCORDIUM_ADDRESS_REGEX.test("a".repeat(56))).toBe(false);
    });

    it("should reject empty strings", () => {
      expect(CONCORDIUM_ADDRESS_REGEX.test("")).toBe(false);
    });
  });

  describe("Asset defaults", () => {
    it("should have 6 decimals for CCD", () => {
      expect(CCD_DECIMALS).toBe(6);
    });

    it('should use "CCD" for native CCD asset identifier', () => {
      expect(CCD_ASSET_IDENTIFIER).toBe("CCD");
    });
  });

  describe("Sponsored transaction limits", () => {
    it("should have 600s max expiry offset", () => {
      expect(MAX_EXPIRY_OFFSET_SECONDS).toBe(600);
    });

    it("should have 60s default finalization timeout", () => {
      expect(DEFAULT_FINALIZATION_TIMEOUT_MS).toBe(60_000);
    });
  });

  describe("getConcordiumGrpcUrl", () => {
    it("should return mainnet gRPC URL", () => {
      expect(getConcordiumGrpcUrl(CONCORDIUM_MAINNET_CAIP2)).toBe(CONCORDIUM_MAINNET_GRPC);
    });

    it("should return testnet gRPC URL", () => {
      expect(getConcordiumGrpcUrl(CONCORDIUM_TESTNET_CAIP2)).toBe(CONCORDIUM_TESTNET_GRPC);
    });

    it("should throw for unsupported networks", () => {
      expect(() => getConcordiumGrpcUrl("ccd:unknown")).toThrow("Unsupported Concordium network");
      expect(() => getConcordiumGrpcUrl("eip155:1")).toThrow("Unsupported Concordium network");
      expect(() => getConcordiumGrpcUrl("ccd:*")).toThrow("Unsupported Concordium network");
    });
  });

  describe("getExplorerTxUrl", () => {
    it("should build mainnet transaction URL", () => {
      const url = getExplorerTxUrl(CONCORDIUM_MAINNET_CAIP2, "abc123");
      expect(url).toBe("https://ccdexplorer.io/mainnet/transaction/abc123");
    });

    it("should build testnet transaction URL", () => {
      const url = getExplorerTxUrl(CONCORDIUM_TESTNET_CAIP2, "def456");
      expect(url).toBe("https://ccdexplorer.io/testnet/transaction/def456");
    });

    it("should return undefined for unknown networks", () => {
      expect(getExplorerTxUrl("ccd:unknown", "abc")).toBeUndefined();
    });
  });

  describe("getExplorerAccountUrl", () => {
    it("should build account URL", () => {
      const url = getExplorerAccountUrl(CONCORDIUM_TESTNET_CAIP2, "4FmiTW2L4Rv");
      expect(url).toBe("https://ccdexplorer.io/testnet/account/4FmiTW2L4Rv");
    });

    it("should return undefined for unknown networks", () => {
      expect(getExplorerAccountUrl("ccd:unknown", "addr")).toBeUndefined();
    });
  });

  describe("parseGrpcUrl", () => {
    it("should parse host and port", () => {
      const [host, port] = parseGrpcUrl("grpc.testnet.concordium.com:20000");
      expect(host).toBe("grpc.testnet.concordium.com");
      expect(port).toBe(20000);
    });

    it("should default to 20000 when port is missing", () => {
      const [host, port] = parseGrpcUrl("grpc.example.com:");
      expect(host).toBe("grpc.example.com");
      expect(port).toBe(20000);
    });

    it("should default to 20000 for non-numeric port", () => {
      const [host, port] = parseGrpcUrl("grpc.example.com:abc");
      expect(host).toBe("grpc.example.com");
      expect(port).toBe(20000);
    });
  });
});
