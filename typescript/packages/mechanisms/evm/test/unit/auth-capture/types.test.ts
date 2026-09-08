import { describe, it, expect } from "vitest";
import {
  isAuthCaptureExtra,
  isAuthCapturePayload,
  isCapturePayload,
  isEip3009Payload,
  isLifecyclePayload,
  isPermit2Payload,
  isRefundPayload,
  isVoidPayload,
} from "../../../src/auth-capture/types";
import type { PaymentInfoStruct } from "../../../src/auth-capture/types";

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

    it("accepts a bound payload that also carries saltNonce", () => {
      expect(
        isEip3009Payload({
          ...validEip3009,
          saltNonce: "0x0000000000000000000000000000000000000000000000000000000000000abc",
        }),
      ).toBe(true);
    });

    it("rejects a lifecycle payload even if authorization is present", () => {
      expect(isEip3009Payload({ ...validEip3009, type: "capture" })).toBe(false);
    });

    it("rejects a Permit2 payload (no authorization field)", () => {
      expect(isEip3009Payload(validPermit2)).toBe(false);
    });

    it("rejects null", () => {
      expect(isEip3009Payload(null)).toBe(false);
    });

    it("rejects a non-hex salt", () => {
      expect(isEip3009Payload({ ...validEip3009, salt: "not-hex" })).toBe(false);
    });

    it("rejects a bound charge payload whose saltNonce is not hex", () => {
      expect(
        isEip3009Payload({
          ...validEip3009,
          saltNonce: "nope",
          amount: "100",
          feeBps: 10,
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(false);
    });

    it("rejects a charge payload that is missing saltNonce", () => {
      expect(
        isEip3009Payload({
          ...validEip3009,
          amount: "100",
          feeBps: 10,
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(false);
    });

    it("accepts a v1.0 charge completion (feeBps) when saltNonce is present", () => {
      expect(
        isEip3009Payload({
          ...validEip3009,
          saltNonce: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          amount: "100",
          feeBps: 10,
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(true);
    });

    it("accepts a v1.1 charge completion (feeAmount) when saltNonce is present", () => {
      expect(
        isEip3009Payload({
          ...validEip3009,
          saltNonce: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          amount: "100",
          feeAmount: "1",
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(true);
    });

    it("rejects a charge that mixes feeBps and feeAmount", () => {
      expect(
        isEip3009Payload({
          ...validEip3009,
          saltNonce: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          amount: "100",
          feeBps: 10,
          feeAmount: "1",
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(false);
    });

    it("rejects a partial charge group (amount without fee fields)", () => {
      expect(
        isEip3009Payload({
          ...validEip3009,
          saltNonce: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          amount: "100",
        }),
      ).toBe(false);
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

    it("rejects a lifecycle envelope even if permit2Authorization is present", () => {
      expect(isPermit2Payload({ ...validPermit2, type: "refund" })).toBe(false);
    });

    it("rejects when permit2Authorization.permitted is missing", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { permitted: _p, ...restAuth } = validPermit2.permit2Authorization;
      expect(
        isPermit2Payload({
          ...validPermit2,
          permit2Authorization: restAuth,
        }),
      ).toBe(false);
    });

    it("rejects a charge payload that is missing saltNonce", () => {
      expect(
        isPermit2Payload({
          ...validPermit2,
          amount: "100",
          feeAmount: "1",
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(false);
    });

    it("accepts a v1.1 charge completion when saltNonce is present", () => {
      expect(
        isPermit2Payload({
          ...validPermit2,
          saltNonce: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          amount: "100",
          feeAmount: "1",
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(true);
    });

    it("rejects a malformed charge group even with saltNonce", () => {
      expect(
        isPermit2Payload({
          ...validPermit2,
          saltNonce: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          amount: "100",
          feeBps: "10",
          feeReceiver: "0x4444444444444444444444444444444444444444",
          authorizerSignature: "0xab",
        }),
      ).toBe(false);
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

    it("accepts capture/void/refund lifecycle envelopes and rejects a typed but incomplete one", () => {
      const paymentInfo: PaymentInfoStruct = {
        operator: "0x1111111111111111111111111111111111111111",
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        receiver: "0x2222222222222222222222222222222222222222",
        token: "0x3333333333333333333333333333333333333333",
        maxAmount: "1000000",
        preApprovalExpiry: 1,
        authorizationExpiry: 2,
        refundExpiry: 3,
        minFeeBps: 0,
        maxFeeBps: 100,
        feeReceiver: "0x4444444444444444444444444444444444444444",
        salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
      };
      const saltNonce = "0x0000000000000000000000000000000000000000000000000000000000000abc";

      const capture = {
        type: "capture",
        paymentInfo,
        saltNonce,
        amount: "100",
        feeBps: 10,
        feeReceiver: paymentInfo.feeReceiver,
        expectedCapturableAmount: "100",
        expectedRefundableAmount: "0",
        authorizerSignature: "0xab",
      };
      const captureV11 = { ...capture, feeBps: undefined, feeAmount: "1" };
      const voidPayload = {
        type: "void",
        paymentInfo,
        saltNonce,
        authorizerSignature: "0xab",
      };
      const refund = {
        type: "refund",
        paymentInfo,
        saltNonce,
        amount: "50",
        expectedCapturableAmount: "0",
        expectedRefundableAmount: "50",
        authorizerSignature: "0xab",
      };

      expect(isLifecyclePayload(capture)).toBe(true);
      expect(isCapturePayload(capture)).toBe(true);
      expect(isCapturePayload(captureV11)).toBe(true);
      expect(isVoidPayload(voidPayload)).toBe(true);
      expect(isRefundPayload(refund)).toBe(true);
      expect(isAuthCapturePayload(capture)).toBe(true);
      expect(isAuthCapturePayload(voidPayload)).toBe(true);
      expect(isAuthCapturePayload(refund)).toBe(true);

      expect(isCapturePayload({ type: "capture" })).toBe(false);
      expect(isCapturePayload({ ...capture, feeBps: 10, feeAmount: "1" })).toBe(false);
      expect(isVoidPayload({ type: "void", authorizerSignature: "0xab" })).toBe(false);
      expect(isRefundPayload({ type: "refund", amount: "1" })).toBe(false);
      expect(isAuthCapturePayload({ type: "capture" })).toBe(false);
      expect(isAuthCapturePayload({ type: "authorize" })).toBe(false);
    });
  });
});
