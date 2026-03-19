import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactTvmScheme } from "../../../src/exact/client/scheme";
import type { ClientTvmSigner } from "../../../src/signer";
import { PaymentRequirements } from "@x402/core/types";
import { USDT_MASTER, TVM_MAINNET } from "../../../src/constants";

// Mock @ton/ton TonClient
const mockGetSeqno = vi.fn().mockResolvedValue(5);
const mockGetWalletAddress = vi.fn();

vi.mock("@ton/ton", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ton/ton")>();
  return {
    ...actual,
    TonClient: vi.fn().mockImplementation(() => ({
      open: vi.fn().mockImplementation((contract: unknown) => {
        // Check if it's a WalletContractV5R1 (has getSeqno)
        if (contract && typeof contract === "object" && "address" in contract && "init" in contract) {
          return { getSeqno: mockGetSeqno };
        }
        // Otherwise it's a JettonMaster
        return { getWalletAddress: mockGetWalletAddress };
      }),
    })),
  };
});

describe("ExactTvmScheme (Client)", () => {
  let client: ExactTvmScheme;
  let mockSigner: ClientTvmSigner;

  const mockRequirements: PaymentRequirements = {
    scheme: "exact",
    network: TVM_MAINNET,
    amount: "10000",
    asset: USDT_MASTER,
    payTo: "0:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    maxTimeoutSeconds: 300,
    extra: { facilitatorUrl: "https://facilitator.example.com" },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    const { Address } = await import("@ton/core");
    mockGetWalletAddress.mockResolvedValue(
      Address.parseRaw("0:aabbccdd1234567890abcdef1234567890abcdef1234567890abcdef12345678"),
    );

    mockSigner = {
      address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      publicKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      signTransfer: vi.fn().mockResolvedValue("te6cckEBAgEA...base64boc"),
    };
    client = new ExactTvmScheme(mockSigner);
  });

  describe("Construction", () => {
    it("should create instance with signer", () => {
      expect(client).toBeDefined();
      expect(client.scheme).toBe("exact");
    });

    it("should accept custom RPC config", () => {
      const customClient = new ExactTvmScheme(mockSigner, {
        rpcUrl: "https://custom-rpc.example.com",
        apiKey: "test-key",
      });
      expect(customClient).toBeDefined();
    });
  });

  describe("createPaymentPayload", () => {
    it("should resolve jetton wallet via RPC", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockGetWalletAddress).toHaveBeenCalled();
    });

    it("should get wallet seqno via RPC", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockGetSeqno).toHaveBeenCalled();
    });

    it("should sign transfer with seqno from RPC", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockSigner.signTransfer).toHaveBeenCalled();
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(signCall[0]).toBe(5); // seqno from mock
    });

    it("should include sender address in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.from).toBe(mockSigner.address);
    });

    it("should include recipient in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.to).toBe(mockRequirements.payTo);
    });

    it("should include settlement BOC in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.settlementBoc).toBe("te6cckEBAgEA...base64boc");
    });

    it("should include wallet public key in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.walletPublicKey).toBe(mockSigner.publicKey);
    });

    it("should not include nonce in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.nonce).toBeUndefined();
    });

    it("should include validUntil in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.validUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("should set x402Version from argument", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.x402Version).toBe(2);
    });

    it("should pass exactly 1 message to signTransfer", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = signCall[2];
      expect(messages).toHaveLength(1);
    });

    it("should build jetton transfer body with correct opcode", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = signCall[2];
      // The body should be a Cell with jetton_transfer opcode
      expect(messages[0].body).toBeDefined();
      const slice = messages[0].body.beginParse();
      const opcode = slice.loadUint(32);
      expect(opcode).toBe(0x0f8a7ea5);
    });
  });
});
