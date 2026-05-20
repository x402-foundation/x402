import { describe, it, expect } from "vitest";
import {
  isAuthCaptureExtra,
  isAuthCapturePayload,
  isEip3009Payload,
  isPermit2Payload,
} from "../../../src/auth-capture/types";

describe("type guards", () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 86400;

  const validExtra = {
    captureAuthorizer: "0xcccccccccccccccccccccccccccccccccccccccc",
    captureDeadline: FUTURE,
    refundDeadline: FUTURE + 86400,
    feeRecipient: "0x4444444444444444444444444444444444444444",
    minFeeBps: 0,
    maxFeeBps: 100,
    name: "USDC",
    version: "2",
  };

  const validEip3009 = {
    authorization: {
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      value: "1000000",
      validAfter: "0",
      validBefore: String(FUTURE),
      nonce: "0x1234567890123456789012345678901234567890123456789012345678901234",
    },
    signature: "0xabcd",
    salt: "0x0000000000000000000000000000000000000000000000000000000000000abc",
  };

  const validPermit2 = {
    permit2Authorization: {
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      permitted: { token: "0xeeee", amount: "1000000" },
      spender: "0xdddd",
      nonce: "12345",
      deadline: String(FUTURE),
    },
    signature: "0xabcd",
    salt: "0x0000000000000000000000000000000000000000000000000000000000000abc",
  };

  describe("isAuthCaptureExtra", () => {
    it("accepts a valid extra object", () => {
      expect(isAuthCaptureExtra(validExtra)).toBe(true);
    });

    it("rejects null and undefined", () => {
      expect(isAuthCaptureExtra(null)).toBe(false);
      expect(isAuthCaptureExtra(undefined)).toBe(false);
    });

    it("rejects non-objects", () => {
      expect(isAuthCaptureExtra("string")).toBe(false);
      expect(isAuthCaptureExtra(42)).toBe(false);
      expect(isAuthCaptureExtra(true)).toBe(false);
    });

    it("rejects when captureAuthorizer is missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { captureAuthorizer: _ca, ...rest } = validExtra;
      expect(isAuthCaptureExtra(rest)).toBe(false);
    });

    it("rejects when captureDeadline is not a number", () => {
      expect(isAuthCaptureExtra({ ...validExtra, captureDeadline: "soon" })).toBe(false);
    });

    it("rejects when feeRecipient is not a string", () => {
      expect(isAuthCaptureExtra({ ...validExtra, feeRecipient: 42 })).toBe(false);
    });

    it("rejects when name/version are missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { name: _n, ...rest } = validExtra;
      expect(isAuthCaptureExtra(rest)).toBe(false);
    });

    it("rejects when minFeeBps is missing (required per spec, no implicit default)", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { minFeeBps: _m, ...rest } = validExtra;
      expect(isAuthCaptureExtra(rest)).toBe(false);
    });

    it("rejects when maxFeeBps is missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { maxFeeBps: _m, ...rest } = validExtra;
      expect(isAuthCaptureExtra(rest)).toBe(false);
    });

    it("rejects the old commerce-era extra shape", () => {
      const oldShape = {
        escrowAddress: "0xeee",
        operatorAddress: "0xccc",
        tokenCollector: "0xbbb",
        name: "USDC",
        version: "2",
      };
      expect(isAuthCaptureExtra(oldShape)).toBe(false);
    });
  });

  describe("isEip3009Payload", () => {
    it("accepts a valid EIP-3009 payload", () => {
      expect(isEip3009Payload(validEip3009)).toBe(true);
    });

    it("rejects when authorization is missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { authorization: _a, ...rest } = validEip3009;
      expect(isEip3009Payload(rest)).toBe(false);
    });

    it("rejects when signature is missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { signature: _s, ...rest } = validEip3009;
      expect(isEip3009Payload(rest)).toBe(false);
    });

    it("rejects when salt is missing (regression: salt is required on payload)", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { salt: _salt, ...rest } = validEip3009;
      expect(isEip3009Payload(rest)).toBe(false);
    });

    it("rejects a Permit2 payload (no authorization field)", () => {
      expect(isEip3009Payload(validPermit2)).toBe(false);
    });

    it("rejects null", () => {
      expect(isEip3009Payload(null)).toBe(false);
    });
  });

  describe("isPermit2Payload", () => {
    it("accepts a valid Permit2 payload", () => {
      expect(isPermit2Payload(validPermit2)).toBe(true);
    });

    it("rejects when permit2Authorization is missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { permit2Authorization: _p, ...rest } = validPermit2;
      expect(isPermit2Payload(rest)).toBe(false);
    });

    it("rejects when salt is missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { salt: _s, ...rest } = validPermit2;
      expect(isPermit2Payload(rest)).toBe(false);
    });

    it("rejects when permit2Authorization.from is not a string", () => {
      expect(
        isPermit2Payload({
          ...validPermit2,
          permit2Authorization: { ...validPermit2.permit2Authorization, from: 42 },
        }),
      ).toBe(false);
    });

    it("rejects an EIP-3009 payload", () => {
      expect(isPermit2Payload(validEip3009)).toBe(false);
    });
  });

  describe("isAuthCapturePayload (discriminated union)", () => {
    it("accepts both EIP-3009 and Permit2 payloads", () => {
      expect(isAuthCapturePayload(validEip3009)).toBe(true);
      expect(isAuthCapturePayload(validPermit2)).toBe(true);
    });

    it("rejects shapes that match neither variant", () => {
      expect(isAuthCapturePayload({ signature: "0xabcd", salt: "0x00" })).toBe(false);
      expect(isAuthCapturePayload({ authorization: {} })).toBe(false);
      expect(isAuthCapturePayload(null)).toBe(false);
    });
  });
});
