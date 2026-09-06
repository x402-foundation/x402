import { describe, it, expect } from "vitest";
import type { ExactAptosPayload, DecodedAptosPayload } from "../../src/types";

describe("Aptos Types", () => {
  describe("ExactAptosPayload", () => {
    it("should accept valid payload structure", () => {
      const payload: ExactAptosPayload = {
        transaction: "base64encodedtransaction==",
      };

      expect(payload.transaction).toBeDefined();
      expect(typeof payload.transaction).toBe("string");
    });

    it("should accept empty transaction string", () => {
      const payload: ExactAptosPayload = {
        transaction: "",
      };

      expect(payload.transaction).toBe("");
    });

    it("should accept long base64 transaction strings", () => {
      const longTransaction = "A".repeat(1000) + "==";
      const payload: ExactAptosPayload = {
        transaction: longTransaction,
      };

      expect(payload.transaction).toBe(longTransaction);
      expect(payload.transaction.length).toBe(1002);
    });
  });

  describe("DecodedAptosPayload", () => {
    it("should accept valid decoded structure", () => {
      const decoded: DecodedAptosPayload = {
        transaction: [1, 2, 3, 4, 5],
        senderAuthenticator: [10, 20, 30],
      };

      expect(decoded.transaction).toBeDefined();
      expect(decoded.senderAuthenticator).toBeDefined();
      expect(Array.isArray(decoded.transaction)).toBe(true);
      expect(Array.isArray(decoded.senderAuthenticator)).toBe(true);
    });

    it("should accept empty arrays", () => {
      const decoded: DecodedAptosPayload = {
        transaction: [],
        senderAuthenticator: [],
      };

      expect(decoded.transaction.length).toBe(0);
      expect(decoded.senderAuthenticator.length).toBe(0);
    });
  });
});
