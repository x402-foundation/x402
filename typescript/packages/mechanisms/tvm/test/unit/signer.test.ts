import { describe, it, expect, vi } from "vitest";
import type { ClientTvmSigner, FacilitatorTvmSigner } from "../../src/signer";

describe("TVM Signer Types", () => {
  describe("ClientTvmSigner", () => {
    it("should have required properties", () => {
      const mockSigner: ClientTvmSigner = {
        address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        publicKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        getSeqno: vi.fn().mockResolvedValue(5),
        getJettonWallet: vi.fn().mockResolvedValue("0:jettonwallet"),
        getRelayAddress: vi.fn().mockResolvedValue("0:relayaddress"),
        gaslessEstimate: vi.fn().mockResolvedValue([]),
        signTransfer: vi.fn().mockResolvedValue("base64boc"),
      };

      expect(mockSigner.address).toBeDefined();
      expect(mockSigner.publicKey).toBeDefined();
      expect(mockSigner.getSeqno).toBeDefined();
      expect(mockSigner.getJettonWallet).toBeDefined();
      expect(mockSigner.getRelayAddress).toBeDefined();
      expect(mockSigner.gaslessEstimate).toBeDefined();
      expect(mockSigner.signTransfer).toBeDefined();
    });

    it("should return seqno from getSeqno", async () => {
      const mockSigner: ClientTvmSigner = {
        address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        publicKey: "abcdef1234567890",
        getSeqno: vi.fn().mockResolvedValue(42),
        getJettonWallet: vi.fn().mockResolvedValue("0:addr"),
        getRelayAddress: vi.fn().mockResolvedValue("0:relay"),
        gaslessEstimate: vi.fn().mockResolvedValue([]),
        signTransfer: vi.fn().mockResolvedValue("boc"),
      };

      const seqno = await mockSigner.getSeqno();
      expect(seqno).toBe(42);
    });
  });

  describe("FacilitatorTvmSigner", () => {
    it("should have gaslessSend method", () => {
      const mockSigner: FacilitatorTvmSigner = {
        gaslessSend: vi.fn().mockResolvedValue("gasless-ok"),
      };

      expect(mockSigner.gaslessSend).toBeDefined();
    });

    it("should call gaslessSend with boc and publicKey", async () => {
      const mockSigner: FacilitatorTvmSigner = {
        gaslessSend: vi.fn().mockResolvedValue("gasless-ok"),
      };

      const result = await mockSigner.gaslessSend("base64boc", "pubkeyhex");
      expect(mockSigner.gaslessSend).toHaveBeenCalledWith("base64boc", "pubkeyhex");
      expect(result).toBe("gasless-ok");
    });
  });
});
