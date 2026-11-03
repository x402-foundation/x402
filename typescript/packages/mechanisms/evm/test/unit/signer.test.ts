import { describe, it, expect, vi } from "vitest";
import { toFacilitatorEvmSigner } from "../../src/signer";

describe("EVM Signer Converters", () => {
  describe("toFacilitatorEvmSigner", () => {
    it("should wrap client with getAddresses() method", () => {
      const mockClient = {
        address: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        readContract: async () => BigInt(0),
        verifyTypedData: async () => true,
        writeContract: async () => "0xtxhash" as `0x${string}`,
        waitForTransactionReceipt: async () => ({ status: "success" }),
        getCode: async () => "0x" as `0x${string}`,
      };

      const result = toFacilitatorEvmSigner(mockClient);

      // Should add getAddresses() method
      expect(result.getAddresses).toBeDefined();
      expect(result.getAddresses()).toEqual([mockClient.address]);

      // Should preserve all other methods
      expect(result.readContract).toBe(mockClient.readContract);
      expect(result.verifyTypedData).toBe(mockClient.verifyTypedData);
      expect(result.writeContract).toBe(mockClient.writeContract);
      expect(result.getCode).toBe(mockClient.getCode);
    });

    // The bound is what makes settlement_pending reachable: viem's 3 minute default outlives
    // the request deadline on most serverless platforms, so the process is killed mid-wait.
    describe("receipt wait bound", () => {
      const hash = `0x${"ab".repeat(32)}` as `0x${string}`;
      const clientWith = (waitForTransactionReceipt: unknown) =>
        ({
          address: "0x1234567890123456789012345678901234567890",
          waitForTransactionReceipt,
        }) as never;

      it("defaults to viem's 180s bound", async () => {
        const wait = vi.fn().mockResolvedValue({ status: "success" });

        await toFacilitatorEvmSigner(clientWith(wait)).waitForTransactionReceipt({ hash });

        expect(wait).toHaveBeenCalledWith({ hash, timeout: 180_000 });
      });

      it("applies a configured confirmationTimeoutMs", async () => {
        const wait = vi.fn().mockResolvedValue({ status: "success" });

        await toFacilitatorEvmSigner(clientWith(wait), {
          confirmationTimeoutMs: 25_000,
        }).waitForTransactionReceipt({ hash });

        expect(wait).toHaveBeenCalledWith({ hash, timeout: 25_000 });
      });
    });
  });
});
