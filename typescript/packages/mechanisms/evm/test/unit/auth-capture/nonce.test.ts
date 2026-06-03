import { describe, it, expect } from "vitest";
import { zeroAddress } from "viem";
import { computePayerAgnosticPaymentInfoHash, generateSalt } from "../../../src/auth-capture/nonce";
import type { PaymentInfoStruct } from "../../../src/auth-capture/types";

describe("nonce utilities", () => {
  describe("computePayerAgnosticPaymentInfoHash", () => {
    const mockPaymentInfo: PaymentInfoStruct = {
      operator: "0x1111111111111111111111111111111111111111",
      payer: "0xPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP".toLowerCase() as `0x${string}`,
      receiver: "0x2222222222222222222222222222222222222222",
      token: "0x3333333333333333333333333333333333333333",
      maxAmount: "1000000",
      preApprovalExpiry: 281474976710655,
      authorizationExpiry: 281474976710655,
      refundExpiry: 281474976710655,
      minFeeBps: 0,
      maxFeeBps: 100,
      feeReceiver: "0x4444444444444444444444444444444444444444",
      salt: "0x0000000000000000000000000000000000000000000000000000000000000001",
    };

    it("should produce a 32-byte hex string", () => {
      const nonce = computePayerAgnosticPaymentInfoHash(84532, mockPaymentInfo);
      expect(nonce).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("should produce deterministic results for same inputs", () => {
      const nonce1 = computePayerAgnosticPaymentInfoHash(84532, mockPaymentInfo);
      const nonce2 = computePayerAgnosticPaymentInfoHash(84532, mockPaymentInfo);
      expect(nonce1).toBe(nonce2);
    });

    it("should produce different results for different chainIds", () => {
      const nonce1 = computePayerAgnosticPaymentInfoHash(84532, mockPaymentInfo);
      const nonce2 = computePayerAgnosticPaymentInfoHash(8453, mockPaymentInfo);
      expect(nonce1).not.toBe(nonce2);
    });

    it("should produce different results for different payment info", () => {
      const nonce1 = computePayerAgnosticPaymentInfoHash(84532, mockPaymentInfo);
      const nonce2 = computePayerAgnosticPaymentInfoHash(84532, {
        ...mockPaymentInfo,
        maxAmount: "2000000",
      });
      expect(nonce1).not.toBe(nonce2);
    });

    it("should produce different results for different salts (freshness check)", () => {
      const nonce1 = computePayerAgnosticPaymentInfoHash(84532, mockPaymentInfo);
      const nonce2 = computePayerAgnosticPaymentInfoHash(84532, {
        ...mockPaymentInfo,
        salt: "0x0000000000000000000000000000000000000000000000000000000000000002",
      });
      expect(nonce1).not.toBe(nonce2);
    });

    it("should be payer-agnostic — different payers produce identical nonces", () => {
      const nonceA = computePayerAgnosticPaymentInfoHash(84532, {
        ...mockPaymentInfo,
        payer: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".toLowerCase() as `0x${string}`,
      });
      const nonceB = computePayerAgnosticPaymentInfoHash(84532, {
        ...mockPaymentInfo,
        payer: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".toLowerCase() as `0x${string}`,
      });
      const nonceZero = computePayerAgnosticPaymentInfoHash(84532, {
        ...mockPaymentInfo,
        payer: zeroAddress,
      });
      expect(nonceA).toBe(nonceB);
      expect(nonceA).toBe(nonceZero);
    });
  });

  describe("generateSalt", () => {
    it("should produce a 32-byte hex string", () => {
      const salt = generateSalt();
      expect(salt).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("should produce unique values on each call", () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const salt3 = generateSalt();
      expect(salt1).not.toBe(salt2);
      expect(salt2).not.toBe(salt3);
      expect(salt1).not.toBe(salt3);
    });

    it("should produce valid hex characters only", () => {
      const salt = generateSalt();
      const hexPart = salt.slice(2);
      expect(hexPart).toMatch(/^[0-9a-f]+$/);
    });
  });
});
