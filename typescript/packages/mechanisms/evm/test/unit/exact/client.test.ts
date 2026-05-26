import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactEvmScheme } from "../../../src/exact/client/scheme";
import {
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from "../../../src/exact/client/permit2";
import type { ClientEvmSigner } from "../../../src/signer";
import { PaymentRequirements } from "@x402/core/types";
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from "../../../src/constants";
import { isPermit2Payload, isEIP3009Payload } from "../../../src/types";

describe("ExactEvmScheme (Client)", () => {
  let client: ExactEvmScheme;
  let mockSigner: ClientEvmSigner;

  beforeEach(() => {
    // Create mock signer with readContract (required for ClientEvmSigner)
    mockSigner = {
      address: "0x1234567890123456789012345678901234567890",
      signTypedData: vi.fn().mockResolvedValue("0xmocksignature123456789"),
      readContract: vi.fn().mockResolvedValue(BigInt(0)),
    };
    client = new ExactEvmScheme(mockSigner);
  });

  describe("Construction", () => {
    it("should create instance with signer", () => {
      expect(client).toBeDefined();
      expect(client.scheme).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it("should create payment payload with EIP-3009 authorization", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD Coin",
          version: "2",
        },
      };

      const result = await client.createPaymentPayload(2, requirements);

      expect(result.x402Version).toBe(2);
      expect(result.payload).toBeDefined();
      expect(result.payload.authorization).toBeDefined();
      expect(result.payload.signature).toBeDefined();
    });

    it("should generate valid nonce", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      const result1 = await client.createPaymentPayload(2, requirements);
      const result2 = await client.createPaymentPayload(2, requirements);

      // Nonces should be different
      expect(result1.payload.authorization.nonce).not.toBe(result2.payload.authorization.nonce);

      // Nonce should be 32 bytes hex string
      expect(result1.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it("should set validAfter to 10 minutes before current time", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      const beforeTime = Math.floor(Date.now() / 1000) - 600;
      const result = await client.createPaymentPayload(2, requirements);
      const afterTime = Math.floor(Date.now() / 1000) - 600;

      const validAfter = parseInt(result.payload.authorization.validAfter);

      expect(validAfter).toBeGreaterThanOrEqual(beforeTime);
      expect(validAfter).toBeLessThanOrEqual(afterTime + 1); // Allow 1 second tolerance
    });

    it("should set validBefore based on maxTimeoutSeconds", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 600, // 10 minutes
        extra: { name: "USD Coin", version: "2" },
      };

      const beforeTime = Math.floor(Date.now() / 1000) + 600;
      const result = await client.createPaymentPayload(2, requirements);
      const afterTime = Math.floor(Date.now() / 1000) + 600;

      const validBefore = parseInt(result.payload.authorization.validBefore);

      expect(validBefore).toBeGreaterThanOrEqual(beforeTime);
      expect(validBefore).toBeLessThanOrEqual(afterTime + 1);
    });

    it("should use signer's address as from", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      const result = await client.createPaymentPayload(2, requirements);

      expect(result.payload.authorization.from).toBe(mockSigner.address);
    });

    it("should use requirements.payTo as to", async () => {
      const payToAddress = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0";

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: payToAddress,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      const result = await client.createPaymentPayload(2, requirements);

      expect(result.payload.authorization.to.toLowerCase()).toBe(payToAddress.toLowerCase());
    });

    it("should use requirements.amount as value", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "2500000", // 2.5 USDC
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      const result = await client.createPaymentPayload(2, requirements);

      expect(result.payload.authorization.value).toBe("2500000");
    });

    it("should call signTypedData on signer", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      const result = await client.createPaymentPayload(2, requirements);

      // Should have called signTypedData
      expect(mockSigner.signTypedData).toHaveBeenCalled();
      expect(result.payload.signature).toBeDefined();
    });

    it("should handle different networks", async () => {
      const ethereumRequirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:1", // Ethereum mainnet
        amount: "1000000",
        asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      const result = await client.createPaymentPayload(2, ethereumRequirements);

      expect(result.x402Version).toBe(2);
      expect(result.payload.authorization).toBeDefined();
    });

    it("should pass correct EIP-712 domain to signTypedData", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };

      await client.createPaymentPayload(2, requirements);

      // Verify signTypedData was called with domain params
      expect(mockSigner.signTypedData).toHaveBeenCalled();
      const callArgs = (mockSigner.signTypedData as any).mock.calls[0][0];
      expect(callArgs.domain.name).toBe("USD Coin");
      expect(callArgs.domain.version).toBe("2");
      expect(callArgs.domain.chainId).toBe(8453);
    });

    describe("with assetTransferMethod", () => {
      it("should default to EIP-3009 when assetTransferMethod is not set", async () => {
        const requirements: PaymentRequirements = {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        };

        const result = await client.createPaymentPayload(2, requirements);

        expect(isEIP3009Payload(result.payload)).toBe(true);
        expect(isPermit2Payload(result.payload)).toBe(false);
        expect(result.payload.authorization).toBeDefined();
      });

      it("should use EIP-3009 when assetTransferMethod is eip3009", async () => {
        const requirements: PaymentRequirements = {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
        };

        const result = await client.createPaymentPayload(2, requirements);

        expect(isEIP3009Payload(result.payload)).toBe(true);
        expect(result.payload.authorization).toBeDefined();
      });

      it("should use Permit2 when assetTransferMethod is permit2", async () => {
        const requirements: PaymentRequirements = {
          scheme: "exact",
          network: "eip155:8453",
          amount: "1000000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
        };

        const result = await client.createPaymentPayload(2, requirements);

        expect(isPermit2Payload(result.payload)).toBe(true);
        expect(isEIP3009Payload(result.payload)).toBe(false);
        expect(result.payload.permit2Authorization).toBeDefined();
      });
    });
  });

  describe("createPaymentPayload with Permit2", () => {
    it("should create Permit2 payload with correct structure", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2" },
      };

      const result = await client.createPaymentPayload(2, requirements);
      const payload = result.payload;

      expect(isPermit2Payload(payload)).toBe(true);
      expect(payload.signature).toBeDefined();
      expect(payload.permit2Authorization).toBeDefined();
      expect(payload.permit2Authorization.permitted).toBeDefined();
      expect(payload.permit2Authorization.witness).toBeDefined();
    });

    it("should set spender to x402ExactPermit2ProxyAddress", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2" },
      };

      const result = await client.createPaymentPayload(2, requirements);

      expect(isPermit2Payload(result.payload)).toBe(true);
      expect(result.payload.permit2Authorization.spender).toBe(x402ExactPermit2ProxyAddress);
    });

    it("should set witness.to to payTo address", async () => {
      const payToAddress = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0";
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: payToAddress,
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2" },
      };

      const result = await client.createPaymentPayload(2, requirements);

      expect(isPermit2Payload(result.payload)).toBe(true);
      expect(result.payload.permit2Authorization.witness.to.toLowerCase()).toBe(
        payToAddress.toLowerCase(),
      );
    });

    it("should use Permit2 EIP-712 domain for signing", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2" },
      };

      await client.createPaymentPayload(2, requirements);

      const callArgs = (mockSigner.signTypedData as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.domain.name).toBe("Permit2");
      expect(callArgs.domain.verifyingContract).toBe(PERMIT2_ADDRESS);
      expect(callArgs.primaryType).toBe("PermitWitnessTransferFrom");
    });
  });
});

describe("Permit2 Approval Helpers", () => {
  describe("createPermit2ApprovalTx", () => {
    it("should create approval transaction data", () => {
      const tokenAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
      const tx = createPermit2ApprovalTx(tokenAddress);

      expect(tx.to.toLowerCase()).toBe(tokenAddress.toLowerCase());
      expect(tx.data).toBeDefined();
      expect(tx.data).toMatch(/^0x/);
    });

    it("should encode approve function call", () => {
      const tokenAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
      const tx = createPermit2ApprovalTx(tokenAddress);

      // approve(address,uint256) selector is 0x095ea7b3
      expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
    });
  });

  describe("getPermit2AllowanceReadParams", () => {
    it("should return correct read parameters", () => {
      const params = getPermit2AllowanceReadParams({
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ownerAddress: "0x1234567890123456789012345678901234567890",
      });

      expect(params.address.toLowerCase()).toBe(
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".toLowerCase(),
      );
      expect(params.functionName).toBe("allowance");
      expect(params.args[0].toLowerCase()).toBe(
        "0x1234567890123456789012345678901234567890".toLowerCase(),
      );
      expect(params.args[1]).toBe(PERMIT2_ADDRESS);
    });

    it("should include allowance ABI", () => {
      const params = getPermit2AllowanceReadParams({
        tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ownerAddress: "0x1234567890123456789012345678901234567890",
      });

      expect(params.abi).toBeDefined();
      expect(params.abi[0].name).toBe("allowance");
    });
  });
});

/**
 * Tests for the Permit2 approval flow pattern.
 * These tests demonstrate how apps should check allowance and handle approval.
 */
describe("Permit2 Approval Flow", () => {
  /**
   * Helper to simulate checking allowance and determining if approval is needed.
   * This mirrors what an app would do with a real publicClient.
   */
  function checkNeedsApproval(currentAllowance: bigint, requiredAmount: bigint): boolean {
    return currentAllowance < requiredAmount;
  }

  describe("Allowance Check Logic", () => {
    it("should detect when approval is needed (zero allowance)", () => {
      const currentAllowance = BigInt(0);
      const requiredAmount = BigInt("1000000"); // 1 USDC

      expect(checkNeedsApproval(currentAllowance, requiredAmount)).toBe(true);
    });

    it("should detect when approval is needed (insufficient allowance)", () => {
      const currentAllowance = BigInt("500000"); // 0.5 USDC
      const requiredAmount = BigInt("1000000"); // 1 USDC

      expect(checkNeedsApproval(currentAllowance, requiredAmount)).toBe(true);
    });

    it("should detect when approval is NOT needed (exact allowance)", () => {
      const currentAllowance = BigInt("1000000"); // 1 USDC
      const requiredAmount = BigInt("1000000"); // 1 USDC

      expect(checkNeedsApproval(currentAllowance, requiredAmount)).toBe(false);
    });

    it("should detect when approval is NOT needed (excess allowance)", () => {
      const currentAllowance = BigInt("10000000"); // 10 USDC
      const requiredAmount = BigInt("1000000"); // 1 USDC

      expect(checkNeedsApproval(currentAllowance, requiredAmount)).toBe(false);
    });

    it("should detect when approval is NOT needed (max uint256 allowance)", () => {
      const maxUint256 = BigInt(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      );
      const requiredAmount = BigInt("1000000000000"); // Large amount

      expect(checkNeedsApproval(maxUint256, requiredAmount)).toBe(false);
    });
  });

  describe("Full Approval Flow Simulation", () => {
    const tokenAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
    const ownerAddress = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const requiredAmount = BigInt("1000000");

    /**
     * Simulates the full approval flow an app would implement.
     * Returns the steps taken and whether approval was triggered.
     */
    async function simulateApprovalFlow(
      mockAllowance: bigint,
      mockSendTransaction: () => Promise<`0x${string}`>,
    ): Promise<{
      checkedAllowance: boolean;
      approvalSent: boolean;
      approvalTxHash?: `0x${string}`;
    }> {
      const result = {
        checkedAllowance: false,
        approvalSent: false,
        approvalTxHash: undefined as `0x${string}` | undefined,
      };

      // Step 1: Get read params for allowance check
      const readParams = getPermit2AllowanceReadParams({
        tokenAddress,
        ownerAddress,
      });
      expect(readParams).toBeDefined();

      // Step 2: Simulate reading allowance (would be publicClient.readContract in real app)
      const currentAllowance = mockAllowance;
      result.checkedAllowance = true;

      // Step 3: Check if approval needed
      if (checkNeedsApproval(currentAllowance, requiredAmount)) {
        // Step 4: Create approval transaction
        const tx = createPermit2ApprovalTx(tokenAddress);
        expect(tx.to).toBeDefined();
        expect(tx.data).toBeDefined();

        // Step 5: Send transaction (would be walletClient.sendTransaction in real app)
        result.approvalTxHash = await mockSendTransaction();
        result.approvalSent = true;
      }

      return result;
    }

    it("should trigger approval when allowance is zero", async () => {
      const mockTxHash = "0xabc123" as `0x${string}`;
      const result = await simulateApprovalFlow(BigInt(0), async () => mockTxHash);

      expect(result.checkedAllowance).toBe(true);
      expect(result.approvalSent).toBe(true);
      expect(result.approvalTxHash).toBe(mockTxHash);
    });

    it("should trigger approval when allowance is insufficient", async () => {
      const mockTxHash = "0xdef456" as `0x${string}`;
      const result = await simulateApprovalFlow(BigInt("500000"), async () => mockTxHash);

      expect(result.checkedAllowance).toBe(true);
      expect(result.approvalSent).toBe(true);
      expect(result.approvalTxHash).toBe(mockTxHash);
    });

    it("should skip approval when allowance is sufficient", async () => {
      const result = await simulateApprovalFlow(BigInt("10000000"), async () => {
        throw new Error("Should not send transaction");
      });

      expect(result.checkedAllowance).toBe(true);
      expect(result.approvalSent).toBe(false);
      expect(result.approvalTxHash).toBeUndefined();
    });

    it("should skip approval when allowance is max uint256", async () => {
      const maxUint256 = BigInt(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      );
      const result = await simulateApprovalFlow(maxUint256, async () => {
        throw new Error("Should not send transaction");
      });

      expect(result.checkedAllowance).toBe(true);
      expect(result.approvalSent).toBe(false);
    });
  });

  describe("Approval + Permit2 Payload Creation Flow", () => {
    let mockSigner: ClientEvmSigner;
    let client: ExactEvmScheme;

    beforeEach(() => {
      mockSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksignature123456789"),
      };
      client = new ExactEvmScheme(mockSigner);
    });

    it("should complete full flow: check allowance -> approve -> create payload", async () => {
      const tokenAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: tokenAddress,
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2" },
      };

      // Step 1: Check allowance (simulated as zero)
      const readParams = getPermit2AllowanceReadParams({
        tokenAddress,
        ownerAddress: mockSigner.address,
      });
      expect(readParams.functionName).toBe("allowance");

      const mockAllowance = BigInt(0);
      const needsApproval = mockAllowance < BigInt(requirements.amount);
      expect(needsApproval).toBe(true);

      // Step 2: Create and "send" approval tx
      const approvalTx = createPermit2ApprovalTx(tokenAddress);
      expect(approvalTx.to.toLowerCase()).toBe(tokenAddress.toLowerCase());
      // In real app: await walletClient.sendTransaction(approvalTx)

      // Step 3: Create Permit2 payload (after approval)
      const result = await client.createPaymentPayload(2, requirements);

      expect(isPermit2Payload(result.payload)).toBe(true);
      expect(result.payload.permit2Authorization).toBeDefined();
      expect(result.payload.signature).toBeDefined();
    });

    it("should skip approval and directly create payload when already approved", async () => {
      const tokenAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000000",
        asset: tokenAddress,
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2" },
      };

      // Step 1: Check allowance (simulated as max uint256 - already approved)
      const maxUint256 = BigInt(
        "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      );
      const needsApproval = maxUint256 < BigInt(requirements.amount);
      expect(needsApproval).toBe(false);

      // Step 2: Skip approval, directly create payload
      const result = await client.createPaymentPayload(2, requirements);

      expect(isPermit2Payload(result.payload)).toBe(true);
      expect(result.payload.permit2Authorization).toBeDefined();
    });
  });

  describe("EIP-2612 Gas Sponsoring (Scheme-level)", () => {
    const permit2Requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "permit2",
        name: "USDC",
        version: "2",
      },
    };

    it("should not return extensions when eip2612GasSponsoring not in context", async () => {
      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)),
      };
      const scheme = new ExactEvmScheme(signer);
      const result = await scheme.createPaymentPayload(2, permit2Requirements, {
        extensions: {},
      });

      expect(result.extensions).toBeUndefined();
    });

    it("should not return extensions when allowance is sufficient", async () => {
      const signerWithReader: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt("999999999999999999")),
      };
      const schemeWithReader = new ExactEvmScheme(signerWithReader);

      const result = await schemeWithReader.createPaymentPayload(2, permit2Requirements, {
        extensions: {
          eip2612GasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      expect(result.extensions).toBeUndefined();
    });

    it("should return EIP-2612 extensions when allowance insufficient and extension advertised", async () => {
      const signerWithReader: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue(
          "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b", // 65 byte sig
        ),
        readContract: vi
          .fn()
          .mockResolvedValueOnce(BigInt(0)) // allowance check returns 0
          .mockResolvedValueOnce(BigInt(5)), // nonce query returns 5
      };
      const schemeWithReader = new ExactEvmScheme(signerWithReader);

      const result = await schemeWithReader.createPaymentPayload(2, permit2Requirements, {
        extensions: {
          eip2612GasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      expect(result.extensions).toBeDefined();
      expect(result.extensions!.eip2612GasSponsoring).toBeDefined();
      const ext = result.extensions!.eip2612GasSponsoring as Record<string, unknown>;
      const info = ext.info as Record<string, unknown>;
      expect(info.from).toBe("0x1234567890123456789012345678901234567890");
      expect(info.spender).toBeDefined();
      expect(info.signature).toBeDefined();
      expect(info.version).toBe("1");
    });

    it("should not return extensions for EIP-3009 asset transfer method", async () => {
      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)),
      };
      const scheme = new ExactEvmScheme(signer);
      const eip3009Requirements: PaymentRequirements = {
        ...permit2Requirements,
        extra: {
          name: "USDC",
          version: "2",
        },
      };

      const result = await scheme.createPaymentPayload(2, eip3009Requirements, {
        extensions: {
          eip2612GasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      expect(result.extensions).toBeUndefined();
    });
  });

  describe("ERC-20 Approval Gas Sponsoring (Scheme-level)", () => {
    const erc20Requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0xeED520980fC7C7B4eB379B96d61CEdea2423005a",
      payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      maxTimeoutSeconds: 60,
      extra: {
        assetTransferMethod: "permit2",
        // No name/version - generic ERC-20 without EIP-2612
      },
    };

    it("should not return extensions when erc20ApprovalGasSponsoring not in context", async () => {
      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)),
        signTransaction: vi.fn().mockResolvedValue("0x02ab"),
        getTransactionCount: vi.fn().mockResolvedValue(0),
        estimateFeesPerGas: vi
          .fn()
          .mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      };
      const scheme = new ExactEvmScheme(signer);
      const result = await scheme.createPaymentPayload(2, erc20Requirements, {
        extensions: {}, // No erc20ApprovalGasSponsoring
      });

      expect(result.extensions).toBeUndefined();
    });

    it("should not return extensions when allowance is sufficient", async () => {
      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt("999999999999999999")),
        signTransaction: vi.fn().mockResolvedValue("0x02ab"),
        getTransactionCount: vi.fn().mockResolvedValue(0),
        estimateFeesPerGas: vi
          .fn()
          .mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      };
      const scheme = new ExactEvmScheme(signer);
      const result = await scheme.createPaymentPayload(2, erc20Requirements, {
        extensions: {
          erc20ApprovalGasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      expect(result.extensions).toBeUndefined();
    });

    it("should not return extensions when signer lacks signTransaction capability", async () => {
      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)),
        // No signTransaction, getTransactionCount, estimateFeesPerGas
      };
      const scheme = new ExactEvmScheme(signer);
      const result = await scheme.createPaymentPayload(2, erc20Requirements, {
        extensions: {
          erc20ApprovalGasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      expect(result.extensions).toBeUndefined();
    });

    it("should return ERC-20 extensions when allowance insufficient + extension advertised + signer capable", async () => {
      const mockSignedTx = "0x02f8ab" as `0x${string}`;
      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)), // zero allowance
        signTransaction: vi.fn().mockResolvedValue(mockSignedTx),
        getTransactionCount: vi.fn().mockResolvedValue(5),
        estimateFeesPerGas: vi
          .fn()
          .mockResolvedValue({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n }),
      };
      const scheme = new ExactEvmScheme(signer);
      const result = await scheme.createPaymentPayload(2, erc20Requirements, {
        extensions: {
          erc20ApprovalGasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      expect(result.extensions).toBeDefined();
      expect(result.extensions!.erc20ApprovalGasSponsoring).toBeDefined();
      const ext = result.extensions!.erc20ApprovalGasSponsoring as Record<string, unknown>;
      const info = ext.info as Record<string, unknown>;
      expect(info.from).toBe("0x1234567890123456789012345678901234567890");
      expect(info.spender).toBeDefined();
      expect(info.signedTransaction).toBe(mockSignedTx);
      expect(info.version).toBe("1");
    });

    it("should use EIP-2612 over ERC-20 approval when token has EIP-2612 support", async () => {
      const eip2612CompatibleRequirements: PaymentRequirements = {
        ...erc20Requirements,
        extra: {
          assetTransferMethod: "permit2",
          name: "TOKEN",
          version: "1",
        },
      };

      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0x" + "ab".repeat(32) + "cd".repeat(32) + "1b"),
        readContract: vi
          .fn()
          .mockResolvedValueOnce(BigInt(0)) // allowance check
          .mockResolvedValueOnce(BigInt(3)), // nonce for EIP-2612
        signTransaction: vi.fn(), // Should NOT be called
        getTransactionCount: vi.fn(),
        estimateFeesPerGas: vi.fn(),
      };
      const scheme = new ExactEvmScheme(signer);

      const result = await scheme.createPaymentPayload(2, eip2612CompatibleRequirements, {
        extensions: {
          eip2612GasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
          erc20ApprovalGasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      // Should have EIP-2612 extension (not ERC-20 approval)
      expect(result.extensions).toBeDefined();
      expect(result.extensions!.eip2612GasSponsoring).toBeDefined();
      expect(result.extensions!.erc20ApprovalGasSponsoring).toBeUndefined();
      // signTransaction should NOT have been called
      expect(signer.signTransaction).not.toHaveBeenCalled();
    });

    it("should use ERC-20 approval when EIP-2612 not advertised but ERC-20 is", async () => {
      const mockSignedTx = "0x02f8ab" as `0x${string}`;
      const signer: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xmocksig"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)), // zero allowance
        signTransaction: vi.fn().mockResolvedValue(mockSignedTx),
        getTransactionCount: vi.fn().mockResolvedValue(0),
        estimateFeesPerGas: vi
          .fn()
          .mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      };
      const scheme = new ExactEvmScheme(signer);

      const result = await scheme.createPaymentPayload(2, erc20Requirements, {
        extensions: {
          // Only ERC-20, no EIP-2612
          erc20ApprovalGasSponsoring: { info: { description: "test", version: "1" }, schema: {} },
        },
      });

      expect(result.extensions).toBeDefined();
      expect(result.extensions!.erc20ApprovalGasSponsoring).toBeDefined();
      expect(result.extensions!.eip2612GasSponsoring).toBeUndefined();
    });
  });
});
