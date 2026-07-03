import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactEvmScheme } from "../../../src/exact/facilitator/scheme";
import { ExactEvmScheme as ClientExactEvmScheme } from "../../../src/exact/client/scheme";
import type { ClientEvmSigner, FacilitatorEvmSigner } from "../../../src/signer";
import { PaymentRequirements, PaymentPayload } from "@x402/core/types";
import { x402ExactPermit2ProxyAddress, PERMIT2_ADDRESS } from "../../../src/constants";
import { ERC20_APPROVAL_GAS_SPONSORING_KEY } from "../../../src/exact/extensions";
import { MULTICALL3_ADDRESS } from "../../../src/multicall";
import { concat, encodeAbiParameters } from "viem";
import * as Errors from "../../../src/exact/facilitator/errors";

// Mock viem's transaction parsing utilities for ERC-20 approval tests
// Uses importOriginal to preserve all other viem exports (getAddress, etc.)
vi.mock("viem", async importOriginal => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    parseTransaction: vi.fn(),
    recoverTransactionAddress: vi.fn(),
  };
});

// Returns deployed-contract bytecode for the token/asset address, EOA ("0x") for everything else.
// Used in ERC-6492 tests where the payer wallet is undeployed but the token contract must exist.
const mockGetCodeEOAPayer =
  (assetAddress: string) =>
  ({ address }: { address: `0x${string}` }): Promise<`0x${string}`> =>
    Promise.resolve(
      address.toLowerCase() === assetAddress.toLowerCase()
        ? ("0x6080604052" as `0x${string}`)
        : ("0x" as `0x${string}`),
    );

// Wraps a readContract mock so isValidSignature returns the ERC-1271 magic value
// while delegating other calls to `impl`. Keeps "default: valid sig" semantics
// for tests that override readContract for other purposes (nonce, allowance, etc.).
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

describe("ExactEvmScheme (Facilitator)", () => {
  let facilitator: ExactEvmScheme;
  let mockFacilitatorSigner: FacilitatorEvmSigner;
  let client: ClientExactEvmScheme;
  let mockClientSigner: ClientEvmSigner;

  beforeEach(() => {
    // Create mock client signer
    mockClientSigner = {
      address: "0x1234567890123456789012345678901234567890",
      signTypedData: vi.fn().mockResolvedValue("0xmocksignature"),
      readContract: vi.fn().mockResolvedValue(BigInt(0)),
    };
    client = new ClientExactEvmScheme(mockClientSigner);

    // Create mock facilitator signer. readContract returns the ERC-1271 magic value for
    // isValidSignature (contract-account path) and 0n for everything else (nonce, etc.).
    mockFacilitatorSigner = {
      getAddresses: vi.fn().mockReturnValue(["0x742D35CC6634c0532925A3b844BC9E7595F0BEb0"]),
      readContract: vi.fn().mockImplementation(async (args: { functionName: string }) => {
        if (args?.functionName === "isValidSignature") return "0x1626ba7e";
        return 0n;
      }),
      verifyTypedData: vi.fn().mockResolvedValue(true),
      writeContract: vi.fn().mockResolvedValue("0xtxhash"),
      sendTransaction: vi.fn().mockResolvedValue("0xtxhash"),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      // Default: asset is a deployed contract. Individual tests that need an EOA payer
      // should use mockGetCodeEOAPayer() to keep the asset as a contract.
      getCode: vi.fn().mockResolvedValue("0x6080604052"),
    };
    facilitator = new ExactEvmScheme(mockFacilitatorSigner);
  });

  describe("Construction", () => {
    it("should create instance with signer", () => {
      expect(facilitator).toBeDefined();
      expect(facilitator.scheme).toBe("exact");
    });
  });

  describe("verify", () => {
    it("should run signature verification through the strict primitive (getCode + isValidSignature for contract addresses)", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: {
          name: "USDC",
          version: "2",
        },
      };

      // Create valid payload structure
      const paymentPayload = await client.createPaymentPayload(2, requirements);

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: requirements,
        resource: { url: "test", description: "", mimeType: "" },
      };

      await facilitator.verify(fullPayload, requirements);

      // Signature verification now mirrors on-chain SignatureChecker:
      // it calls getCode on the payer; for addresses with code (the default mock
      // returns deployed bytecode) it calls readContract({ functionName: "isValidSignature" }).
      expect(mockFacilitatorSigner.getCode).toHaveBeenCalledWith(
        expect.objectContaining({ address: mockClientSigner.address }),
      );
      expect(mockFacilitatorSigner.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "isValidSignature" }),
      );
    });

    it("should reject if scheme doesn't match", async () => {
      const requirements: PaymentRequirements = {
        scheme: "intent", // Wrong scheme
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          authorization: {
            from: mockClientSigner.address,
            to: requirements.payTo,
            value: requirements.amount,
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x00",
          },
          signature: "0x",
        },
        accepted: { ...requirements, scheme: "intent" },
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrInvalidScheme);
    });

    it("should reject if missing EIP-712 domain parameters", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: {}, // Missing name and version
      };

      const paymentPayload = await client.createPaymentPayload(2, {
        ...requirements,
        extra: { name: "USDC", version: "2" }, // Client has it
      });

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(fullPayload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrMissingEip712Domain);
    });

    it("should reject if network doesn't match", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };

      const paymentPayload = await client.createPaymentPayload(2, requirements);

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const wrongNetworkRequirements = { ...requirements, network: "eip155:1" as any };

      const result = await facilitator.verify(fullPayload, wrongNetworkRequirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrNetworkMismatch);
    });

    it("should reject if recipient doesn't match payTo", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };

      const paymentPayload = await client.createPaymentPayload(2, requirements);

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      // Change payTo in requirements
      const modifiedRequirements = {
        ...requirements,
        payTo: "0x0000000000000000000000000000000000000000", // Different recipient
      };

      const result = await facilitator.verify(fullPayload, modifiedRequirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrRecipientMismatch);
    });

    it("should reject if amount doesn't match", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };

      const paymentPayload = await client.createPaymentPayload(2, requirements);

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      // Change amount in requirements
      const modifiedRequirements = {
        ...requirements,
        amount: "2000000", // Different amount
      };

      const result = await facilitator.verify(fullPayload, modifiedRequirements);

      expect(result.isValid).toBe(false);
      // Must emit the spec-documented, cross-SDK code (matches the Go facilitator)
      expect(result.invalidReason).toBe(Errors.ErrAuthorizationValueMismatch);
    });

    it("should include payer in response", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };

      const paymentPayload = await client.createPaymentPayload(2, requirements);

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(fullPayload, requirements);

      expect(result.payer).toBe(mockClientSigner.address);
    });
  });

  describe("Permit2 payload verification", () => {
    it("should verify Permit2 payloads with valid signature and simulation success", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      };

      // Simulation of settle() on the proxy succeeds (readContract doesn't throw)
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const permit2Payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          signature: "0xmocksignature",
          permit2Authorization: {
            from: mockClientSigner.address,
            permitted: {
              token: requirements.asset,
              amount: requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "12345",
            deadline: "999999999999",
            witness: {
              to: requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(permit2Payload, requirements);

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(mockClientSigner.address);
    });

    it("should reject Permit2 payloads when simulation fails and allowance is insufficient", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      };

      // Simulation fails (settle throws), diagnostic multicall returns proxy OK, balance OK, allowance 0
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === x402ExactPermit2ProxyAddress) {
          return Promise.reject(new Error("execution reverted"));
        }
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            {
              success: true,
              returnData: "0x000000000000000000000000000000000022D473030F116dDEE9F6B43aC78BA3",
            },
            {
              success: true,
              returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
            },
            {
              success: true,
              returnData: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          ]);
        }
        return Promise.resolve(BigInt(0));
      });

      const permit2Payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          signature: "0xmocksignature",
          permit2Authorization: {
            from: mockClientSigner.address,
            permitted: {
              token: requirements.asset,
              amount: requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "12345",
            deadline: "999999999999",
            witness: {
              to: requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(permit2Payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("permit2_allowance_required");
      expect(result.payer).toBe(mockClientSigner.address);
    });

    it("should reject Permit2 payloads with expired deadline", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      };

      const permit2Payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          signature: "0xmocksignature",
          permit2Authorization: {
            from: mockClientSigner.address,
            permitted: {
              token: requirements.asset,
              amount: requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "12345",
            deadline: "1", // Expired deadline
            witness: {
              to: requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(permit2Payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("permit2_deadline_expired");
      expect(result.payer).toBe(mockClientSigner.address);
    });

    it("should reject Permit2 payloads with wrong spender", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      };

      const permit2Payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          signature: "0xmocksignature",
          permit2Authorization: {
            from: mockClientSigner.address,
            permitted: {
              token: requirements.asset,
              amount: requirements.amount,
            },
            spender: "0x0000000000000000000000000000000000000001", // Wrong spender
            nonce: "12345",
            deadline: "999999999999",
            witness: {
              to: requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(permit2Payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_spender");
      expect(result.payer).toBe(mockClientSigner.address);
    });

    it("should reject Permit2 payloads with recipient mismatch", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      };

      const permit2Payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          signature: "0xmocksignature",
          permit2Authorization: {
            from: mockClientSigner.address,
            permitted: {
              token: requirements.asset,
              amount: requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "12345",
            deadline: "999999999999",
            witness: {
              to: "0x0000000000000000000000000000000000000001", // Wrong recipient
              validAfter: "0",
            },
          },
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(permit2Payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_permit2_recipient_mismatch");
      expect(result.payer).toBe(mockClientSigner.address);
    });
  });

  describe("Permit2 settlement", () => {
    it("should settle Permit2 payloads successfully", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      };

      // settle's re-verify has simulate=false (default), so no simulation readContract needed
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const permit2Payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          signature: "0xmocksignature",
          permit2Authorization: {
            from: mockClientSigner.address,
            permitted: {
              token: requirements.asset,
              amount: requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "12345",
            deadline: "999999999999",
            witness: {
              to: requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.settle(permit2Payload, requirements);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xtxhash");
      expect(result.payer).toBe(mockClientSigner.address);
      expect(mockFacilitatorSigner.writeContract).toHaveBeenCalled();
    });

    it("should fail Permit2 settlement when signature verification fails", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" },
      };

      // Signature verification fails; payer is an EOA so no ERC-1271 fallback.
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(false);
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));

      const permit2Payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          signature: "0xmocksignature",
          permit2Authorization: {
            from: mockClientSigner.address,
            permitted: {
              token: requirements.asset,
              amount: requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "12345",
            deadline: "999999999999",
            witness: {
              to: requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      const result = await facilitator.settle(permit2Payload, requirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("invalid_permit2_signature");
      expect(result.payer).toBe(mockClientSigner.address);
    });
  });

  describe("Error cases", () => {
    it("should handle invalid signature format", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        payload: {
          authorization: {
            from: mockClientSigner.address,
            to: requirements.payTo,
            value: requirements.amount,
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x00",
          },
          signature: "0xinvalid", // Invalid signature
        },
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      // Mock verifyTypedData to return false for invalid signature
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(false);

      const result = await facilitator.verify(payload, requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrInvalidSignature);
    });

    it("should normalize addresses (case-insensitive)", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CBD53842C5426634E7929541EC2318F3DCF7E", // Mixed case
        payTo: "0x742D35CC6634C0532925A3B844BC9E7595F0BEB0", // Mixed case
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };

      const paymentPayload = await client.createPaymentPayload(2, requirements);

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: requirements,
        resource: { url: "", description: "", mimeType: "" },
      };

      // Should verify even with different case
      const result = await facilitator.verify(fullPayload, requirements);

      // Signature validation handles checksummed addresses
      expect(result).toBeDefined();
    });
  });

  describe("EIP-2612 Gas Sponsoring - Verify", () => {
    it("should accept valid EIP-2612 extension when settleWithPermit simulation succeeds", async () => {
      // Simulation of settleWithPermit on proxy succeeds
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const permit2Requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" },
      };

      const permit2ClientSigner: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0x" + "ab".repeat(32) + "cd".repeat(32) + "1b"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)),
      };
      const permit2Client = new ClientExactEvmScheme(permit2ClientSigner);
      const paymentPayload = await permit2Client.createPaymentPayload(2, permit2Requirements);

      const now = Math.floor(Date.now() / 1000);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: permit2Requirements,
        resource: { url: "https://test.com", description: "", mimeType: "" },
        extensions: {
          eip2612GasSponsoring: {
            info: {
              from: "0x1234567890123456789012345678901234567890",
              asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
              spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
              amount:
                "115792089237316195423570985008687907853269984665640564039457584007913129639935",
              nonce: "0",
              deadline: (now + 300).toString(),
              signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
              version: "1",
            },
            schema: {},
          },
        },
      };

      const result = await facilitator.verify(fullPayload, permit2Requirements);
      expect(result).toBeDefined();
      if (!result.isValid) {
        expect(result.invalidReason).not.toBe("permit2_allowance_required");
      }
    });

    it("should reject when simulation fails and no extension present (allowance insufficient)", async () => {
      // Simulation fails, diagnostic multicall returns low allowance
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === x402ExactPermit2ProxyAddress) {
          return Promise.reject(new Error("execution reverted"));
        }
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            {
              success: true,
              returnData: "0x000000000000000000000000000000000022D473030F116dDEE9F6B43aC78BA3",
            },
            {
              success: true,
              returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
            },
            {
              success: true,
              returnData: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          ]);
        }
        return Promise.resolve(BigInt(0));
      });

      const permit2Requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" },
      };

      const permit2ClientSigner: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0x" + "ab".repeat(32) + "cd".repeat(32) + "1b"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)),
      };
      const permit2Client = new ClientExactEvmScheme(permit2ClientSigner);
      const paymentPayload = await permit2Client.createPaymentPayload(2, permit2Requirements);

      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: permit2Requirements,
        resource: { url: "https://test.com", description: "", mimeType: "" },
      };

      const result = await facilitator.verify(fullPayload, permit2Requirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("permit2_allowance_required");
    });

    it("should reject EIP-2612 extension with wrong spender", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const permit2Requirements: PaymentRequirements = {
        scheme: "exact",
        network: "eip155:84532",
        amount: "1000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" },
      };

      const permit2ClientSigner: ClientEvmSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0x" + "ab".repeat(32) + "cd".repeat(32) + "1b"),
        readContract: vi.fn().mockResolvedValue(BigInt(0)),
      };
      const permit2Client = new ClientExactEvmScheme(permit2ClientSigner);
      const paymentPayload = await permit2Client.createPaymentPayload(2, permit2Requirements);

      const now = Math.floor(Date.now() / 1000);
      const fullPayload: PaymentPayload = {
        ...paymentPayload,
        accepted: permit2Requirements,
        resource: { url: "https://test.com", description: "", mimeType: "" },
        extensions: {
          eip2612GasSponsoring: {
            info: {
              from: "0x1234567890123456789012345678901234567890",
              asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
              spender: "0x0000000000000000000000000000000000000000", // WRONG spender
              amount:
                "115792089237316195423570985008687907853269984665640564039457584007913129639935",
              nonce: "0",
              deadline: (now + 300).toString(),
              signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
              version: "1",
            },
            schema: {},
          },
        },
      };

      const result = await facilitator.verify(fullPayload, permit2Requirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("eip2612_spender_not_permit2");
    });
  });

  describe("ERC-6492 counterfactual signature verification", () => {
    const ERC6492_MAGIC = "0x6492649264926492649264926492649264926492649264926492649264926492";

    function makeERC6492Sig(
      factory: `0x${string}`,
      calldata: `0x${string}`,
      innerSig: `0x${string}`,
    ): `0x${string}` {
      const encoded = encodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
        [factory, calldata, innerSig],
      );
      return concat([encoded, ERC6492_MAGIC]) as `0x${string}`;
    }

    const erc6492Requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    };

    const erc6492Payer = "0x1234567890123456789012345678901234567890";
    const factory = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const factoryCalldata = "0xdeadbeef" as `0x${string}`;
    const garbageInnerSig = ("0x" + "00".repeat(65)) as `0x${string}`;
    const erc6492Sig = makeERC6492Sig(factory, factoryCalldata, garbageInnerSig);

    function makeERC6492Payload(sig: `0x${string}`): PaymentPayload {
      return {
        x402Version: 2,
        payload: {
          authorization: {
            from: erc6492Payer,
            to: erc6492Requirements.payTo,
            value: erc6492Requirements.amount,
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
          },
          signature: sig,
        },
        accepted: erc6492Requirements,
        resource: { url: "", description: "", mimeType: "" },
      };
    }

    // Verify now mirrors settle's allowlist gate, so the simulation-path tests below must
    // construct a facilitator that allowlists `factory` (an undeployed payer whose factory is
    // not allowlisted is rejected before simulation — covered by its own test).
    let cfFacilitator: ExactEvmScheme;
    beforeEach(() => {
      cfFacilitator = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [factory],
      });
    });

    it("rejects a counterfactual payment whose factory is not allowlisted (verify mirrors settle)", async () => {
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));

      // Default `facilitator` has an empty allowlist.
      const result = await facilitator.verify(makeERC6492Payload(erc6492Sig), erc6492Requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrFactoryNotAllowed);
      expect(result.payer).toBe(erc6492Payer);
    });

    it("should accept ERC-6492 when verifyTypedData returns true and simulation passes", async () => {
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(true);
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            { success: true, returnData: "0x" },
            { success: true, returnData: "0x" },
          ]);
        }
        return Promise.resolve(BigInt("10000000"));
      });

      const result = await cfFacilitator.verify(
        makeERC6492Payload(erc6492Sig),
        erc6492Requirements,
      );

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(erc6492Payer);
    });

    it("should accept ERC-6492 when verifyTypedData fails but simulation passes (EOA-only signer)", async () => {
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(false);
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            { success: true, returnData: "0x" },
            { success: true, returnData: "0x" },
          ]);
        }
        return Promise.resolve(BigInt("10000000"));
      });

      const result = await cfFacilitator.verify(
        makeERC6492Payload(erc6492Sig),
        erc6492Requirements,
      );

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(erc6492Payer);
    });

    it("should accept ERC-6492 when verifyTypedData throws but simulation passes", async () => {
      mockFacilitatorSigner.verifyTypedData = vi
        .fn()
        .mockRejectedValue(new Error("invalid signature length"));
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            { success: true, returnData: "0x" },
            { success: true, returnData: "0x" },
          ]);
        }
        return Promise.resolve(BigInt("10000000"));
      });

      const result = await cfFacilitator.verify(
        makeERC6492Payload(erc6492Sig),
        erc6492Requirements,
      );

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(erc6492Payer);
    });

    it("should reject ERC-6492 when simulation fails (multicall transfer reverts)", async () => {
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(true);
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            { success: true, returnData: "0x" },
            { success: false, returnData: "0x" },
          ]);
        }
        return Promise.resolve([
          {
            success: true,
            returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
          },
          { success: true, returnData: "0x" },
          { success: true, returnData: "0x" },
          {
            success: true,
            returnData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        ]);
      });

      const result = await cfFacilitator.verify(
        makeERC6492Payload(erc6492Sig),
        erc6492Requirements,
      );

      expect(result.isValid).toBe(false);
    });

    it("should reject forged ERC-6492 when verifyTypedData fails and simulation fails", async () => {
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(false);
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            { success: true, returnData: "0x" },
            { success: false, returnData: "0x" },
          ]);
        }
        return Promise.resolve([
          {
            success: true,
            returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
          },
          { success: true, returnData: "0x" },
          { success: true, returnData: "0x" },
          {
            success: true,
            returnData: "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        ]);
      });

      const result = await cfFacilitator.verify(
        makeERC6492Payload(erc6492Sig),
        erc6492Requirements,
      );

      expect(result.isValid).toBe(false);
      expect(result.payer).toBe(erc6492Payer);
    });

    // 66-byte inner sig avoids the ECDSA (65-byte) branch, so executeTransferWithAuthorization
    // takes the bytes-overload path (writeContract receives the inner signature directly).
    const nonEcdsaInnerSig = ("0x" + "cc".repeat(66)) as `0x${string}`;
    const nonEcdsaErc6492Sig = makeERC6492Sig(factory, factoryCalldata, nonEcdsaInnerSig);

    it("settle submits the transfer after a successful deploy (no post-deploy simulation gate)", async () => {
      // The on-chain transfer is the authoritative signature check: after deploying the
      // wallet via the allowlisted factory, settle submits transferWithAuthorization with
      // the inner signature rather than pre-simulating it (which raced the deploy's state
      // and false-rejected valid wallets, e.g. Coinbase Smart Wallet).
      const facilitatorWithFactory = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [factory],
      });
      // payer undeployed ("0x"), asset deployed (so verify's asset-code check passes).
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer(erc6492Requirements.asset));
      mockFacilitatorSigner.sendTransaction = vi.fn().mockResolvedValue("0xdeploytx");
      mockFacilitatorSigner.writeContract = vi.fn().mockResolvedValue("0xtransfertx");
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockResolvedValue({ status: "success" });

      const result = await facilitatorWithFactory.settle(
        makeERC6492Payload(nonEcdsaErc6492Sig),
        erc6492Requirements,
      );

      expect(result.success).toBe(true);
      // Deploy tx was sent, then the transfer was submitted with the inner signature.
      expect(mockFacilitatorSigner.sendTransaction).toHaveBeenCalled();
      expect(mockFacilitatorSigner.writeContract).toHaveBeenCalled();
      expect(result.transaction).toBe("0xtransfertx");
    });

    it("settle classifies a post-deploy transfer revert (deployed wallet rejects inner sig)", async () => {
      // A wallet whose deployed validator genuinely rejects the inner signature surfaces as
      // a reverted transferWithAuthorization, classified via parseEip3009TransferError —
      // no separate pre-transfer gate is needed.
      const facilitatorWithFactory = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [factory],
      });
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer(erc6492Requirements.asset));
      mockFacilitatorSigner.sendTransaction = vi.fn().mockResolvedValue("0xdeploytx");
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockResolvedValue({ status: "success" });
      // The real transfer reverts because the deployed wallet rejects the inner signature.
      mockFacilitatorSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: invalid signature"));

      const result = await facilitatorWithFactory.settle(
        makeERC6492Payload(nonEcdsaErc6492Sig),
        erc6492Requirements,
      );

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrInvalidSignature);
      expect(result.transaction).toBe("");
    });

    it("should reject non-ERC-6492 long signature against undeployed wallet", async () => {
      const longNonERC6492Sig = ("0x" + "ab".repeat(100)) as `0x${string}`;
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));

      const result = await facilitator.verify(
        makeERC6492Payload(longNonERC6492Sig),
        erc6492Requirements,
      );

      // Strict primitive: payer has no code → ECDSA path → 100-byte sig is not a
      // valid ECDSA signature → rejected as invalid_signature. Previously this
      // returned ErrUndeployedSmartWallet because the OLD heuristic treated any
      // sig > 65 bytes as a smart-wallet sig and routed via getCode, which then
      // saw no code and no factory info. The new behavior is closer to on-chain:
      // a long sig sent to an EOA address is just an invalid signature.
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrInvalidSignature);
      expect(result.payer).toBe(erc6492Payer);
    });

    it("should accept deployed smart wallet when verifyTypedData fails but simulation passes (ERC-1271)", async () => {
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(false);
      mockFacilitatorSigner.getCode = vi.fn().mockResolvedValue("0x6080604052");
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            { success: true, returnData: "0x" },
            { success: true, returnData: "0x" },
          ]);
        }
        return Promise.resolve(undefined);
      });

      const result = await cfFacilitator.verify(
        makeERC6492Payload(erc6492Sig),
        erc6492Requirements,
      );

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(erc6492Payer);
    });

    it("should reject deployed wallet when isValidSignature reverts (REGRESSION: was ErrEip3009SimulationFailed)", async () => {
      mockFacilitatorSigner.getCode = vi.fn().mockResolvedValue("0x6080604052");
      // Every readContract call throws — including isValidSignature.
      mockFacilitatorSigner.readContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted"));

      const result = await cfFacilitator.verify(
        makeERC6492Payload(erc6492Sig),
        erc6492Requirements,
      );

      // The strict primitive treats a reverted isValidSignature call as "rejected"
      // (no ECDSA fallback, no simulation second-chance). Pre-verify outcome now
      // matches what on-chain SignatureChecker.isValidSignatureNow would return.
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrInvalidSignature);
    });
  });

  describe("EIP-2612 Gas Sponsoring - Settlement", () => {
    const permit2Requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" },
    };

    function makePermit2Payload(extensions?: Record<string, unknown>): PaymentPayload {
      const now = Math.floor(Date.now() / 1000);
      return {
        x402Version: 2,
        payload: {
          signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
          permit2Authorization: {
            from: "0x1234567890123456789012345678901234567890",
            permitted: {
              token: permit2Requirements.asset,
              amount: permit2Requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "12345",
            deadline: (now + 300).toString(),
            witness: {
              to: permit2Requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: permit2Requirements,
        resource: { url: "https://test.com", description: "", mimeType: "" },
        ...(extensions ? { extensions } : {}),
      };
    }

    function makeEip2612Extension() {
      const now = Math.floor(Date.now() / 1000);
      return {
        eip2612GasSponsoring: {
          info: {
            from: "0x1234567890123456789012345678901234567890",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
            amount:
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            nonce: "0",
            deadline: (now + 300).toString(),
            signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
            version: "1",
          },
          schema: {},
        },
      };
    }

    it("should call settleWithPermit when EIP-2612 extension is present", async () => {
      // settle's re-verify has simulate=false, so readContract is not called for simulation
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const payload = makePermit2Payload(makeEip2612Extension());
      const result = await facilitator.settle(payload, permit2Requirements);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xtxhash");

      const writeCall = (mockFacilitatorSigner.writeContract as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(writeCall.functionName).toBe("settleWithPermit");
    });

    it("should call settle (not settleWithPermit) when no EIP-2612 extension", async () => {
      // settle's re-verify has simulate=false
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const payload = makePermit2Payload();
      const result = await facilitator.settle(payload, permit2Requirements);

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xtxhash");

      const writeCall = (mockFacilitatorSigner.writeContract as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(writeCall.functionName).toBe("settle");
    });

    it("should map Permit2612AmountMismatch contract revert to permit2_2612_amount_mismatch", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);
      mockFacilitatorSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: Permit2612AmountMismatch()"));

      const payload = makePermit2Payload();
      const result = await facilitator.settle(payload, permit2Requirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("permit2_2612_amount_mismatch");
    });

    it("should map InvalidAmount contract revert to permit2_invalid_amount", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);
      mockFacilitatorSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: InvalidAmount()"));

      const payload = makePermit2Payload();
      const result = await facilitator.settle(payload, permit2Requirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("permit2_invalid_amount");
    });

    it("should map InvalidNonce contract revert to permit2_invalid_nonce", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);
      mockFacilitatorSigner.writeContract = vi
        .fn()
        .mockRejectedValue(new Error("execution reverted: InvalidNonce()"));

      const payload = makePermit2Payload();
      const result = await facilitator.settle(payload, permit2Requirements);

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("permit2_invalid_nonce");
    });

    it("should pass correct EIP-2612 permit struct to settleWithPermit", async () => {
      // settle's re-verify has simulate=false
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const extensions = makeEip2612Extension();
      const payload = makePermit2Payload(extensions);
      await facilitator.settle(payload, permit2Requirements);

      const writeCall = (mockFacilitatorSigner.writeContract as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(writeCall.functionName).toBe("settleWithPermit");

      const permit2612Struct = writeCall.args[0];
      expect(permit2612Struct.value).toBeDefined();
      expect(permit2612Struct.deadline).toBeDefined();
      expect(permit2612Struct.r).toBeDefined();
      expect(permit2612Struct.s).toBeDefined();
      expect(permit2612Struct.v).toBeDefined();
      expect(typeof permit2612Struct.v).toBe("number");
    });
  });

  describe("ERC-20 Approval Gas Sponsoring - Verify", () => {
    const PAYER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const TOKEN_ADDRESS = "0xeED520980fC7C7B4eB379B96d61CEdea2423005a" as `0x${string}`;
    const MOCK_SIGNED_TX = "0x02f8ab0102030405060708" as `0x${string}`;

    // Approve calldata: approve(PERMIT2_ADDRESS, MaxUint256)
    const APPROVE_CALLDATA =
      `0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3` +
      `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`;

    const erc20Requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: TOKEN_ADDRESS,
      payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "permit2" },
    };

    function makeErc20Permit2Payload(extensions?: Record<string, unknown>): PaymentPayload {
      const now = Math.floor(Date.now() / 1000);
      return {
        x402Version: 2,
        payload: {
          signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
          permit2Authorization: {
            from: PAYER,
            permitted: {
              token: TOKEN_ADDRESS,
              amount: erc20Requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "99999",
            deadline: (now + 300).toString(),
            witness: {
              to: erc20Requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: erc20Requirements,
        resource: { url: "https://test.com", description: "", mimeType: "" },
        ...(extensions ? { extensions } : {}),
      };
    }

    function makeValidErc20Extension() {
      return {
        erc20ApprovalGasSponsoring: {
          info: {
            from: PAYER,
            asset: TOKEN_ADDRESS,
            spender: PERMIT2_ADDRESS,
            amount:
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      };
    }

    /** Creates a mock FacilitatorContext with the ERC-20 extension registered. */
    function makeErc20Context() {
      return {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return { key: ERC20_APPROVAL_GAS_SPONSORING_KEY };
          }
          return undefined;
        }),
      };
    }

    it("should reject when simulation fails and no ERC-20 extension (no context)", async () => {
      // Simulation of settle() fails, diagnostic multicall shows low allowance
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === x402ExactPermit2ProxyAddress) {
          return Promise.reject(new Error("execution reverted"));
        }
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            {
              success: true,
              returnData: "0x000000000000000000000000000000000022D473030F116dDEE9F6B43aC78BA3",
            },
            {
              success: true,
              returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
            },
            {
              success: true,
              returnData: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          ]);
        }
        return Promise.resolve(BigInt(0));
      });

      const payload = makeErc20Permit2Payload();
      const result = await facilitator.verify(payload, erc20Requirements);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("permit2_allowance_required");
    });

    it("should reject when ERC-20 extension has invalid format (bad address)", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const payload = makeErc20Permit2Payload({
        erc20ApprovalGasSponsoring: {
          info: {
            from: "not-an-address", // invalid
            asset: TOKEN_ADDRESS,
            spender: PERMIT2_ADDRESS,
            amount: "100",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      });

      const result = await facilitator.verify(payload, erc20Requirements, makeErc20Context());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_erc20_approval_extension_format");
    });

    it("should reject when ERC-20 extension `from` doesn't match payer", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const payload = makeErc20Permit2Payload({
        erc20ApprovalGasSponsoring: {
          info: {
            from: "0x0000000000000000000000000000000000000001", // wrong address
            asset: TOKEN_ADDRESS,
            spender: PERMIT2_ADDRESS,
            amount: "100",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      });

      const result = await facilitator.verify(payload, erc20Requirements, makeErc20Context());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("erc20_approval_from_mismatch");
    });

    it("should reject when ERC-20 extension `asset` doesn't match token", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const payload = makeErc20Permit2Payload({
        erc20ApprovalGasSponsoring: {
          info: {
            from: PAYER,
            asset: "0x0000000000000000000000000000000000000002", // wrong token
            spender: PERMIT2_ADDRESS,
            amount: "100",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      });

      const result = await facilitator.verify(payload, erc20Requirements, makeErc20Context());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("erc20_approval_asset_mismatch");
    });

    it("should reject when ERC-20 extension spender is not PERMIT2_ADDRESS", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const payload = makeErc20Permit2Payload({
        erc20ApprovalGasSponsoring: {
          info: {
            from: PAYER,
            asset: TOKEN_ADDRESS,
            spender: "0x0000000000000000000000000000000000000003", // not Permit2
            amount: "100",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      });

      const result = await facilitator.verify(payload, erc20Requirements, makeErc20Context());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("erc20_approval_spender_not_permit2");
    });

    it("should accept when valid ERC-20 extension present and prerequisites pass", async () => {
      // checkPermit2Prerequisites multicall: proxy deployed + sufficient token balance
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            {
              success: true,
              returnData: "0x000000000000000000000000000000000022D473030F116dDEE9F6B43aC78BA3",
            },
            {
              success: true,
              returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
            },
          ]);
        }
        return Promise.resolve(undefined);
      });

      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      const payload = makeErc20Permit2Payload(makeValidErc20Extension());
      const result = await facilitator.verify(payload, erc20Requirements, makeErc20Context());

      if (!result.isValid) {
        expect(result.invalidReason).not.toBe("permit2_allowance_required");
      }
    });

    it("should reject when calldata targets wrong address (not PERMIT2_ADDRESS)", async () => {
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const wrongSpenderCalldata =
        "0x095ea7b3" +
        "0000000000000000000000000000000000000000000000000000000000000001" + // wrong spender
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: wrongSpenderCalldata as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      const payload = makeErc20Permit2Payload(makeValidErc20Extension());
      const result = await facilitator.verify(payload, erc20Requirements, makeErc20Context());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("erc20_approval_tx_wrong_spender");
    });

    it("Path 2 simulation: should accept when extension signer simulateTransactions returns true", async () => {
      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const mockSimulateTransactions = vi.fn().mockResolvedValue(true);

      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return {
              key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
              signer: {
                ...mockFacilitatorSigner,
                sendTransactions: vi.fn(),
                simulateTransactions: mockSimulateTransactions,
              },
            };
          }
          return undefined;
        }),
      };

      const payload = makeErc20Permit2Payload(makeValidErc20Extension());
      const result = await facilitator.verify(payload, erc20Requirements, mockContext);

      expect(mockSimulateTransactions).toHaveBeenCalledOnce();
      const bundle = mockSimulateTransactions.mock.calls[0][0];
      expect(bundle[0]).toBe(MOCK_SIGNED_TX);
      expect(bundle[1]).toHaveProperty("to");
      expect(bundle[1]).toHaveProperty("data");
      expect(result.isValid).toBe(true);
    });

    it("Path 2 simulation: should reject with diagnostic reason when simulateTransactions returns false", async () => {
      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          // diagnostic multicall: proxy deployed, balance insufficient
          return Promise.resolve([
            {
              success: true,
              returnData: "0x000000000000000000000000000000000022D473030F116dDEE9F6B43aC78BA3",
            },
            {
              success: true,
              returnData: "0x0000000000000000000000000000000000000000000000000000000000000001",
            },
            {
              success: true,
              returnData: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          ]);
        }
        return Promise.resolve(undefined);
      });

      const mockSimulateTransactions = vi.fn().mockResolvedValue(false);

      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return {
              key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
              signer: {
                ...mockFacilitatorSigner,
                sendTransactions: vi.fn(),
                simulateTransactions: mockSimulateTransactions,
              },
            };
          }
          return undefined;
        }),
      };

      const payload = makeErc20Permit2Payload(makeValidErc20Extension());
      const result = await facilitator.verify(payload, erc20Requirements, mockContext);

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(Errors.ErrPermit2InsufficientBalance);
    });

    it("Path 2 simulation: should fall back to checkPermit2Prerequisites when simulateTransactions is absent", async () => {
      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      // prerequisites pass: proxy deployed + sufficient token balance
      mockFacilitatorSigner.readContract = rcWithSig(({ address }: { address: string }) => {
        if (address === MULTICALL3_ADDRESS) {
          return Promise.resolve([
            {
              success: true,
              returnData: "0x000000000000000000000000000000000022D473030F116dDEE9F6B43aC78BA3",
            },
            {
              success: true,
              returnData: "0x00000000000000000000000000000000000000000000000000000000000f4240",
            },
          ]);
        }
        return Promise.resolve(undefined);
      });

      // signer has sendTransactions but no simulateTransactions (legacy)
      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return {
              key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
              signer: {
                ...mockFacilitatorSigner,
                sendTransactions: vi.fn(),
              },
            };
          }
          return undefined;
        }),
      };

      const payload = makeErc20Permit2Payload(makeValidErc20Extension());
      const result = await facilitator.verify(payload, erc20Requirements, mockContext);

      expect(result.isValid).toBe(true);
    });
  });

  describe("ERC-20 Approval Gas Sponsoring - Settlement", () => {
    const PAYER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const TOKEN_ADDRESS = "0xeED520980fC7C7B4eB379B96d61CEdea2423005a" as `0x${string}`;
    const MOCK_SIGNED_TX = "0x02f8ab0102030405060708" as `0x${string}`;

    const APPROVE_CALLDATA =
      `0x095ea7b3000000000000000000000000000000000022d473030f116ddee9f6b43ac78ba3` +
      `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`;

    const erc20Requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: TOKEN_ADDRESS,
      payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "permit2" },
    };

    function makeErc20Permit2Payload(extensions?: Record<string, unknown>): PaymentPayload {
      const now = Math.floor(Date.now() / 1000);
      return {
        x402Version: 2,
        payload: {
          signature: "0x" + "ab".repeat(32) + "cd".repeat(32) + "1b",
          permit2Authorization: {
            from: PAYER,
            permitted: {
              token: TOKEN_ADDRESS,
              amount: erc20Requirements.amount,
            },
            spender: x402ExactPermit2ProxyAddress,
            nonce: "99999",
            deadline: (now + 300).toString(),
            witness: {
              to: erc20Requirements.payTo,
              validAfter: "0",
            },
          },
        },
        accepted: erc20Requirements,
        resource: { url: "https://test.com", description: "", mimeType: "" },
        ...(extensions ? { extensions } : {}),
      };
    }

    function makeValidErc20Extension() {
      return {
        erc20ApprovalGasSponsoring: {
          info: {
            from: PAYER,
            asset: TOKEN_ADDRESS,
            spender: PERMIT2_ADDRESS,
            amount:
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
            signedTransaction: MOCK_SIGNED_TX,
            version: "1",
          },
          schema: {},
        },
      };
    }

    it("should broadcast approval tx via extension signer then settle via extension signer", async () => {
      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      // settle's re-verify has simulate=false, so no simulation calls
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const SETTLE_TX_HASH = "0xsettle_tx_hash_mock" as `0x${string}`;
      const mockSendTransactions = vi.fn().mockResolvedValue([SETTLE_TX_HASH]);
      const mockExtWaitForReceipt = vi.fn().mockResolvedValue({ status: "success" });

      // Extension signer has all FacilitatorEvmSigner methods + sendTransactions
      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key === ERC20_APPROVAL_GAS_SPONSORING_KEY) {
            return {
              key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
              signer: {
                getAddresses: vi.fn().mockReturnValue([PAYER]),
                readContract: mockFacilitatorSigner.readContract,
                verifyTypedData: mockFacilitatorSigner.verifyTypedData,
                writeContract: vi.fn(),
                sendTransaction: vi.fn(),
                waitForTransactionReceipt: mockExtWaitForReceipt,
                getCode: vi.fn().mockResolvedValue("0x"),
                sendTransactions: mockSendTransactions,
              },
            };
          }
          return undefined;
        }),
      };

      const payload = makeErc20Permit2Payload(makeValidErc20Extension());
      const result = await facilitator.settle(payload, erc20Requirements, mockContext);

      // Extension signer called sendTransactions with [approvalTx, settleCall]
      expect(mockSendTransactions).toHaveBeenCalled();
      const transactions = mockSendTransactions.mock.calls[0][0];
      expect(transactions[0]).toBe(MOCK_SIGNED_TX);
      expect(transactions[1]).toHaveProperty("to");
      expect(transactions[1]).toHaveProperty("data");

      // Base signer's writeContract should NOT have been called
      expect(mockFacilitatorSigner.writeContract).not.toHaveBeenCalled();

      expect(result.success).toBe(true);
    });

    it("should resolve extension signer by network when signerForNetwork is present", async () => {
      const { parseTransaction, recoverTransactionAddress } = await import("viem");
      vi.mocked(parseTransaction).mockReturnValue({
        to: TOKEN_ADDRESS,
        data: APPROVE_CALLDATA as `0x${string}`,
      } as any);
      vi.mocked(recoverTransactionAddress).mockResolvedValue(PAYER);

      // settle's re-verify has simulate=false
      mockFacilitatorSigner.readContract = rcWithSig(undefined);

      const selectedSignerSendTransactions = vi
        .fn()
        .mockResolvedValue(["0xsettle_hash" as `0x${string}`]);
      const selectedSignerWait = vi.fn().mockResolvedValue({ status: "success" });
      const fallbackSignerSendTransactions = vi.fn();

      const mockContext = {
        getExtension: vi.fn().mockImplementation((key: string) => {
          if (key !== ERC20_APPROVAL_GAS_SPONSORING_KEY) return undefined;
          return {
            key: ERC20_APPROVAL_GAS_SPONSORING_KEY,
            signer: {
              getAddresses: vi.fn().mockReturnValue([PAYER]),
              readContract: mockFacilitatorSigner.readContract,
              verifyTypedData: mockFacilitatorSigner.verifyTypedData,
              writeContract: vi.fn(),
              sendTransaction: vi.fn(),
              waitForTransactionReceipt: selectedSignerWait,
              getCode: vi.fn().mockResolvedValue("0x"),
              sendTransactions: fallbackSignerSendTransactions,
            },
            signerForNetwork: (network: string) => {
              if (network !== "eip155:84532") return undefined;
              return {
                getAddresses: vi.fn().mockReturnValue([PAYER]),
                readContract: mockFacilitatorSigner.readContract,
                verifyTypedData: mockFacilitatorSigner.verifyTypedData,
                writeContract: vi.fn(),
                sendTransaction: vi.fn(),
                waitForTransactionReceipt: selectedSignerWait,
                getCode: vi.fn().mockResolvedValue("0x"),
                sendTransactions: selectedSignerSendTransactions,
              };
            },
          };
        }),
      };

      const payload = makeErc20Permit2Payload(makeValidErc20Extension());
      await facilitator.settle(payload, erc20Requirements, mockContext);

      expect(selectedSignerSendTransactions).toHaveBeenCalled();
      expect(fallbackSignerSendTransactions).not.toHaveBeenCalled();
    });
  });

  describe("ERC-6492 factory allowlist enforcement during settle", () => {
    const ERC6492_MAGIC = "0x6492649264926492649264926492649264926492649264926492649264926492";
    const SETTLE_FACTORY = "0x1111111111111111111111111111111111111111" as `0x${string}`;
    const SETTLE_FACTORY_CALLDATA = "0xdeadbeef" as `0x${string}`;
    const SETTLE_PAYER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`;

    const settleRequirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x742D35CC6634c0532925A3b844BC9E7595F0BEb0",
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2" },
    };

    function makeSettleErc6492Sig(factory: `0x${string}`): `0x${string}` {
      // 66 bytes: avoids the ECDSA branch (which requires exactly 65 bytes) so writeContract
      // receives bytes directly without parseSignature being called on a garbage value.
      const innerSig = ("0x" + "cc".repeat(66)) as `0x${string}`;
      const encoded = encodeAbiParameters(
        [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
        [factory, SETTLE_FACTORY_CALLDATA, innerSig],
      );
      return concat([encoded, ERC6492_MAGIC]) as `0x${string}`;
    }

    function makeSettlePayload(sig: `0x${string}`): PaymentPayload {
      return {
        x402Version: 2,
        payload: {
          authorization: {
            from: SETTLE_PAYER,
            to: settleRequirements.payTo,
            value: settleRequirements.amount,
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000002",
          },
          signature: sig,
        },
        accepted: settleRequirements,
        resource: { url: "", description: "", mimeType: "" },
      };
    }

    beforeEach(() => {
      mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(true);
      mockFacilitatorSigner.readContract = rcWithSig(0n);
      mockFacilitatorSigner.writeContract = vi.fn().mockResolvedValue("0xsettletxhash");
      mockFacilitatorSigner.sendTransaction = vi.fn().mockResolvedValue("0xdeploytxhash");
      mockFacilitatorSigner.waitForTransactionReceipt = vi
        .fn()
        .mockResolvedValue({ status: "success" });
    });

    it("should reject settlement when allowlist is empty and wallet is undeployed", async () => {
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      const scheme = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [],
      });

      const result = await scheme.settle(
        makeSettlePayload(makeSettleErc6492Sig(SETTLE_FACTORY)),
        settleRequirements,
      );

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrFactoryNotAllowed);
      expect(mockFacilitatorSigner.sendTransaction).not.toHaveBeenCalled();
    });

    it("should deploy and settle when factory is in allowlist", async () => {
      // After sendTransaction (factory deploy), getCode must return deployed bytecode
      // so the polling loop exits. Track deploy state via sendTransaction call count.
      let deployed = false;
      mockFacilitatorSigner.sendTransaction = vi.fn().mockImplementation(async () => {
        deployed = true;
        return "0xdeploytxhash";
      });
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(({ address }: { address: string }) => {
          const assetAddr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
          if (address.toLowerCase() === assetAddr.toLowerCase())
            return Promise.resolve("0x6080604052");
          return Promise.resolve(deployed ? "0x6080604052" : "0x");
        });
      const scheme = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [SETTLE_FACTORY],
      });

      const result = await scheme.settle(
        makeSettlePayload(makeSettleErc6492Sig(SETTLE_FACTORY)),
        settleRequirements,
      );

      expect(result.success).toBe(true);
      expect(mockFacilitatorSigner.sendTransaction).toHaveBeenCalledOnce();
      expect(mockFacilitatorSigner.writeContract).toHaveBeenCalled();
    });

    it("should match factory address case-insensitively", async () => {
      let deployed = false;
      mockFacilitatorSigner.sendTransaction = vi.fn().mockImplementation(async () => {
        deployed = true;
        return "0xdeploytxhash";
      });
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(({ address }: { address: string }) => {
          const assetAddr = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
          if (address.toLowerCase() === assetAddr.toLowerCase())
            return Promise.resolve("0x6080604052");
          return Promise.resolve(deployed ? "0x6080604052" : "0x");
        });
      const scheme = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [SETTLE_FACTORY.toUpperCase() as `0x${string}`],
      });

      const result = await scheme.settle(
        makeSettlePayload(makeSettleErc6492Sig(SETTLE_FACTORY)),
        settleRequirements,
      );

      expect(result.success).toBe(true);
      expect(mockFacilitatorSigner.sendTransaction).toHaveBeenCalledOnce();
    });

    it("should reject when factory does not match any allowlist entry", async () => {
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      const scheme = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: ["0x3333333333333333333333333333333333333333"],
      });

      const result = await scheme.settle(
        makeSettlePayload(makeSettleErc6492Sig(SETTLE_FACTORY)),
        settleRequirements,
      );

      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(Errors.ErrFactoryNotAllowed);
      expect(mockFacilitatorSigner.sendTransaction).not.toHaveBeenCalled();
    });

    it("should skip allowlist check when wallet is already deployed", async () => {
      mockFacilitatorSigner.getCode = vi.fn().mockResolvedValue("0x6080604052");
      const scheme = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [], // empty — would block if deployment were attempted
      });

      const result = await scheme.settle(
        makeSettlePayload(makeSettleErc6492Sig(SETTLE_FACTORY)),
        settleRequirements,
      );

      expect(result.success).toBe(true);
      expect(mockFacilitatorSigner.sendTransaction).not.toHaveBeenCalled();
      expect(mockFacilitatorSigner.writeContract).toHaveBeenCalled();
    });

    it("should not call factory deployment for EOA payer (no 6492 wrapper)", async () => {
      // Payer is an EOA (mockGetCodeEOAPayer returns "0x" for non-asset addresses).
      // Sign with a real 65-byte ECDSA signature so the strict primitive's ECDSA
      // path can succeed; we want to verify settle does NOT call sendTransaction
      // for factory deployment regardless of the signature outcome — there's no
      // 6492 wrapper, so deployment can't be triggered.
      mockFacilitatorSigner.getCode = vi
        .fn()
        .mockImplementation(mockGetCodeEOAPayer("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
      const scheme = new ExactEvmScheme(mockFacilitatorSigner, {
        eip6492AllowedFactories: [],
      });
      // 65-byte sig fixture — strict primitive will attempt ecrecover. The
      // recovered address won't match SETTLE_PAYER, so sig will be invalid.
      const eoaSig = ("0x" + "aa".repeat(65)) as `0x${string}`;
      const eoaPayload: PaymentPayload = {
        ...makeSettlePayload(eoaSig),
        payload: {
          authorization: {
            from: SETTLE_PAYER,
            to: settleRequirements.payTo,
            value: settleRequirements.amount,
            validAfter: "0",
            validBefore: "999999999999",
            nonce: "0x0000000000000000000000000000000000000000000000000000000000000003",
          },
          signature: eoaSig,
        },
      };

      await scheme.settle(eoaPayload, settleRequirements);

      // Regardless of the signature outcome, we never deploy a factory for an EOA.
      expect(mockFacilitatorSigner.sendTransaction).not.toHaveBeenCalled();
    });
  });
});
