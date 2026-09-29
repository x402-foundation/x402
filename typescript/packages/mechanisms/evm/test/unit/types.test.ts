import { describe, it, expect } from "vitest";
import type {
  ExactEvmPayloadV1,
  ExactEvmPayloadV2,
  ExactEIP3009Payload,
  ExactPermit2Payload,
} from "../../src/types";
import { isPermit2Payload, isEIP3009Payload } from "../../src/types";

describe("EVM Types", () => {
  describe("ExactEvmPayloadV1", () => {
    it("should accept valid payload structure", () => {
      const payload: ExactEvmPayloadV1 = {
        signature: "0x1234567890abcdef",
        authorization: {
          from: "0x1234567890123456789012345678901234567890",
          to: "0x9876543210987654321098765432109876543210",
          value: "100000",
          validAfter: "1234567890",
          validBefore: "1234567890",
          nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        },
      };

      expect(payload.signature).toBeDefined();
      expect(payload.authorization.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(payload.authorization.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });

    it("should allow optional signature", () => {
      const payload: ExactEvmPayloadV1 = {
        authorization: {
          from: "0x1234567890123456789012345678901234567890",
          to: "0x9876543210987654321098765432109876543210",
          value: "100000",
          validAfter: "1234567890",
          validBefore: "1234567890",
          nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        },
      };

      expect(payload.signature).toBeUndefined();
      expect(payload.authorization).toBeDefined();
    });
  });

  describe("ExactEvmPayloadV2", () => {
    it("should accept EIP-3009 payload structure", () => {
      const payload: ExactEvmPayloadV2 = {
        signature: "0x1234567890abcdef",
        authorization: {
          from: "0x1234567890123456789012345678901234567890",
          to: "0x9876543210987654321098765432109876543210",
          value: "100000",
          validAfter: "1234567890",
          validBefore: "1234567890",
          nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        },
      };

      // V2 should be compatible with V1
      const payloadV1: ExactEvmPayloadV1 = payload;
      expect(payloadV1).toEqual(payload);
    });

    it("should accept Permit2 payload structure", () => {
      const payload: ExactPermit2Payload = {
        signature: "0x1234567890abcdef",
        permit2Authorization: {
          from: "0x1234567890123456789012345678901234567890",
          permitted: {
            token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            amount: "1000000",
          },
          spender: "0x4020B671C4c523a852c11a5EC58F27F235e80001",
          nonce: "12345",
          deadline: "1234567890",
          witness: {
            to: "0x9876543210987654321098765432109876543210",
            validAfter: "1234567000",
          },
        },
      };

      expect(payload.signature).toBeDefined();
      expect(payload.permit2Authorization).toBeDefined();
      expect(payload.permit2Authorization.permitted.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe("Type Guards", () => {
    const eip3009Payload: ExactEIP3009Payload = {
      signature: "0x1234567890abcdef",
      authorization: {
        from: "0x1234567890123456789012345678901234567890",
        to: "0x9876543210987654321098765432109876543210",
        value: "100000",
        validAfter: "1234567890",
        validBefore: "1234567890",
        nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      },
    };

    const permit2Payload: ExactPermit2Payload = {
      signature: "0x1234567890abcdef",
      permit2Authorization: {
        from: "0x1234567890123456789012345678901234567890",
        permitted: {
          token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1000000",
        },
        spender: "0x4020B671C4c523a852c11a5EC58F27F235e80001",
        nonce: "12345",
        deadline: "1234567890",
        witness: {
          to: "0x9876543210987654321098765432109876543210",
          validAfter: "1234567000",
        },
      },
    };

    describe("isEIP3009Payload", () => {
      it("should return true for EIP-3009 payload", () => {
        expect(isEIP3009Payload(eip3009Payload)).toBe(true);
      });

      it("should return false for Permit2 payload", () => {
        expect(isEIP3009Payload(permit2Payload)).toBe(false);
      });
    });

    describe("isPermit2Payload", () => {
      it("should return true for Permit2 payload", () => {
        expect(isPermit2Payload(permit2Payload)).toBe(true);
      });

      it("should return false for EIP-3009 payload", () => {
        expect(isPermit2Payload(eip3009Payload)).toBe(false);
      });
    });
  });
});
