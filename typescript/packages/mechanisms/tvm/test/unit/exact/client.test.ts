import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactTvmScheme } from "../../../src/exact/client/scheme";
import type { ClientTvmSigner } from "../../../src/signer";
import { PaymentRequirements } from "@x402/core/types";
import { USDT_MASTER, TVM_MAINNET } from "../../../src/constants";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ExactTvmScheme (Client)", () => {
  let client: ExactTvmScheme;
  let mockSigner: ClientTvmSigner;

  const facilitatorUrl = "https://ton-facilitator.example.com";

  const mockRequirements: PaymentRequirements = {
    scheme: "exact",
    network: TVM_MAINNET,
    amount: "10000",
    asset: USDT_MASTER,
    payTo: "0:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    maxTimeoutSeconds: 300,
    extra: { facilitatorUrl },
  };

  beforeEach(() => {
    mockSigner = {
      address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      publicKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      signTransfer: vi.fn().mockResolvedValue("te6cckEBAgEA...base64boc"),
    };
    client = new ExactTvmScheme(mockSigner);

    // Mock /prepare response
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        seqno: 5,
        validUntil: Math.floor(Date.now() / 1000) + 300,
        walletId: 2147483409,
        messages: [
          {
            address: "0:aabbccdd1234567890abcdef1234567890abcdef1234567890abcdef12345678",
            amount: "10000000",
          },
        ],
      }),
    });
  });

  describe("Construction", () => {
    it("should create instance with signer", () => {
      expect(client).toBeDefined();
      expect(client.scheme).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it("should call facilitator /prepare with correct shape", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockFetch).toHaveBeenCalledWith(
        `${facilitatorUrl}/prepare`,
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("walletAddress"),
        }),
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.walletAddress).toBe(mockSigner.address);
      expect(body.walletPublicKey).toBe(mockSigner.publicKey);
      expect(body.paymentRequirements.amount).toBe("10000");
      expect(body.paymentRequirements.payTo).toBe(mockRequirements.payTo);
    });

    it("should sign transfer with seqno from /prepare", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockSigner.signTransfer).toHaveBeenCalled();
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(signCall[0]).toBe(5); // seqno from prepare
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

    it("should generate unique nonces", async () => {
      const result1 = await client.createPaymentPayload(2, mockRequirements);
      const result2 = await client.createPaymentPayload(2, mockRequirements);
      expect(result1.payload.nonce).not.toBe(result2.payload.nonce);
    });

    it("should throw if facilitatorUrl is missing", async () => {
      const reqNoUrl = { ...mockRequirements, extra: {} };
      await expect(client.createPaymentPayload(2, reqNoUrl)).rejects.toThrow("facilitatorUrl");
    });
  });
});
