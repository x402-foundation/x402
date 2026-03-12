import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExactTvmScheme } from "../../../src/exact/client/scheme";
import type { ClientTvmSigner } from "../../../src/signer";
import { PaymentRequirements } from "@x402/core/types";
import { USDT_MASTER, TVM_MAINNET } from "../../../src/constants";

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
    extra: {},
  };

  beforeEach(() => {
    mockSigner = {
      address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      publicKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      getSeqno: vi.fn().mockResolvedValue(5),
      getJettonWallet: vi.fn().mockResolvedValue(
        "0:aabbccdd1234567890abcdef1234567890abcdef1234567890abcdef12345678",
      ),
      getRelayAddress: vi.fn().mockResolvedValue(
        "0:ee1a000000000000000000000000000000000000000000000000000000000000",
      ),
      gaslessEstimate: vi.fn().mockResolvedValue([
        {
          address: "0:aabbccdd1234567890abcdef1234567890abcdef1234567890abcdef12345678",
          amount: "100000000",
          payload: null,
        },
      ]),
      signTransfer: vi.fn().mockResolvedValue("te6cckEBAgEA...base64boc"),
    };
    client = new ExactTvmScheme(mockSigner);
  });

  describe("Construction", () => {
    it("should create instance with signer", () => {
      expect(client).toBeDefined();
      expect(client.scheme).toBe("exact");
    });
  });

  describe("createPaymentPayload", () => {
    it("should create payment payload with correct x402Version", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.x402Version).toBe(2);
    });

    it("should resolve jetton wallet address", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockSigner.getJettonWallet).toHaveBeenCalledWith(
        USDT_MASTER,
        mockSigner.address,
      );
    });

    it("should get relay address", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockSigner.getRelayAddress).toHaveBeenCalled();
    });

    it("should estimate gasless fees", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockSigner.gaslessEstimate).toHaveBeenCalled();
    });

    it("should sign transfer with seqno", async () => {
      await client.createPaymentPayload(2, mockRequirements);
      expect(mockSigner.getSeqno).toHaveBeenCalled();
      expect(mockSigner.signTransfer).toHaveBeenCalled();
      const signCall = (mockSigner.signTransfer as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(signCall[0]).toBe(5); // seqno
    });

    it("should include sender address in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.from).toBe(mockSigner.address);
    });

    it("should include recipient in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.to).toBe(mockRequirements.payTo);
    });

    it("should include token master in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.tokenMaster).toBe(USDT_MASTER);
    });

    it("should include amount in payload", async () => {
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.amount).toBe("10000");
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

    it("should set validUntil in the future", async () => {
      const beforeTime = Math.floor(Date.now() / 1000);
      const result = await client.createPaymentPayload(2, mockRequirements);
      expect(result.payload.validUntil).toBeGreaterThan(beforeTime);
    });
  });
});
