import { describe, it, expect } from "vitest";
import type { ExactSvmPayloadV1, ExactSvmPayloadV2 } from "../../src/types";

describe("SVM Types", () => {
  describe("ExactSvmPayloadV1", () => {
    it("should accept valid payload structure", () => {
      const payload: ExactSvmPayloadV1 = {
        transaction: "base64encodedtransaction==",
      };

      expect(payload.transaction).toBeDefined();
      expect(typeof payload.transaction).toBe("string");
    });

    it("should accept empty transaction string", () => {
      const payload: ExactSvmPayloadV1 = {
        transaction: "",
      };

      expect(payload.transaction).toBe("");
    });

    it("should accept long base64 transaction strings", () => {
      const longTransaction = "A".repeat(1000) + "==";
      const payload: ExactSvmPayloadV1 = {
        transaction: longTransaction,
      };

      expect(payload.transaction).toBe(longTransaction);
      expect(payload.transaction.length).toBe(1002);
    });
  });

  describe("ExactSvmPayloadV2", () => {
    it("should have the same structure as V1", () => {
      const payload: ExactSvmPayloadV2 = {
        transaction: "base64encodedtransaction==",
      };

      // V2 should be compatible with V1
      const payloadV1: ExactSvmPayloadV1 = payload;
      expect(payloadV1).toEqual(payload);
    });

    it("should be assignable from V1", () => {
      const payloadV1: ExactSvmPayloadV1 = {
        transaction: "test==",
      };

      const payloadV2: ExactSvmPayloadV2 = payloadV1;
      expect(payloadV2).toEqual(payloadV1);
    });
  });
});
