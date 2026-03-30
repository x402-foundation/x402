import { Horizon, rpc } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2 } from "../../src";
import {
  convertToTokenAmount,
  DEFAULT_ESTIMATED_LEDGER_SECONDS,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  getUsdcAddress,
  isStellarNetwork,
  RpcConfig,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "../../src/utils";

// Mock the Stellar SDK
vi.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: vi.fn(),
  },
  rpc: {
    Server: vi.fn(),
  },
}));

describe("Stellar RPC Helper Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validateStellarDestinationAddress", () => {
    it("should return true for valid addresses", () => {
      expect(
        validateStellarDestinationAddress(
          "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        ),
      ).toBe(true);
    });

    it("should return false for invalid addresses", () => {
      expect(validateStellarDestinationAddress("")).toBe(false);
      expect(validateStellarDestinationAddress("invalid")).toBe(false);
    });
  });

  describe("validateStellarAssetAddress", () => {
    it("should return true for valid C-accounts", () => {
      expect(
        validateStellarAssetAddress("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"),
      ).toBe(true);
    });

    it("should return false for invalid addresses", () => {
      expect(validateStellarAssetAddress("")).toBe(false);
      expect(validateStellarAssetAddress("invalid")).toBe(false);
    });
  });

  describe("isStellarNetwork", () => {
    it("should return true for Stellar pubnet", () => {
      expect(isStellarNetwork(STELLAR_PUBNET_CAIP2)).toBe(true);
    });

    it("should return true for Stellar testnet", () => {
      expect(isStellarNetwork(STELLAR_TESTNET_CAIP2)).toBe(true);
    });

    it("should return false for invalid networks", () => {
      expect(isStellarNetwork("invalid-network" as any)).toBe(false);
      expect(isStellarNetwork("" as any)).toBe(false);
    });

    it("should return false for non-Stellar CAIP-2 networks", () => {
      expect(isStellarNetwork("eip155:1" as any)).toBe(false);
      expect(isStellarNetwork("eip155:8453" as any)).toBe(false);
      expect(isStellarNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as any)).toBe(false);
    });
  });

  describe("getNetworkPassphrase", () => {
    it("should return the correct passphrase for stellar (mainnet)", () => {
      const result = getNetworkPassphrase(STELLAR_PUBNET_CAIP2);
      expect(result).toBe("Public Global Stellar Network ; September 2015");
    });

    it("should return the correct passphrase for stellar testnet", () => {
      const result = getNetworkPassphrase(STELLAR_TESTNET_CAIP2);
      expect(result).toBe("Test SDF Network ; September 2015");
    });

    it("should throw error for unknown network", () => {
      expect(() => getNetworkPassphrase("invalid-network" as any)).toThrow(
        "Unknown Stellar network: invalid-network",
      );
    });
  });

  describe("getRpcUrl", () => {
    describe(STELLAR_TESTNET_CAIP2, () => {
      it("should return default testnet URL when no config provided", () => {
        const result = getRpcUrl(STELLAR_TESTNET_CAIP2);
        expect(result).toBe("https://soroban-testnet.stellar.org");
      });

      it("should return custom URL when provided in rpcConfig", () => {
        const customUrl = "https://custom-stellar-testnet-rpc.example.com";
        const rpcConfig: RpcConfig = { url: customUrl };
        const result = getRpcUrl(STELLAR_TESTNET_CAIP2, rpcConfig);
        expect(result).toBe(customUrl);
      });
    });

    describe("stellar mainnet", () => {
      it("should throw error when no config provided for mainnet", () => {
        expect(() => getRpcUrl(STELLAR_PUBNET_CAIP2)).toThrow(
          "Stellar mainnet requires a non-empty rpcUrl. For a list of RPC providers, see https://developers.stellar.org/docs/data/apis/rpc/providers#publicly-accessible-apis",
        );
      });

      it("should throw error when rpcConfig provided without url for mainnet", () => {
        const rpcConfig: RpcConfig = {};
        expect(() => getRpcUrl(STELLAR_PUBNET_CAIP2, rpcConfig)).toThrow(
          "Stellar mainnet requires a non-empty rpcUrl. For a list of RPC providers, see https://developers.stellar.org/docs/data/apis/rpc/providers#publicly-accessible-apis",
        );
      });

      it("should return custom URL when provided in rpcConfig for mainnet", () => {
        const customUrl = "https://custom-stellar-mainnet-rpc.example.com";
        const config: RpcConfig = { url: customUrl };
        const result = getRpcUrl(STELLAR_PUBNET_CAIP2, config);
        expect(result).toBe(customUrl);
      });
    });

    describe("invalid networks", () => {
      it("should throw error for unknown network", () => {
        expect(() => getRpcUrl("invalid-network" as any)).toThrow(
          "Unknown Stellar network: invalid-network",
        );
      });
    });
  });

  describe("getRpcClient", () => {
    describe(STELLAR_TESTNET_CAIP2, () => {
      it("should create RPC client with default testnet URL when no config provided", () => {
        const mockServer = { mock: "testnet-server" };
        vi.mocked(rpc.Server).mockReturnValue(mockServer as any);

        const result = getRpcClient(STELLAR_TESTNET_CAIP2);

        expect(rpc.Server).toHaveBeenCalledWith("https://soroban-testnet.stellar.org", {
          allowHttp: true,
        });
        expect(result).toBe(mockServer);
      });

      it("should create RPC client with custom URL when provided in rpcConfig", () => {
        const customUrl = "https://custom-testnet-rpc.com";
        const mockServer = { mock: "testnet-server-custom" };
        vi.mocked(rpc.Server).mockReturnValue(mockServer as any);

        const rpcConfig: RpcConfig = { url: customUrl };
        const result = getRpcClient(STELLAR_TESTNET_CAIP2, rpcConfig);

        expect(rpc.Server).toHaveBeenCalledWith(customUrl, {
          allowHttp: true,
        });
        expect(result).toBe(mockServer);
      });

      it("should allow HTTP for testnet", () => {
        const mockServer = { mock: "testnet-server" };
        vi.mocked(rpc.Server).mockReturnValue(mockServer as any);

        getRpcClient(STELLAR_TESTNET_CAIP2);

        expect(rpc.Server).toHaveBeenCalledWith(expect.any(String), {
          allowHttp: true,
        });
      });
    });

    describe("stellar mainnet", () => {
      it("should throw error when no config provided for mainnet", () => {
        expect(() => getRpcClient(STELLAR_PUBNET_CAIP2)).toThrow(
          "Stellar mainnet requires a non-empty rpcUrl. For a list of RPC providers, see https://developers.stellar.org/docs/data/apis/rpc/providers#publicly-accessible-apis",
        );
      });

      it("should create RPC client with custom URL for mainnet", () => {
        const customUrl = "https://custom-mainnet-rpc.com";
        const mockServer = { mock: "mainnet-server" };
        vi.mocked(rpc.Server).mockReturnValue(mockServer as any);

        const rpcConfig: RpcConfig = { url: customUrl };
        const result = getRpcClient(STELLAR_PUBNET_CAIP2, rpcConfig);

        expect(rpc.Server).toHaveBeenCalledWith(customUrl, {
          allowHttp: false,
        });
        expect(result).toBe(mockServer);
      });

      it("should not allow HTTP for mainnet", () => {
        const customUrl = "https://custom-mainnet-rpc.com";
        const mockServer = { mock: "mainnet-server" };
        vi.mocked(rpc.Server).mockReturnValue(mockServer as any);

        const rpcConfig: RpcConfig = { url: customUrl };
        getRpcClient(STELLAR_PUBNET_CAIP2, rpcConfig);
        expect(rpc.Server).toHaveBeenCalledWith(expect.any(String), {
          allowHttp: false,
        });
      });
    });

    describe("invalid networks", () => {
      it("should throw error for unknown network", () => {
        expect(() => getRpcClient("invalid-network" as any)).toThrow(
          "Unknown Stellar network: invalid-network",
        );
      });

      it("should throw error for non-Stellar network", () => {
        expect(() => getRpcClient("base" as any)).toThrow("Unknown Stellar network: base");
      });
    });
  });

  describe("getEstimatedLedgerCloseTimeSeconds", () => {
    function mockHorizonServer(records: Array<{ closed_at: string; sequence: number }>) {
      const mockCall = vi.fn().mockResolvedValue({ records });
      const mockOrder = vi.fn().mockReturnValue({ call: mockCall });
      const mockLimit = vi.fn().mockReturnValue({ order: mockOrder });
      const mockLedgers = vi.fn().mockReturnValue({ limit: mockLimit });
      vi.mocked(Horizon.Server).mockImplementation(() => ({ ledgers: mockLedgers }) as any);
      return { mockCall, mockOrder, mockLimit, mockLedgers };
    }

    it("should compute seconds per ledger from Horizon SDK ledgers response", async () => {
      const baseTs = 1734032457;
      const records = [105, 104, 103, 102, 101, 100].map((seq, i) => ({
        sequence: seq,
        closed_at: new Date((baseTs + (5 - i) * 3) * 1000).toISOString(),
      }));
      const { mockLedgers, mockLimit, mockOrder } = mockHorizonServer(records);

      const result = await getEstimatedLedgerCloseTimeSeconds(STELLAR_TESTNET_CAIP2);

      expect(result).toBe(3);
      expect(Horizon.Server).toHaveBeenCalledWith("https://horizon-testnet.stellar.org");
      expect(mockLedgers).toHaveBeenCalled();
      expect(mockLimit).toHaveBeenCalledWith(20);
      expect(mockOrder).toHaveBeenCalledWith("desc");
    });

    it("should return DEFAULT_ESTIMATED_LEDGER_SECONDS when SDK call throws", async () => {
      const mockCall = vi.fn().mockRejectedValue(new Error("Network error"));
      const mockOrder = vi.fn().mockReturnValue({ call: mockCall });
      const mockLimit = vi.fn().mockReturnValue({ order: mockOrder });
      const mockLedgers = vi.fn().mockReturnValue({ limit: mockLimit });
      vi.mocked(Horizon.Server).mockImplementation(() => ({ ledgers: mockLedgers }) as any);

      const result = await getEstimatedLedgerCloseTimeSeconds(STELLAR_TESTNET_CAIP2);

      expect(result).toBe(DEFAULT_ESTIMATED_LEDGER_SECONDS);
    });

    it("should return DEFAULT_ESTIMATED_LEDGER_SECONDS when fewer than 2 records", async () => {
      mockHorizonServer([{ sequence: 100, closed_at: "2024-12-13T00:00:57Z" }]);

      const result = await getEstimatedLedgerCloseTimeSeconds(STELLAR_TESTNET_CAIP2);

      expect(result).toBe(DEFAULT_ESTIMATED_LEDGER_SECONDS);
    });

    it("should use pubnet Horizon URL for pubnet network", async () => {
      const baseTs = 1734032457;
      const records = [102, 101, 100].map((seq, i) => ({
        sequence: seq,
        closed_at: new Date((baseTs + (2 - i) * 6) * 1000).toISOString(),
      }));
      mockHorizonServer(records);

      const result = await getEstimatedLedgerCloseTimeSeconds(STELLAR_PUBNET_CAIP2);

      expect(result).toBe(6);
      expect(Horizon.Server).toHaveBeenCalledWith("https://horizon.stellar.org");
    });
  });

  describe("getUsdcAddress", () => {
    it("should return USDC address for mainnet", () => {
      const result = getUsdcAddress(STELLAR_PUBNET_CAIP2);
      expect(result).toBe("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
    });

    it("should return USDC address for testnet", () => {
      const result = getUsdcAddress(STELLAR_TESTNET_CAIP2);
      expect(result).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    });

    it("should throw error for unknown network", () => {
      expect(() => getUsdcAddress("invalid-network" as any)).toThrow(
        "No USDC address configured for network: invalid-network",
      );
    });
  });

  describe("convertToTokenAmount", () => {
    describe("with default 7 decimals", () => {
      it("should convert decimal amount correctly", () => {
        expect(convertToTokenAmount("0.1")).toBe("1000000");
        expect(convertToTokenAmount("1.5")).toBe("15000000");
        expect(convertToTokenAmount("0.1234567")).toBe("1234567");
      });

      it("should convert integer amount correctly", () => {
        expect(convertToTokenAmount("1")).toBe("10000000");
        expect(convertToTokenAmount("10")).toBe("100000000");
        expect(convertToTokenAmount("0")).toBe("0");
      });

      it("should handle amounts with trailing zeros", () => {
        expect(convertToTokenAmount("1.0")).toBe("10000000");
        expect(convertToTokenAmount("0.1000000")).toBe("1000000");
      });

      it("should handle very small amounts", () => {
        expect(convertToTokenAmount("0.0000001")).toBe("1");
        expect(convertToTokenAmount("0.00000001")).toBe("0");
      });

      it("should truncate excess decimal places", () => {
        expect(convertToTokenAmount("1.12345678")).toBe("11234567");
      });
    });

    describe("with custom decimals", () => {
      it("should convert with 6 decimals", () => {
        expect(convertToTokenAmount("1.5", 6)).toBe("1500000");
        expect(convertToTokenAmount("0.1", 6)).toBe("100000");
      });

      it("should convert with 18 decimals", () => {
        expect(convertToTokenAmount("1.0", 18)).toBe("1000000000000000000");
        expect(convertToTokenAmount("0.5", 18)).toBe("500000000000000000");
      });

      it("should convert with 0 decimals", () => {
        expect(convertToTokenAmount("1.5", 0)).toBe("1");
        expect(convertToTokenAmount("2.9", 0)).toBe("2");
      });
    });

    describe("special cases", () => {
      it("should handle negative numbers", () => {
        expect(convertToTokenAmount("-1.5")).toBe("-15000000");
      });

      it("should handle scientific notation input", () => {
        // Scientific notation should be correctly converted
        // 1e-7 = 0.0000001, which with 7 decimals = 1
        expect(convertToTokenAmount("1e-7")).toBe("1");
        expect(convertToTokenAmount("1e-6")).toBe("10");
        expect(convertToTokenAmount("1.5e-6")).toBe("15");
      });

      it("should handle very large numbers", () => {
        expect(convertToTokenAmount("999999999.9999999")).toBe("9999999999999999");
      });
    });

    describe("error cases", () => {
      it("should throw error for invalid amount", () => {
        expect(() => convertToTokenAmount("invalid")).toThrow("Invalid amount: invalid");
        expect(() => convertToTokenAmount("abc")).toThrow("Invalid amount: abc");
        expect(() => convertToTokenAmount("")).toThrow("Invalid amount: ");
      });

      it("should throw error for NaN", () => {
        expect(() => convertToTokenAmount("NaN")).toThrow("Invalid amount: NaN");
      });

      it("should throw error for invalid decimals", () => {
        expect(() => convertToTokenAmount("1.5", -1)).toThrow(
          "Decimals must be between 0 and 20, got -1",
        );
        expect(() => convertToTokenAmount("1.5", 21)).toThrow(
          "Decimals must be between 0 and 20, got 21",
        );
      });
    });
  });
});
