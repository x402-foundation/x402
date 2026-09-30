import { describe, it, expect } from "vitest";
import { isExactAvmPayload } from "../../src";
import type { ExactAvmPayloadV2 } from "../../src";

describe("AVM Types", () => {
  describe("ExactAvmPayloadV2", () => {
    it("should accept valid payload with payment group and index", () => {
      const payload: ExactAvmPayloadV2 = {
        paymentGroup: ["base64encoded1", "base64encoded2"],
        paymentIndex: 1,
      };

      expect(payload.paymentGroup).toHaveLength(2);
      expect(payload.paymentIndex).toBe(1);
    });

    it("should accept payload with single transaction", () => {
      const payload: ExactAvmPayloadV2 = {
        paymentGroup: ["singleTransaction"],
        paymentIndex: 0,
      };

      expect(payload.paymentGroup).toHaveLength(1);
      expect(payload.paymentIndex).toBe(0);
    });

    it("should accept payload with long base64 strings", () => {
      const longBase64 = "A".repeat(1000) + "==";
      const payload: ExactAvmPayloadV2 = {
        paymentGroup: [longBase64],
        paymentIndex: 0,
      };

      expect(payload.paymentGroup[0]).toBe(longBase64);
      expect(payload.paymentGroup[0].length).toBe(1002);
    });
  });

  describe("isExactAvmPayload", () => {
    it("should return true for valid payloads", () => {
      expect(
        isExactAvmPayload({
          paymentGroup: ["tx1", "tx2"],
          paymentIndex: 1,
        }),
      ).toBe(true);
    });

    it("should return true for single-transaction payload", () => {
      expect(
        isExactAvmPayload({
          paymentGroup: ["tx1"],
          paymentIndex: 0,
        }),
      ).toBe(true);
    });

    it("should return false for null", () => {
      expect(isExactAvmPayload(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isExactAvmPayload(undefined)).toBe(false);
    });

    it("should return false for empty object", () => {
      expect(isExactAvmPayload({})).toBe(false);
    });

    it("should return false when paymentGroup is missing", () => {
      expect(isExactAvmPayload({ paymentIndex: 0 })).toBe(false);
    });

    it("should return false when paymentIndex is missing", () => {
      expect(isExactAvmPayload({ paymentGroup: ["tx1"] })).toBe(false);
    });

    it("should return false when paymentGroup is not an array", () => {
      expect(isExactAvmPayload({ paymentGroup: "not-array", paymentIndex: 0 })).toBe(false);
    });

    it("should return false when paymentIndex is not a number", () => {
      expect(isExactAvmPayload({ paymentGroup: ["tx1"], paymentIndex: "0" })).toBe(false);
    });

    it("should accept empty paymentGroup (valid structure)", () => {
      // An empty paymentGroup is structurally valid per the type guard
      // (the facilitator will reject it at verification time)
      expect(isExactAvmPayload({ paymentGroup: [], paymentIndex: 0 })).toBe(true);
    });

    it("should return false for primitive values", () => {
      expect(isExactAvmPayload("string")).toBe(false);
      expect(isExactAvmPayload(42)).toBe(false);
      expect(isExactAvmPayload(true)).toBe(false);
    });
  });
});
