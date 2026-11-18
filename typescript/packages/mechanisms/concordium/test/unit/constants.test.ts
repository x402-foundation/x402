import { describe, it, expect } from "vitest";
import {
  CONCORDIUM_MAINNET_CAIP2,
  CONCORDIUM_TESTNET_CAIP2,
  CONCORDIUM_MAINNET_GRPC,
  CONCORDIUM_TESTNET_GRPC,
  CONCORDIUM_ADDRESS_REGEX,
  getConcordiumGrpcUrl,
  getExplorerTxUrl,
  getExplorerAccountUrl,
  parseGrpcUrl,
} from "../../src/constants";

describe("Concordium Constants", () => {
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
