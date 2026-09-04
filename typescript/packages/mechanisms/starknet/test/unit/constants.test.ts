import { describe, it, expect } from "vitest";
import {
  STARKNET_MAINNET_CAIP2,
  STARKNET_SEPOLIA_CAIP2,
  STARKNET_ADDRESS_REGEX,
  CHAIN_IDS,
  DEFAULT_RPC_URLS,
  USDC_MAINNET,
  USDC_SEPOLIA,
  ANY_CALLER,
  VALID_SIGNATURE_MAGIC,
  STARKNET_ERROR_REASONS,
  getStarknetChainId,
  getStarknetRpcUrl,
} from "../../src/constants";

describe("Starknet Constants", () => {
  describe("Network identifiers", () => {
    it("should have correct CAIP-2 format for mainnet", () => {
      expect(STARKNET_MAINNET_CAIP2).toBe("starknet:SN_MAIN");
    });

    it("should have correct CAIP-2 format for sepolia", () => {
      expect(STARKNET_SEPOLIA_CAIP2).toBe("starknet:SN_SEPOLIA");
    });
  });

  describe("STARKNET_ADDRESS_REGEX", () => {
    it("should match a full-length felt address", () => {
      expect(STARKNET_ADDRESS_REGEX.test("0x" + "a".repeat(64))).toBe(true);
    });

    it("should match short (unpadded) felt addresses", () => {
      expect(STARKNET_ADDRESS_REGEX.test("0x1")).toBe(true);
      expect(STARKNET_ADDRESS_REGEX.test("0x123")).toBe(true);
    });

    it("should match addresses with mixed-case hex", () => {
      expect(STARKNET_ADDRESS_REGEX.test("0xABCdef1234567890")).toBe(true);
    });

    it("should reject addresses without the 0x prefix", () => {
      expect(STARKNET_ADDRESS_REGEX.test("123abc")).toBe(false);
    });

    it("should reject addresses longer than 64 hex digits", () => {
      expect(STARKNET_ADDRESS_REGEX.test("0x" + "a".repeat(65))).toBe(false);
    });

    it("should reject addresses with invalid characters", () => {
      expect(STARKNET_ADDRESS_REGEX.test("0xGGGG")).toBe(false);
    });

    it("should reject a bare 0x with no digits", () => {
      expect(STARKNET_ADDRESS_REGEX.test("0x")).toBe(false);
    });
  });

  describe("CHAIN_IDS", () => {
    it("should encode SN_MAIN as its short-string felt", () => {
      expect(CHAIN_IDS[STARKNET_MAINNET_CAIP2]).toBe("0x534e5f4d41494e");
    });

    it("should encode SN_SEPOLIA as its short-string felt", () => {
      expect(CHAIN_IDS[STARKNET_SEPOLIA_CAIP2]).toBe("0x534e5f5345504f4c4941");
    });
  });

  describe("getStarknetChainId", () => {
    it("should return the mainnet chain id felt", () => {
      expect(getStarknetChainId(STARKNET_MAINNET_CAIP2)).toBe("0x534e5f4d41494e");
    });

    it("should return the sepolia chain id felt", () => {
      expect(getStarknetChainId(STARKNET_SEPOLIA_CAIP2)).toBe("0x534e5f5345504f4c4941");
    });

    it("should throw for unsupported networks", () => {
      expect(() => getStarknetChainId("starknet:SN_GOERLI")).toThrow(
        "Unsupported Starknet network",
      );
      expect(() => getStarknetChainId("ethereum:1")).toThrow("Unsupported Starknet network");
      expect(() => getStarknetChainId("invalid")).toThrow("Unsupported Starknet network");
    });
  });

  describe("getStarknetRpcUrl", () => {
    it("should return the default mainnet RPC URL", () => {
      const url = getStarknetRpcUrl(STARKNET_MAINNET_CAIP2);
      expect(url).toBe(DEFAULT_RPC_URLS[STARKNET_MAINNET_CAIP2]);
      expect(url.startsWith("https://")).toBe(true);
      expect(url).toContain("mainnet");
    });

    it("should return the default sepolia RPC URL", () => {
      const url = getStarknetRpcUrl(STARKNET_SEPOLIA_CAIP2);
      expect(url).toBe(DEFAULT_RPC_URLS[STARKNET_SEPOLIA_CAIP2]);
      expect(url.startsWith("https://")).toBe(true);
      expect(url).toContain("sepolia");
    });

    it("should return different URLs for different networks", () => {
      expect(getStarknetRpcUrl(STARKNET_MAINNET_CAIP2)).not.toBe(
        getStarknetRpcUrl(STARKNET_SEPOLIA_CAIP2),
      );
    });

    it("should throw for unsupported networks", () => {
      expect(() => getStarknetRpcUrl("starknet:SN_GOERLI")).toThrow("Unsupported Starknet network");
      expect(() => getStarknetRpcUrl("ethereum:1")).toThrow("Unsupported Starknet network");
      expect(() => getStarknetRpcUrl("invalid")).toThrow("Unsupported Starknet network");
    });
  });

  describe("USDC asset addresses", () => {
    it("should expose a well-formed mainnet USDC address", () => {
      expect(STARKNET_ADDRESS_REGEX.test(USDC_MAINNET)).toBe(true);
    });

    it("should expose a well-formed sepolia USDC address", () => {
      expect(STARKNET_ADDRESS_REGEX.test(USDC_SEPOLIA)).toBe(true);
    });

    it("should use distinct addresses per network", () => {
      expect(USDC_MAINNET).not.toBe(USDC_SEPOLIA);
    });
  });

  describe("SNIP-9 sentinels and magics", () => {
    it("ANY_CALLER is the felt encoding of the short string", () => {
      expect(ANY_CALLER).toBe("0x414e595f43414c4c4552");
    });

    it("VALID_SIGNATURE_MAGIC is the felt encoding of VALID", () => {
      expect(VALID_SIGNATURE_MAGIC).toBe("0x56414c4944");
    });
  });

  describe("STARKNET_ERROR_REASONS", () => {
    it("should expose bare enum reason tokens", () => {
      expect(STARKNET_ERROR_REASONS.INVALID_SIGNATURE).toBe(
        "invalid_exact_starknet_payload_signature",
      );
      expect(STARKNET_ERROR_REASONS.ASSET_MISMATCH).toBe(
        "invalid_exact_starknet_payload_asset_mismatch",
      );
      expect(STARKNET_ERROR_REASONS.RECIPIENT_MISMATCH).toBe(
        "invalid_exact_starknet_payload_recipient_mismatch",
      );
      expect(STARKNET_ERROR_REASONS.AMOUNT_MISMATCH).toBe(
        "invalid_exact_starknet_payload_amount_mismatch",
      );
      expect(STARKNET_ERROR_REASONS.INVALID_CALLER).toBe("invalid_exact_starknet_payload_caller");
      expect(STARKNET_ERROR_REASONS.ACCOUNT_NOT_DEPLOYED).toBe("account_not_deployed");
      expect(STARKNET_ERROR_REASONS.EXPIRED).toBe("outside_execution_expired");
      expect(STARKNET_ERROR_REASONS.WINDOW_EXCEEDS_MAX_TIMEOUT).toBe(
        "outside_execution_window_exceeds_max_timeout",
      );
      expect(STARKNET_ERROR_REASONS.NONCE_ALREADY_USED).toBe("nonce_already_used");
      expect(STARKNET_ERROR_REASONS.SIMULATION_FAILED).toBe("simulation_failed");
      expect(STARKNET_ERROR_REASONS.DUPLICATE_SETTLEMENT).toBe("duplicate_settlement");
      expect(STARKNET_ERROR_REASONS.SETTLEMENT_PENDING).toBe("settlement_pending");
    });

    it("should carry no human-readable detail appended to the token", () => {
      // Reasons are bare tokens; human context lives in invalidMessage / errorMessage.
      for (const token of Object.values(STARKNET_ERROR_REASONS)) {
        expect(token).not.toContain(" ");
      }
    });
  });
});
