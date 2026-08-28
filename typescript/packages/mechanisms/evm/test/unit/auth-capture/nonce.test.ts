import { describe, it, expect } from "vitest";
import { keccak256, zeroAddress } from "viem";
import {
  AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
  SALT_BINDING_TYPEHASH,
} from "../../../src/auth-capture/constants";
import {
  computePayerAgnosticPaymentInfoHash,
  deriveBoundSalt,
  generateSalt,
  isSaltBindingOn,
} from "../../../src/auth-capture/nonce";
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

    it("should produce fixed hashes for the default and v1.0 escrow domains", () => {
      expect(computePayerAgnosticPaymentInfoHash(84532, mockPaymentInfo)).toBe(
        "0x341988b065a5131b3a82818eb7aba9010135f326af1af7695fce4d2bbebd0b76",
      );
      expect(computePayerAgnosticPaymentInfoHash(8453, mockPaymentInfo)).toBe(
        "0xa393f8f76a2327a7678488b2d504bda611b7586bb3f334b255a11bb5a75e79ca",
      );
      expect(
        computePayerAgnosticPaymentInfoHash(
          84532,
          mockPaymentInfo,
          AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
        ),
      ).toBe("0x19de8ffcb747e5caadb3dda7435cf54992e87cdf0c90e5315ffa129dbb22461e");
      expect(
        computePayerAgnosticPaymentInfoHash(
          8453,
          mockPaymentInfo,
          AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
        ),
      ).toBe("0x198bbfeaab2f8e36302c662ae41bceaef47a1eb4bf2549cb87aa8daa7f7bb43a");
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

  describe("salt binding", () => {
    const authorizer = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const policy = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    const nonce =
      "0x0000000000000000000000000000000000000000000000000000000000000abc" as `0x${string}`;

    it("is off when receiverAuthorizer and policy are absent or zero", () => {
      expect(isSaltBindingOn({})).toBe(false);
      expect(isSaltBindingOn({ receiverAuthorizer: policy, policy })).toBe(false);
    });

    it("is on when receiverAuthorizer is non-zero", () => {
      expect(isSaltBindingOn({ receiverAuthorizer: authorizer })).toBe(true);
    });

    it("derives a deterministic 32-byte salt from the typehash, addresses, and nonce", () => {
      const a = deriveBoundSalt(authorizer, policy, nonce);
      const b = deriveBoundSalt(authorizer, policy, nonce);
      expect(a).toBe(b);
      expect(a).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(a).toBe("0xd0967e09b6c8fccf96277d95a03e98583e8605ab10858b1349aa50ea6d78132c");
    });

    it("should hash the salt-binding and PaymentInfo type strings to stable values", () => {
      expect(SALT_BINDING_TYPEHASH).toBe(
        "0x8a2a7e41a0bda000ded071ff38b79401d2603e1826516ff2635b11fe9e30877f",
      );
      expect(
        keccak256(
          new TextEncoder().encode(
            "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)",
          ),
        ),
      ).toBe("0xae68ac7ce30c86ece8196b61a7c486d8f0061f575037fbd34e7fe4e2820c6591");
    });

    it("changes when any bound input changes", () => {
      const base = deriveBoundSalt(authorizer, policy, nonce);
      expect(deriveBoundSalt("0x2222222222222222222222222222222222222222", policy, nonce)).not.toBe(
        base,
      );
      expect(
        deriveBoundSalt(
          authorizer,
          policy,
          "0x0000000000000000000000000000000000000000000000000000000000000abd",
        ),
      ).not.toBe(base);
    });
  });
});
