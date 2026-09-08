import { describe, it, expect, vi, beforeEach } from "vitest";
import { concat, encodeAbiParameters } from "viem";
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

    it("should reject when EIP-712 name/version are missing", async () => {
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
      expect(result.invalidReason).toBe(Errors.ErrMissingEip712Domain);
    });

    it("should reject an expired validBefore and a future validAfter", async () => {
      const facilitator = new ExactEvmSchemeV1(mockSigner);
      const now = Math.floor(Date.now() / 1000);
      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: { name: "USDC", version: "2" },
      };
      const expired: PaymentPayloadV1 = {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: "0xsig",
          authorization: {
            from: "0x1234567890123456789012345678901234567890",
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: "0",
            validBefore: String(now - 10),
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
      };
      expect(
        (await facilitator.verify(expired as never, requirements as never)).invalidReason,
      ).toBe(Errors.ErrValidBeforeExpired);

      const future: PaymentPayloadV1 = {
        ...expired,
        payload: {
          ...expired.payload,
          authorization: {
            ...expired.payload.authorization,
            validAfter: String(now + 3600),
            validBefore: String(now + 7200),
          },
        },
      };
      expect((await facilitator.verify(future as never, requirements as never)).invalidReason).toBe(
        Errors.ErrValidAfterInFuture,
      );
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

    it("should fail settlement when the receipt status is not success", async () => {
      mockSigner.waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "reverted" });
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
        extra: { name: "USDC", version: "2" },
      };
      const result = await facilitator.settle(payload as never, requirements as never);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrTransactionFailed);
    });

    it("should fail settlement when receipt logs do not contain the expected Transfer", async () => {
      mockSigner.waitForTransactionReceipt = vi.fn().mockResolvedValue({
        status: "success",
        logs: [],
      });
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
        extra: { name: "USDC", version: "2" },
      };
      const result = await facilitator.settle(payload as never, requirements as never);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrTransferEventMismatch);
    });
  });

  describe("ERC-6492 factory allowlist", () => {
    const ERC6492_MAGIC = "0x6492649264926492649264926492649264926492649264926492649264926492";
    const FACTORY = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const PAYER = "0x1234567890123456789012345678901234567890";

    function makeErc6492Sig(): `0x${string}` {
      const innerSig = ("0x" + "cc".repeat(66)) as `0x${string}`;
      const encoded = encodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
        [FACTORY, "0xdeadbeef" as `0x${string}`, innerSig],
      );
      return concat([encoded, ERC6492_MAGIC]) as `0x${string}`;
    }

    function makePayload(): PaymentPayloadV1 {
      return {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: {
          signature: makeErc6492Sig(),
          authorization: {
            from: PAYER,
            to: "0x9876543210987654321098765432109876543210",
            value: "100000",
            validAfter: (Math.floor(Date.now() / 1000) - 300).toString(),
            validBefore: (Math.floor(Date.now() / 1000) + 3600).toString(),
            nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          },
        },
      };
    }

    const requirements: PaymentRequirementsV1 = {
      scheme: "exact",
      network: "base-sepolia",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      maxAmountRequired: "100000",
      payTo: "0x9876543210987654321098765432109876543210",
      maxTimeoutSeconds: 3600,
      extra: { name: "USDC", version: "2" },
    };

    it("rejects a counterfactual payment whose factory is not allowlisted", async () => {
      mockSigner.getCode = vi.fn().mockResolvedValue("0x");
      const facilitator = new ExactEvmSchemeV1(mockSigner, { eip6492AllowedFactories: [] });
      const result = await facilitator.verify(makePayload() as never, requirements as never);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrFactoryNotAllowed);
      expect(result.payer).toBe(PAYER);
    });

    it("rejects a counterfactual payment when getCode fails and the factory is unknown", async () => {
      mockSigner.getCode = vi.fn().mockRejectedValue(new Error("rpc timeout"));
      const facilitator = new ExactEvmSchemeV1(mockSigner, {
        eip6492AllowedFactories: ["0x3333333333333333333333333333333333333333"],
      });
      const result = await facilitator.verify(makePayload() as never, requirements as never);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrFactoryNotAllowed);
    });

    it("rejects settle when the undeployed wallet's factory is not allowlisted", async () => {
      mockSigner.getCode = vi.fn().mockResolvedValue("0x");
      mockSigner.sendTransaction = vi.fn();
      const facilitator = new ExactEvmSchemeV1(mockSigner, { eip6492AllowedFactories: [] });
      const result = await facilitator.settle(makePayload() as never, requirements as never);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrFactoryNotAllowed);
      expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
    });

    it("fails settle when the allowlisted factory transaction reverts", async () => {
      mockSigner.getCode = vi.fn().mockResolvedValue("0x");
      mockSigner.sendTransaction = vi.fn().mockResolvedValue("0xdeploy");
      mockSigner.waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "reverted" });
      const facilitator = new ExactEvmSchemeV1(mockSigner, {
        eip6492AllowedFactories: [FACTORY],
      });
      const result = await facilitator.settle(makePayload() as never, requirements as never);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrSmartWalletDeploymentFailed);
      expect(mockSigner.writeContract).not.toHaveBeenCalled();
    });

    it("deploys then settles when the factory is allowlisted", async () => {
      mockSigner.getCode = vi.fn().mockResolvedValue("0x");
      mockSigner.sendTransaction = vi.fn().mockResolvedValue("0xdeploy");
      mockSigner.waitForTransactionReceipt = vi
        .fn()
        .mockResolvedValueOnce({ status: "success" })
        .mockResolvedValueOnce({ status: "success" });
      const facilitator = new ExactEvmSchemeV1(mockSigner, {
        eip6492AllowedFactories: [FACTORY],
      });
      const result = await facilitator.settle(makePayload() as never, requirements as never);
      expect(result.success).toBe(true);
      expect(mockSigner.sendTransaction).toHaveBeenCalled();
      expect(mockSigner.writeContract).toHaveBeenCalled();
    });

    it("maps a non-Error settle throw to transaction_failed", async () => {
      mockSigner.getCode = vi.fn().mockResolvedValue("0x6080604052");
      mockSigner.writeContract = vi.fn().mockRejectedValue("boom");
      const facilitator = new ExactEvmSchemeV1(mockSigner);
      const result = await facilitator.settle(makePayload() as never, requirements as never);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrTransactionFailed);
    });

    it("rejects settle when verify saw a deployed wallet but settle's getCode reports undeployed", async () => {
      let payerLookups = 0;
      mockSigner.getCode = vi.fn().mockImplementation(() => {
        payerLookups += 1;
        return Promise.resolve(payerLookups <= 2 ? "0x6080604052" : "0x");
      });
      mockSigner.sendTransaction = vi.fn();
      const facilitator = new ExactEvmSchemeV1(mockSigner, { eip6492AllowedFactories: [] });
      const result = await facilitator.settle(makePayload() as never, requirements as never);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrFactoryNotAllowed);
      expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe("metadata", () => {
    it("exposes getExtra as undefined and getSigners from the facilitator signer", () => {
      const facilitator = new ExactEvmSchemeV1({
        ...mockSigner,
        getAddresses: () => ["0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"],
      });
      expect(facilitator.getExtra("base-sepolia")).toBeUndefined();
      expect(facilitator.getSigners("base-sepolia")).toEqual([
        "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      ]);
    });
  });
});
