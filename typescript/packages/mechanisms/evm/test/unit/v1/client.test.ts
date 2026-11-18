import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExactEvmSchemeV1 } from "../../../src/exact/v1";
import type { ClientEvmSigner } from "../../../src/signer";
import type { PaymentRequirementsV1 } from "@x402/core/types/v1";

describe("ExactEvmSchemeV1", () => {
  let mockSigner: ClientEvmSigner;

  beforeEach(() => {
    mockSigner = {
      address: "0x1234567890123456789012345678901234567890",
      signTypedData: vi.fn().mockResolvedValue("0xmocksignature"),
    };
  });

  describe("constructor", () => {
    it("should create instance with correct scheme", () => {
      const client = new ExactEvmSchemeV1(mockSigner);
      expect(client.scheme).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it("should create V1 payment payload with scheme and network fields", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);

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

      const payload = await client.createPaymentPayload(1, requirements as never);

      expect(payload.x402Version).toBe(1);
      expect(payload.scheme).toBe("exact");
      expect(payload.network).toBe("base-sepolia");
      expect(payload.payload).toBeDefined();
      expect(payload.payload.authorization).toBeDefined();
      expect(payload.payload.signature).toBe("0xmocksignature");
    });

    it("should use maxAmountRequired from V1 requirements", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "500000", // V1 uses maxAmountRequired
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: {
          name: "USDC",
          version: "2",
        },
      };

      const payload = await client.createPaymentPayload(1, requirements as never);

      expect(payload.payload.authorization.value).toBe("500000");
    });

    it("should set correct authorization fields", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);

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

      const payload = await client.createPaymentPayload(1, requirements as never);

      expect(payload.payload.authorization.from).toBe(mockSigner.address);
      expect(payload.payload.authorization.to).toBe("0x9876543210987654321098765432109876543210");
      expect(payload.payload.authorization.value).toBe("100000");
      expect(payload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("should set validAfter to 10 minutes before now", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);
      const now = Math.floor(Date.now() / 1000);

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

      const payload = await client.createPaymentPayload(1, requirements as never);
      const validAfter = parseInt(payload.payload.authorization.validAfter);

      expect(validAfter).toBeGreaterThanOrEqual(now - 600 - 2); // Allow 2 second tolerance
      expect(validAfter).toBeLessThanOrEqual(now - 600 + 2);
    });

    it("should set validBefore based on maxTimeoutSeconds", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);
      const now = Math.floor(Date.now() / 1000);

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 7200,
        extra: {
          name: "USDC",
          version: "2",
        },
      };

      const payload = await client.createPaymentPayload(1, requirements as never);
      const validBefore = parseInt(payload.payload.authorization.validBefore);

      expect(validBefore).toBeGreaterThanOrEqual(now + 7200 - 2);
      expect(validBefore).toBeLessThanOrEqual(now + 7200 + 2);
    });

    it("should throw if EIP-712 domain parameters are missing", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: {}, // Missing name and version
      };

      await expect(client.createPaymentPayload(1, requirements as never)).rejects.toThrow(
        "EIP-712 domain parameters",
      );
    });

    it("should call signTypedData with correct parameters", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);

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

      await client.createPaymentPayload(1, requirements as never);

      expect(mockSigner.signTypedData).toHaveBeenCalled();
      const callArgs = (mockSigner.signTypedData as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(callArgs.domain.name).toBe("USDC");
      expect(callArgs.domain.version).toBe("2");
      expect(callArgs.domain.chainId).toBe(84532); // Base Sepolia
      expect(callArgs.primaryType).toBe("TransferWithAuthorization");
    });

    it("should throw for unsupported network", async () => {
      const client = new ExactEvmSchemeV1(mockSigner);

      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: "unknown-network",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        maxAmountRequired: "100000",
        payTo: "0x9876543210987654321098765432109876543210",
        maxTimeoutSeconds: 3600,
        extra: {
          name: "USDC",
          version: "2",
        },
      };

      await expect(client.createPaymentPayload(1, requirements as never)).rejects.toThrow(
        "Unsupported v1 network: unknown-network",
      );
    });
  });
});
