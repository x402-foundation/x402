import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExactEvmSchemeV1 } from "../../../src/exact/v1/facilitator/scheme";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import type { PaymentRequirementsV1 } from "@x402/core/types/v1";
import type { PaymentPayloadV1 } from "@x402/core/types/v1";
import * as Errors from "../../../src/exact/facilitator/errors";

// Wraps a per-test readContract impl so isValidSignature returns the ERC-1271
// magic value. The strict signature primitive added in the 7702 fix calls
// readContract for ERC-1271 verification.
const sigValid = "0x1626ba7e";
function rcWithSig(
  impl: unknown | ((args: { address?: string; functionName?: string }) => unknown),
  sigResponse: string = sigValid,
) {
  return vi.fn().mockImplementation(async (args: { address?: string; functionName?: string }) => {
    if (args?.functionName === "isValidSignature") return sigResponse;
    if (typeof impl === "function") {
      return (impl as (a: typeof args) => unknown)(args);
    }
    return impl;
  });
}

describe("ExactEvmSchemeV1", () => {
  let mockSigner: FacilitatorEvmSigner;

  beforeEach(() => {
    mockSigner = {
      address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      // Default readContract returns BigInt("10000000") for nonce/balance/etc.
      // and the ERC-1271 magic value for isValidSignature (mock placeholder sigs).
      readContract: rcWithSig(BigInt("10000000")),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue("0xtxhash"),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      // Default: deployed contract so ERC-1271 path is taken (matches the previous
      // verifyTypedData=true behavior; tests with real ECDSA sigs override this).
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
    };
  });

  describe("constructor", () => {
    it("should create instance with correct scheme", () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);
      expect(facilitator.scheme).toBe("exact");
    });
  });

  describe("verify", () => {
    it("should verify valid V1 payment payload", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: "0xvalidsignature",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: {
          name: "USDC",
          version: "2",
        },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe("0x1234567890123456789012345678901234567890");
    });

    it("should reject if scheme does not match", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "wrong",
        network: "base-sepolia",
        payload: {
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: {},
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrInvalidScheme);
    });

    it("should reject if network does not match", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "ethereum",
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: { name: "USDC", version: "2" },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrNetworkMismatch);
    });

    it("should reject if amount is insufficient (maxAmountRequired)", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "50000", // Less than required
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: { name: "USDC", version: "2" },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrInvalidAuthorizationValue);
    });

    it("should reject if balance is insufficient", async () => {
      // Simulation fails (transfer would revert due to insufficient balance)
      // Simulation reverts on every readContract — but isValidSignature must still
      // succeed (otherwise we never reach simulation). Wrap in rcWithSig so the
      // ERC-1271 sig check passes, then everything else throws.
      mockSigner.readContract = rcWithSig(() => Promise.reject(new Error("simulation reverted")));

      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: { name: "USDC", version: "2" },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_evm_transaction_simulation_failed");
    });

    it("should reject if recipient does not match", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x0000000000000000000000000000000000000000", // Wrong recipient
            value: "100000",
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: { name: "USDC", version: "2" },
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrRecipientMismatch);
    });

    it("should reject if network not supported", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "unknown-network",
        payload: {
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "unknown-network",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: {},
      };

      const result = await facilitator.verify(payload as never, requirements as never);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrNetworkMismatch);
    });
  });

  describe("settle", () => {
    it("should settle valid V1 payment", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: "0xvalidsignature",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: {
          name: "USDC",
          version: "2",
        },
      };

      const result = await facilitator.settle(payload as never, requirements as never);

      expect(result.success).toBe(true);
      expect(result.network).toBe("base-sepolia");
      expect(result.transaction).toBe("0xtxhash");
      expect(result.payer).toBe("0x1234567890123456789012345678901234567890");
    });

    it("should fail settlement if verification fails", async () => {
      // Make the strict primitive's ERC-1271 path return the failure value so
      // signature verification is rejected.
      mockSigner.readContract = rcWithSig(BigInt("10000000"), "0xffffffff");

      const facilitator = new ExactEvmSchemeV1(mockSigner);

      const payload: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: "0xinvalid",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: { name: "USDC", version: "2" },
      };

      const result = await facilitator.settle(payload as never, requirements as never);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrInvalidSignature);
    });
  });
});
