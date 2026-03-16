import { describe, it, expect, vi } from "vitest";
import type { ClientTvmSigner } from "../../src/signer";

describe("TVM Signer Types", () => {
  describe("ClientTvmSigner", () => {
    it("should have required properties", () => {
      const mockSigner: ClientTvmSigner = {
        address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        publicKey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        signTransfer: vi.fn().mockResolvedValue("base64boc"),
      };

      expect(mockSigner.address).toBeDefined();
      expect(mockSigner.publicKey).toBeDefined();
      expect(mockSigner.signTransfer).toBeDefined();
    });

    it("should return boc from signTransfer", async () => {
      const mockSigner: ClientTvmSigner = {
        address: "0:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        publicKey: "abcdef1234567890",
        signTransfer: vi.fn().mockResolvedValue("boc"),
      };

      const boc = await mockSigner.signTransfer(42, 1700000000, []);
      expect(boc).toBe("boc");
    });
  });
});
