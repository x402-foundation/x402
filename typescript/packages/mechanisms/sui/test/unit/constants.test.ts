import { describe, it, expect } from "vitest";
import {
  SUI_MAINNET_CAIP2,
  SUI_TESTNET_CAIP2,
  SUI_DEVNET_CAIP2,
  SUI_ADDRESS_REGEX,
  USDC_MAINNET,
  USDC_TESTNET,
  USDC_DECIMALS,
  MIN_GASLESS_TRANSFER,
  GASLESS_ALLOWED_TARGETS,
  GASLESS_ALLOWED_NON_MOVECALL,
  getUsdcCoinType,
  normalizeMoveTarget,
} from "../../src/constants";

describe("Sui Constants", () => {
  describe("Network identifiers", () => {
    it("uses the merged-spec CAIP-2 forms", () => {
      expect(SUI_MAINNET_CAIP2).toBe("sui:mainnet");
      expect(SUI_TESTNET_CAIP2).toBe("sui:testnet");
      expect(SUI_DEVNET_CAIP2).toBe("sui:devnet");
    });
  });

  describe("SUI_ADDRESS_REGEX", () => {
    it("matches a full-length 0x + 64 hex address", () => {
      expect(
        SUI_ADDRESS_REGEX.test(
          "0x0000000000000000000000000000000000000000000000000000000000000001",
        ),
      ).toBe(true);
    });

    it("rejects short-form, missing-prefix, and bad-char addresses", () => {
      expect(SUI_ADDRESS_REGEX.test("0x2")).toBe(false);
      expect(SUI_ADDRESS_REGEX.test("a".repeat(64))).toBe(false);
      expect(SUI_ADDRESS_REGEX.test("0x" + "g".repeat(64))).toBe(false);
      expect(SUI_ADDRESS_REGEX.test("0x" + "a".repeat(65))).toBe(false);
    });
  });

  describe("Default USDC", () => {
    it("pins Circle native USDC on each network with 6 decimals", () => {
      expect(USDC_MAINNET).toMatch(/::usdc::USDC$/);
      expect(USDC_TESTNET).toMatch(/::usdc::USDC$/);
      expect(USDC_DECIMALS).toBe(6);
    });
  });

  describe("MIN_GASLESS_TRANSFER", () => {
    it("is 0.01 USDC in atomic units, as a bigint", () => {
      expect(MIN_GASLESS_TRANSFER).toBe(10_000n);
      expect(typeof MIN_GASLESS_TRANSFER).toBe("bigint");
    });
  });

  describe("GASLESS_ALLOWED_TARGETS", () => {
    const f = "0x0000000000000000000000000000000000000000000000000000000000000002";

    it("contains EXACTLY the four gasless ops that exist on-chain", () => {
      // Verified via sui_getNormalizedMoveFunction on testnet AND mainnet.
      expect([...GASLESS_ALLOWED_TARGETS].sort()).toEqual(
        [
          `${f}::balance::send_funds`,
          `${f}::balance::redeem_funds`,
          `${f}::coin::send_funds`,
          `${f}::coin::into_balance`,
        ].sort(),
      );
    });

    it("does NOT contain the phantom ops (they do not exist on-chain)", () => {
      // `0x2::balance::withdrawal_split` and `0x2::balance::into_balance` are MISSING on
      // testnet and mainnet (sui_getNormalizedMoveFunction → no function found).
      expect(GASLESS_ALLOWED_TARGETS.has(`${f}::balance::withdrawal_split`)).toBe(false);
      expect(GASLESS_ALLOWED_TARGETS.has(`${f}::balance::into_balance`)).toBe(false);
    });

    it("does not contain a non-allowlisted op", () => {
      expect(GASLESS_ALLOWED_TARGETS.has(`${f}::transfer::public_transfer`)).toBe(false);
    });
  });

  describe("GASLESS_ALLOWED_NON_MOVECALL", () => {
    it("tolerates only the coin-plumbing commands", () => {
      // A coin-object payer's PTB carries SplitCoins/MergeCoins; TransferObjects (the
      // object-leak vector) and every other command stay out.
      expect([...GASLESS_ALLOWED_NON_MOVECALL].sort()).toEqual(["MergeCoins", "SplitCoins"]);
      expect(GASLESS_ALLOWED_NON_MOVECALL.has("TransferObjects")).toBe(false);
    });
  });

  describe("getUsdcCoinType", () => {
    it("returns the network USDC for mainnet/testnet", () => {
      expect(getUsdcCoinType(SUI_MAINNET_CAIP2)).toBe(USDC_MAINNET);
      expect(getUsdcCoinType(SUI_TESTNET_CAIP2)).toBe(USDC_TESTNET);
    });

    it("throws on devnet (no default asset) and unsupported networks", () => {
      expect(() => getUsdcCoinType(SUI_DEVNET_CAIP2)).toThrow("No default USDC");
      expect(() => getUsdcCoinType("eip155:1")).toThrow("No default USDC");
    });
  });

  describe("normalizeMoveTarget", () => {
    it("pads the package address of the short 0x2 form", () => {
      expect(normalizeMoveTarget("0x2", "balance", "send_funds")).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000002::balance::send_funds",
      );
    });
  });
});
