import { describe, it, expect, vi } from "vitest";
import { keccak256, zeroAddress } from "viem";
import {
  AUTH_CAPTURE_DEPLOYMENT_V1_0,
  AUTH_CAPTURE_DEPLOYMENT_V1_1,
  AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
  AUTH_CAPTURE_ESCROW_V1_1_ADDRESS,
  CAPTURE_TYPES_V1_0,
  CAPTURE_TYPES_V1_1,
  CHARGE_TYPES_V1_0,
  CHARGE_TYPES_V1_1,
  SALT_BINDING_TYPEHASH,
  captureTypesForDeployment,
  chargeTypesForDeployment,
  feeAmountFromBps,
  resolveAuthCaptureDeployment,
} from "../../../src/auth-capture/constants";
import {
  computePayerAgnosticPaymentInfoHash,
  computePaymentInfoHash,
  deriveBoundSalt,
  extraAddress,
  generateSalt,
  isNonZeroAddress,
  isSaltBindingOn,
  normalizeBytes32,
  signPermit2,
  verifyERC3009Signature,
  verifyPermit2Signature,
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
        "0x695990db5fd8f3f541f505b117da619dace4d28a039e35646ce7b660e699ff4b",
      );
      expect(computePayerAgnosticPaymentInfoHash(8453, mockPaymentInfo)).toBe(
        "0x37588eff80093203c128c6622608c6e972e41c2fd79da91ef5294a26e647e4e2",
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

    it("computePaymentInfoHash binds the real payer and therefore differs from the nonce", () => {
      const withPayer: PaymentInfoStruct = {
        ...mockPaymentInfo,
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };
      const nonce = computePayerAgnosticPaymentInfoHash(84532, withPayer);
      const paymentHash = computePaymentInfoHash(84532, withPayer);
      expect(paymentHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(paymentHash).not.toBe(nonce);
      expect(computePaymentInfoHash(84532, { ...withPayer, payer: zeroAddress })).toBe(nonce);
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

  describe("normalizeBytes32", () => {
    it("zero-pads a short hex integer and lowercases it", () => {
      expect(normalizeBytes32("0xAbC")).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000abc",
      );
    });

    it("accepts a value without a 0x prefix and a 0X prefix", () => {
      expect(normalizeBytes32("1")).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      );
      expect(normalizeBytes32("0Xff")).toBe(
        "0x00000000000000000000000000000000000000000000000000000000000000ff",
      );
    });

    it("rejects empty, non-hex, and oversized values", () => {
      expect(() => normalizeBytes32("0x")).toThrow("Invalid bytes32");
      expect(() => normalizeBytes32("0xzz")).toThrow("Invalid bytes32");
      expect(() => normalizeBytes32(`0x${"aa".repeat(33)}`)).toThrow("Invalid bytes32");
    });
  });

  describe("extraAddress / isNonZeroAddress", () => {
    it("treats absent or invalid addresses as the zero address", () => {
      expect(extraAddress(undefined)).toBe(zeroAddress);
      expect(extraAddress("")).toBe(zeroAddress);
      expect(extraAddress("not-an-address")).toBe(zeroAddress);
      expect(isNonZeroAddress(undefined)).toBe(false);
      expect(isNonZeroAddress("0x0000000000000000000000000000000000000000")).toBe(false);
    });

    it("checksums a valid address and treats it as non-zero", () => {
      expect(extraAddress("0x1111111111111111111111111111111111111111")).toBe(
        "0x1111111111111111111111111111111111111111",
      );
      expect(isNonZeroAddress("0x1111111111111111111111111111111111111111")).toBe(true);
    });
  });

  describe("signature helpers", () => {
    it("verifyPermit2Signature forwards Permit2 typed data to the facilitator signer", async () => {
      const verifyTypedData = vi.fn().mockResolvedValue(true);
      const getCode = vi.fn().mockResolvedValue("0x");
      const signer = {
        getAddresses: () => [],
        readContract: vi.fn(),
        verifyTypedData,
        writeContract: vi.fn(),
        sendTransaction: vi.fn(),
        waitForTransactionReceipt: vi.fn(),
        getCode,
      };
      const permit = {
        from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
        permitted: {
          token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
          amount: "1000",
        },
        spender: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
        nonce: "1",
        deadline: "9999999999",
      };

      await expect(verifyPermit2Signature(signer, permit, "0xdead", 84532)).resolves.toBe(false);

      const signed = await signPermit2(
        {
          address: permit.from,
          signTypedData: vi.fn().mockResolvedValue("0xsigned" as `0x${string}`),
        },
        permit,
        84532,
      );
      expect(signed).toBe("0xsigned");
    });

    it("verifyERC3009Signature rejects an invalid signature", async () => {
      const signer = {
        getAddresses: () => [],
        readContract: vi.fn(),
        verifyTypedData: vi.fn().mockResolvedValue(false),
        writeContract: vi.fn(),
        sendTransaction: vi.fn(),
        waitForTransactionReceipt: vi.fn(),
        getCode: vi.fn().mockResolvedValue("0x"),
      };
      const ok = await verifyERC3009Signature(
        signer,
        {
          from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          value: "1",
          validAfter: "0",
          validBefore: "9",
          nonce: "0x1111111111111111111111111111111111111111111111111111111111111111",
        },
        "0x00",
        { name: "USDC", version: "2", chainId: 84532 },
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      );
      expect(ok).toBe(false);
    });
  });
});

describe("auth-capture deployment constants", () => {
  it("resolves v1.1 by default and v1.0 from the known escrow address", () => {
    expect(resolveAuthCaptureDeployment()).toBe(AUTH_CAPTURE_DEPLOYMENT_V1_1);
    expect(resolveAuthCaptureDeployment("")).toBe(AUTH_CAPTURE_DEPLOYMENT_V1_1);
    expect(resolveAuthCaptureDeployment(AUTH_CAPTURE_ESCROW_V1_1_ADDRESS)).toBe(
      AUTH_CAPTURE_DEPLOYMENT_V1_1,
    );
    expect(resolveAuthCaptureDeployment(AUTH_CAPTURE_ESCROW_V1_1_ADDRESS.toLowerCase())).toBe(
      AUTH_CAPTURE_DEPLOYMENT_V1_1,
    );
    expect(resolveAuthCaptureDeployment(AUTH_CAPTURE_ESCROW_V1_0_ADDRESS)).toBe(
      AUTH_CAPTURE_DEPLOYMENT_V1_0,
    );
    expect(resolveAuthCaptureDeployment("not-an-address")).toBeUndefined();
    expect(
      resolveAuthCaptureDeployment("0x0000000000000000000000000000000000000001"),
    ).toBeUndefined();
  });

  it("selects v1.0 vs v1.1 operator typed-data fields and computes escrow fee amounts", () => {
    expect(chargeTypesForDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_0)).toBe(CHARGE_TYPES_V1_0);
    expect(chargeTypesForDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_1)).toBe(CHARGE_TYPES_V1_1);
    expect(captureTypesForDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_0)).toBe(CAPTURE_TYPES_V1_0);
    expect(captureTypesForDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_1)).toBe(CAPTURE_TYPES_V1_1);
    expect(feeAmountFromBps(1_000_000n, 250)).toBe(25_000n);
    expect(feeAmountFromBps(1n, 1)).toBe(0n);
  });
});
