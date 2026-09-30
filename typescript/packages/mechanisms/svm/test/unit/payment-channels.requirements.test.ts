import { describe, expect, it } from "vitest";

import {
  SOLANA_MAINNET_CAIP2,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import {
  parseTokenProgramHint,
  requireTokenProgramHint,
  resolveTokenProgram,
  resolveUptoSvmMemo,
} from "../../src/payment-channels/requirements";

describe("payment-channels requirements", () => {
  describe("parseTokenProgramHint", () => {
    it("treats absent, null, and empty hints as unset", () => {
      expect(parseTokenProgramHint(undefined)).toBeUndefined();
      expect(parseTokenProgramHint({})).toBeUndefined();
      expect(parseTokenProgramHint({ tokenProgram: null })).toBeUndefined();
      expect(parseTokenProgramHint({ tokenProgram: "" })).toBeUndefined();
    });

    it("returns a supported SPL token program when hinted", () => {
      expect(parseTokenProgramHint({ tokenProgram: TOKEN_PROGRAM_ADDRESS })).toBe(
        TOKEN_PROGRAM_ADDRESS,
      );
      expect(parseTokenProgramHint({ tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })).toBe(
        TOKEN_2022_PROGRAM_ADDRESS,
      );
    });
  });

  describe("resolveTokenProgram", () => {
    it("falls back to the stablecoin registry when the hint is unset", () => {
      expect(
        resolveTokenProgram({
          asset: USDC_MAINNET_ADDRESS,
          network: SOLANA_MAINNET_CAIP2,
          extra: {},
        } as never),
      ).toBe(TOKEN_PROGRAM_ADDRESS);
    });
  });

  describe("requireTokenProgramHint", () => {
    it("throws when the hint is missing or invalid", () => {
      expect(() => requireTokenProgramHint({}, "token program required")).toThrow(
        "token program required",
      );
      expect(() =>
        requireTokenProgramHint({ tokenProgram: "not-an-address" }, "token program required"),
      ).toThrow("token program required");
    });
  });

  describe("resolveUptoSvmMemo", () => {
    it("returns a non-empty string memo and treats other values as unset", () => {
      expect(resolveUptoSvmMemo({ memo: "hello" })).toBe("hello");
      expect(resolveUptoSvmMemo({ memo: "" })).toBeUndefined();
      expect(resolveUptoSvmMemo({ memo: 1 })).toBeUndefined();
    });
  });
});
