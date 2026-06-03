import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthCaptureEvmScheme } from "../../../src/auth-capture/client/index";
import {
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "../../../src/auth-capture/constants";
import { PERMIT2_ADDRESS } from "../../../src/constants";
import { isEip3009Payload, isPermit2Payload } from "../../../src/auth-capture/types";
import type { Eip3009Payload, Permit2Payload } from "../../../src/auth-capture/types";

const FUTURE = Math.floor(Date.now() / 1000) + 86400;

describe("AuthCaptureEvmScheme", () => {
  const createMockSigner = () => ({
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    signTypedData: vi.fn().mockResolvedValue("0xdeadbeef" as `0x${string}`),
  });

  let mockSigner: ReturnType<typeof createMockSigner>;

  beforeEach(() => {
    mockSigner = createMockSigner();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockRequirements = {
    scheme: "auth-capture",
    network: "eip155:84532",
    amount: "1000000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x1234567890123456789012345678901234567890",
    maxTimeoutSeconds: 3600,
    extra: {
      captureAuthorizer: "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`,
      captureDeadline: FUTURE,
      refundDeadline: FUTURE + 86400,
      feeRecipient: "0x4444444444444444444444444444444444444444" as `0x${string}`,
      minFeeBps: 0,
      maxFeeBps: 100,
      name: "USDC",
      version: "2",
    },
  };

  describe("constructor and properties", () => {
    it('should have scheme set to "auth-capture"', () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      expect(scheme.scheme).toBe("auth-capture");
    });
  });

  describe("createPaymentPayload — EIP-3009 (default)", () => {
    it("should create a valid EIP-3009 payload for x402Version 2", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.createPaymentPayload(2, mockRequirements);

      expect(result.x402Version).toBe(2);
      expect(isEip3009Payload(result.payload)).toBe(true);
      const payload = result.payload as unknown as Eip3009Payload;
      expect(payload.authorization).toBeDefined();
      expect(payload.signature).toBe("0xdeadbeef");
      expect(payload.salt).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("should throw for unsupported x402Version", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await expect(scheme.createPaymentPayload(1, mockRequirements)).rejects.toThrow(
        "Unsupported x402Version: 1. Only version 2 is supported.",
      );
    });

    it("should throw for x402Version 0", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await expect(scheme.createPaymentPayload(0, mockRequirements)).rejects.toThrow(
        "Unsupported x402Version: 0",
      );
    });

    it("should throw when EIP-712 name is missing", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const requirementsNoName = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, name: "" },
      };
      await expect(scheme.createPaymentPayload(2, requirementsNoName)).rejects.toThrow(
        "EIP-712 domain parameter 'name' is required",
      );
    });

    it("should throw when EIP-712 version is missing", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const requirementsNoVersion = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, version: "" },
      };
      await expect(scheme.createPaymentPayload(2, requirementsNoVersion)).rejects.toThrow(
        "EIP-712 domain parameter 'version' is required",
      );
    });

    it("should throw when captureAuthorizer is missing", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const bad = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, captureAuthorizer: "" as `0x${string}` },
      };
      await expect(scheme.createPaymentPayload(2, bad)).rejects.toThrow(
        "'captureAuthorizer' is required",
      );
    });

    it("should throw when feeRecipient is missing", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const bad = {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, feeRecipient: "" as `0x${string}` },
      };
      await expect(scheme.createPaymentPayload(2, bad)).rejects.toThrow(
        "'feeRecipient' is required",
      );
    });

    it("should set authorization.from to signer address", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.createPaymentPayload(2, mockRequirements);
      const payload = result.payload as unknown as Eip3009Payload;
      expect(payload.authorization.from).toBe(mockSigner.address);
    });

    it("should set authorization.to to the canonical EIP-3009 token collector", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.createPaymentPayload(2, mockRequirements);
      const payload = result.payload as unknown as Eip3009Payload;
      expect(payload.authorization.to).toBe(EIP3009_TOKEN_COLLECTOR_ADDRESS);
    });

    it("should set authorization.value to requirements amount", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.createPaymentPayload(2, mockRequirements);
      const payload = result.payload as unknown as Eip3009Payload;
      expect(payload.authorization.value).toBe("1000000");
    });

    it("should derive validBefore from now + maxTimeoutSeconds", async () => {
      const fakeNowMs = 1700000000000;
      vi.spyOn(Date, "now").mockReturnValue(fakeNowMs);
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.createPaymentPayload(2, {
        ...mockRequirements,
        maxTimeoutSeconds: 600,
      });
      const payload = result.payload as unknown as Eip3009Payload;
      expect(payload.authorization.validBefore).toBe("1700000600");
    });

    it("should generate a fresh salt on each call", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const a = (await scheme.createPaymentPayload(2, mockRequirements))
        .payload as unknown as Eip3009Payload;
      const b = (await scheme.createPaymentPayload(2, mockRequirements))
        .payload as unknown as Eip3009Payload;
      expect(a.salt).not.toBe(b.salt);
    });

    it("should throw for invalid network format", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const badNetworkRequirements = { ...mockRequirements, network: "solana:mainnet" };
      await expect(scheme.createPaymentPayload(2, badNetworkRequirements)).rejects.toThrow(
        "Invalid network format",
      );
    });

    it("should call signTypedData on signer", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.createPaymentPayload(2, mockRequirements);
      expect(mockSigner.signTypedData).toHaveBeenCalledOnce();
    });

    it("should sign with EIP-712 domain bound to the asset (verifyingContract = requirements.asset)", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.createPaymentPayload(2, mockRequirements);
      const args = mockSigner.signTypedData.mock.calls[0][0];
      expect(args.primaryType).toBe("ReceiveWithAuthorization");
      expect(args.domain.name).toBe("USDC");
      expect(args.domain.version).toBe("2");
      expect(args.domain.chainId).toBe(84532);
      // Critical: verifyingContract is the token, NOT the collector
      expect(args.domain.verifyingContract.toLowerCase()).toBe(
        mockRequirements.asset.toLowerCase(),
      );
    });
  });

  describe("createPaymentPayload — Permit2", () => {
    it("should create a valid Permit2 payload when assetTransferMethod is permit2", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.createPaymentPayload(2, {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      });

      expect(isPermit2Payload(result.payload)).toBe(true);
      const payload = result.payload as unknown as Permit2Payload;
      expect(payload.permit2Authorization.from).toBe(mockSigner.address);
      expect(payload.permit2Authorization.spender).toBe(PERMIT2_TOKEN_COLLECTOR_ADDRESS);
      expect(payload.permit2Authorization.permitted.token).toBe(mockRequirements.asset);
      expect(payload.permit2Authorization.permitted.amount).toBe(mockRequirements.amount);
      expect(payload.salt).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("should compute a uint256-string Permit2 nonce", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      const result = await scheme.createPaymentPayload(2, {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      });
      const payload = result.payload as unknown as Permit2Payload;
      // uint256 stringified — should parse as a valid bigint
      expect(() => BigInt(payload.permit2Authorization.nonce)).not.toThrow();
      expect(payload.permit2Authorization.nonce.length).toBeGreaterThan(0);
    });

    it("should sign with EIP-712 domain bound to canonical Permit2 (NOT the token)", async () => {
      const scheme = new AuthCaptureEvmScheme(mockSigner);
      await scheme.createPaymentPayload(2, {
        ...mockRequirements,
        extra: { ...mockRequirements.extra, assetTransferMethod: "permit2" as const },
      });
      const args = mockSigner.signTypedData.mock.calls[0][0];
      expect(args.primaryType).toBe("PermitTransferFrom");
      expect(args.domain.name).toBe("Permit2");
      expect(args.domain.chainId).toBe(84532);
      // Critical: verifyingContract is the canonical Permit2, NOT the token, NOT the collector
      expect(args.domain.verifyingContract).toBe(PERMIT2_ADDRESS);
    });
  });
});
