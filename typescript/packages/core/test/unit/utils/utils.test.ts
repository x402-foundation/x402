import { describe, it, expect } from "vitest";
import {
  findByNetworkAndScheme,
  findSchemesByNetwork,
  deepEqual,
  safeBase64Encode,
  safeBase64Decode,
  numberToDecimalString,
  convertToTokenAmount,
} from "../../../src/utils";
import { Network } from "../../../src/types";

describe("Utils", () => {
  describe("findSchemesByNetwork", () => {
    it("should find schemes by exact network match", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("exact", "exactImpl");
      schemes.set("intent", "intentImpl");
      map.set("eip155:8453", schemes);

      const result = findSchemesByNetwork(map, "eip155:8453" as Network);

      expect(result).toBeDefined();
      expect(result?.get("exact")).toBe("exactImpl");
      expect(result?.get("intent")).toBe("intentImpl");
    });

    it("should return undefined for network not found", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("exact", "exactImpl");
      map.set("eip155:8453", schemes);

      const result = findSchemesByNetwork(map, "solana:mainnet" as Network);

      expect(result).toBeUndefined();
    });

    it("should match wildcard patterns - eip155:*", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("exact", "evmImpl");
      map.set("eip155:*", schemes);

      const result = findSchemesByNetwork(map, "eip155:8453" as Network);

      expect(result).toBeDefined();
      expect(result?.get("exact")).toBe("evmImpl");
    });

    it("should match wildcard patterns - solana:*", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("exact", "svmImpl");
      map.set("solana:*", schemes);

      const result = findSchemesByNetwork(
        map,
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as Network,
      );

      expect(result).toBeDefined();
      expect(result?.get("exact")).toBe("svmImpl");
    });

    it("should match universal wildcard *", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("cash", "cashImpl");
      map.set("*", schemes);

      const result1 = findSchemesByNetwork(map, "eip155:8453" as Network);
      const result2 = findSchemesByNetwork(map, "solana:mainnet" as Network);
      const result3 = findSchemesByNetwork(map, "custom:anything" as Network);

      expect(result1?.get("cash")).toBe("cashImpl");
      expect(result2?.get("cash")).toBe("cashImpl");
      expect(result3?.get("cash")).toBe("cashImpl");
    });

    it("should prefer exact match over pattern match", () => {
      const map = new Map<string, Map<string, string>>();

      const exactSchemes = new Map<string, string>();
      exactSchemes.set("exact", "exactNetworkImpl");
      map.set("eip155:8453", exactSchemes);

      const patternSchemes = new Map<string, string>();
      patternSchemes.set("exact", "patternImpl");
      map.set("eip155:*", patternSchemes);

      const result = findSchemesByNetwork(map, "eip155:8453" as Network);

      expect(result?.get("exact")).toBe("exactNetworkImpl");
    });
  });

  describe("findByNetworkAndScheme", () => {
    it("should find implementation by network and scheme", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("exact", "exactImpl");
      schemes.set("intent", "intentImpl");
      map.set("eip155:8453", schemes);

      const result = findByNetworkAndScheme(map, "exact", "eip155:8453" as Network);

      expect(result).toBe("exactImpl");
    });

    it("should return undefined if network not found", () => {
      const map = new Map<string, Map<string, string>>();

      const result = findByNetworkAndScheme(map, "exact", "eip155:8453" as Network);

      expect(result).toBeUndefined();
    });

    it("should return undefined if scheme not found in network", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("intent", "intentImpl");
      map.set("eip155:8453", schemes);

      const result = findByNetworkAndScheme(map, "exact", "eip155:8453" as Network);

      expect(result).toBeUndefined();
    });

    it("should use pattern matching for network", () => {
      const map = new Map<string, Map<string, string>>();
      const schemes = new Map<string, string>();
      schemes.set("exact", "evmImpl");
      map.set("eip155:*", schemes);

      const result = findByNetworkAndScheme(map, "exact", "eip155:8453" as Network);

      expect(result).toBe("evmImpl");
    });
  });

  describe("deepEqual", () => {
    describe("primitives", () => {
      it("should match identical numbers", () => {
        expect(deepEqual(42, 42)).toBe(true);
        expect(deepEqual(42, 43)).toBe(false);
      });

      it("should match identical strings", () => {
        expect(deepEqual("hello", "hello")).toBe(true);
        expect(deepEqual("hello", "world")).toBe(false);
      });

      it("should match identical booleans", () => {
        expect(deepEqual(true, true)).toBe(true);
        expect(deepEqual(true, false)).toBe(false);
      });

      it("should match null and undefined", () => {
        expect(deepEqual(null, null)).toBe(true);
        expect(deepEqual(undefined, undefined)).toBe(true);
        expect(deepEqual(null, undefined)).toBe(false);
      });
    });

    describe("objects", () => {
      it("should match identical objects", () => {
        const obj1 = { a: 1, b: 2 };
        const obj2 = { a: 1, b: 2 };

        expect(deepEqual(obj1, obj2)).toBe(true);
      });

      it("should match objects with different key order", () => {
        const obj1 = { a: 1, b: 2, c: 3 };
        const obj2 = { c: 3, a: 1, b: 2 };

        expect(deepEqual(obj1, obj2)).toBe(true);
      });

      it("should not match objects with different values", () => {
        const obj1 = { a: 1, b: 2 };
        const obj2 = { a: 1, b: 3 };

        expect(deepEqual(obj1, obj2)).toBe(false);
      });

      it("should handle nested objects", () => {
        const obj1 = { a: { b: { c: 1 } } };
        const obj2 = { a: { b: { c: 1 } } };

        expect(deepEqual(obj1, obj2)).toBe(true);
      });

      it("should handle nested objects with different key order", () => {
        const obj1 = { outer: { a: 1, b: 2 }, other: "val" };
        const obj2 = { other: "val", outer: { b: 2, a: 1 } };

        expect(deepEqual(obj1, obj2)).toBe(true);
      });

      it("should not match if nested values differ", () => {
        const obj1 = { a: { b: { c: 1 } } };
        const obj2 = { a: { b: { c: 2 } } };

        expect(deepEqual(obj1, obj2)).toBe(false);
      });

      it("should handle objects with null/undefined values", () => {
        const obj1 = { a: null, b: undefined };
        const obj2 = { a: null, b: undefined };

        expect(deepEqual(obj1, obj2)).toBe(true);
      });

      it("should distinguish null from undefined", () => {
        const obj1 = { a: null };
        const obj2 = { a: undefined };

        expect(deepEqual(obj1, obj2)).toBe(false);
      });
    });

    describe("arrays", () => {
      it("should match identical arrays", () => {
        const arr1 = [1, 2, 3];
        const arr2 = [1, 2, 3];

        expect(deepEqual(arr1, arr2)).toBe(true);
      });

      it("should respect array order", () => {
        const arr1 = [1, 2, 3];
        const arr2 = [3, 2, 1];

        expect(deepEqual(arr1, arr2)).toBe(false);
      });

      it("should handle arrays of objects", () => {
        const arr1 = [{ a: 1 }, { b: 2 }];
        const arr2 = [{ a: 1 }, { b: 2 }];

        expect(deepEqual(arr1, arr2)).toBe(true);
      });

      it("should handle nested arrays", () => {
        const arr1 = [
          [1, 2],
          [3, 4],
        ];
        const arr2 = [
          [1, 2],
          [3, 4],
        ];

        expect(deepEqual(arr1, arr2)).toBe(true);
      });

      it("should handle empty arrays", () => {
        expect(deepEqual([], [])).toBe(true);
        expect(deepEqual([], [1])).toBe(false);
      });
    });

    describe("complex structures", () => {
      it("should match payment requirements with different key orders", () => {
        const req1 = {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000000",
          asset: "0x833...",
          payTo: "0xabc...",
          extra: { foo: "bar" },
        };

        const req2 = {
          extra: { foo: "bar" },
          payTo: "0xabc...",
          asset: "0x833...",
          amount: "1000000",
          network: "eip155:8453",
          scheme: "exact",
        };

        expect(deepEqual(req1, req2)).toBe(true);
      });

      it("should handle empty objects", () => {
        expect(deepEqual({}, {})).toBe(true);
        expect(deepEqual({}, { a: 1 })).toBe(false);
      });
    });
  });

  describe("numberToDecimalString", () => {
    it("should pass through plain integers", () => {
      expect(numberToDecimalString(0)).toBe("0");
      expect(numberToDecimalString(1)).toBe("1");
      expect(numberToDecimalString(42)).toBe("42");
      expect(numberToDecimalString(-5)).toBe("-5");
    });

    it("should pass through plain decimals", () => {
      expect(numberToDecimalString(1.5)).toBe("1.5");
      expect(numberToDecimalString(4.02)).toBe("4.02");
      expect(numberToDecimalString(0.123)).toBe("0.123");
      expect(numberToDecimalString(-3.14)).toBe("-3.14");
    });

    it("should expand small negative exponents", () => {
      expect(numberToDecimalString(1e-7)).toBe("0.0000001");
      expect(numberToDecimalString(1e-8)).toBe("0.00000001");
      expect(numberToDecimalString(1.5e-6)).toBe("0.0000015");
      expect(numberToDecimalString(1e-18)).toBe("0.000000000000000001");
    });

    it("should expand negative numbers with negative exponents", () => {
      expect(numberToDecimalString(-1e-7)).toBe("-0.0000001");
      expect(numberToDecimalString(-2.5e-10)).toBe("-0.00000000025");
    });

    it("should expand large positive exponents", () => {
      expect(numberToDecimalString(1e20)).toBe("100000000000000000000");
      expect(numberToDecimalString(1.5e10)).toBe("15000000000");
    });
  });

  describe("convertToTokenAmount", () => {
    describe("basic conversions", () => {
      it("should convert decimal amounts to token units", () => {
        expect(convertToTokenAmount("4.02", 6)).toBe("4020000");
        expect(convertToTokenAmount("0.10", 6)).toBe("100000");
        expect(convertToTokenAmount("1.00", 6)).toBe("1000000");
        expect(convertToTokenAmount("0.01", 6)).toBe("10000");
        expect(convertToTokenAmount("123.456789", 6)).toBe("123456789");
      });

      it("should handle whole numbers", () => {
        expect(convertToTokenAmount("1", 6)).toBe("1000000");
        expect(convertToTokenAmount("100", 6)).toBe("100000000");
        expect(convertToTokenAmount("0", 6)).toBe("0");
      });

      it("should handle different decimal precisions", () => {
        expect(convertToTokenAmount("1", 0)).toBe("1");
        expect(convertToTokenAmount("1", 2)).toBe("100");
        expect(convertToTokenAmount("1", 7)).toBe("10000000");
        expect(convertToTokenAmount("1", 9)).toBe("1000000000");
        expect(convertToTokenAmount("1.0", 18)).toBe("1000000000000000000");
      });

      it("should truncate excess decimal places", () => {
        expect(convertToTokenAmount("1.12345678", 7)).toBe("11234567");
        expect(convertToTokenAmount("1.5", 0)).toBe("1");
        expect(convertToTokenAmount("2.9", 0)).toBe("2");
      });

      it("should handle trailing zeros", () => {
        expect(convertToTokenAmount("1.0", 6)).toBe("1000000");
        expect(convertToTokenAmount("0.1000000", 7)).toBe("1000000");
      });

      it("should handle negative numbers", () => {
        expect(convertToTokenAmount("-1.5", 6)).toBe("-1500000");
      });

      it("should handle very large numbers", () => {
        expect(convertToTokenAmount("999999999.9999999", 7)).toBe("9999999999999999");
      });
    });

    describe("small amounts with sufficient precision", () => {
      it("should convert tiny amounts when token has enough decimals", () => {
        // 0.0000001 with 9 decimals = 100 atomic units
        expect(convertToTokenAmount("0.0000001", 9)).toBe("100");
        // 0.000000001 with 9 decimals = 1 atomic unit
        expect(convertToTokenAmount("0.000000001", 9)).toBe("1");
        // 0.0000015 with 9 decimals = 1500 atomic units
        expect(convertToTokenAmount("0.0000015", 9)).toBe("1500");
      });

      it("should handle the smallest representable amount", () => {
        expect(convertToTokenAmount("0.0000001", 7)).toBe("1");
        expect(convertToTokenAmount("0.000001", 6)).toBe("1");
        expect(convertToTokenAmount("0.000000000000000001", 18)).toBe("1");
      });
    });

    describe("too-small errors", () => {
      it("should throw when a non-zero amount rounds down to 0", () => {
        // 0.0000001 with 6 decimals: truncates to 0 atomic units
        expect(() => convertToTokenAmount("0.0000001", 6)).toThrow("too small");
        // 0.00000001 with 7 decimals: truncates to 0
        expect(() => convertToTokenAmount("0.00000001", 7)).toThrow("too small");
        // 0.0000000001 with 6 decimals: also too small
        expect(() => convertToTokenAmount("0.0000000001", 6)).toThrow("too small");
      });

      it("should not throw for zero itself", () => {
        expect(convertToTokenAmount("0", 6)).toBe("0");
        expect(convertToTokenAmount("0.0", 6)).toBe("0");
        expect(convertToTokenAmount("0.000000", 6)).toBe("0");
      });
    });

    describe("scientific notation rejection", () => {
      it("should throw for scientific notation input", () => {
        expect(() => convertToTokenAmount("1e-7", 9)).toThrow("scientific notation");
        expect(() => convertToTokenAmount("1e-6", 6)).toThrow("scientific notation");
        expect(() => convertToTokenAmount("1.5e-6", 9)).toThrow("scientific notation");
        expect(() => convertToTokenAmount("1E10", 6)).toThrow("scientific notation");
      });
    });

    describe("invalid input", () => {
      it("should throw for non-numeric strings", () => {
        expect(() => convertToTokenAmount("invalid", 6)).toThrow("Invalid amount");
        expect(() => convertToTokenAmount("abc", 6)).toThrow("Invalid amount");
        expect(() => convertToTokenAmount("", 6)).toThrow("Invalid amount");
        expect(() => convertToTokenAmount("NaN", 6)).toThrow("Invalid amount");
      });
    });
  });

  describe("Base64 encoding", () => {
    const unicodeOriginal =
      "USD₮0 🤖 中文 ありがとう नमस्ते Привет مرحبا بالعالم שלום Γειά σου สวัสดี";
    const unicodeEncoded =
      "VVNE4oKuMCDwn6SWIOS4reaWhyDjgYLjgorjgYzjgajjgYYg4KSo4KSu4KS44KWN4KSk4KWHINCf0YDQuNCy0LXRgiDZhdix2K3YqNinINio2KfZhNi52KfZhNmFINep15zXldedIM6TzrXOuc6sIM+Dzr/PhSDguKrguKfguLHguKrguJTguLU=";

    describe("safeBase64Encode", () => {
      it("should encode simple strings", () => {
        const encoded = safeBase64Encode("hello");
        expect(encoded).toBe("aGVsbG8=");
      });

      it("should encode strings with special characters", () => {
        const encoded = safeBase64Encode("test data 123!@#");
        expect(encoded).toBe("dGVzdCBkYXRhIDEyMyFAIw==");
      });

      it("should encode empty string", () => {
        const encoded = safeBase64Encode("");
        expect(encoded).toBe("");
      });

      it("should encode unicode characters", () => {
        // Note: btoa doesn't handle unicode directly, need to encode first
        // This test verifies the function exists and works with ASCII
        const encoded = safeBase64Encode(unicodeOriginal);
        expect(encoded).toBe(unicodeEncoded);
      });
    });

    describe("safeBase64Decode", () => {
      it("should decode simple base64 strings", () => {
        const decoded = safeBase64Decode("aGVsbG8=");
        expect(decoded).toBe("hello");
      });

      it("should roundtrip encode/decode", () => {
        const original = "test data 123!@#";
        const encoded = safeBase64Encode(original);
        const decoded = safeBase64Decode(encoded);

        expect(decoded).toBe(original);
      });

      it("should decode unicode characters", () => {
        const decoded = safeBase64Decode(unicodeEncoded);
        expect(decoded).toBe(unicodeOriginal);
      });

      it("should decode empty string", () => {
        const decoded = safeBase64Decode("");
        expect(decoded).toBe("");
      });

      it("should handle base64 with different padding", () => {
        expect(safeBase64Decode("YQ==")).toBe("a");
        expect(safeBase64Decode("YWI=")).toBe("ab");
        expect(safeBase64Decode("YWJj")).toBe("abc");
      });
    });
  });
});
