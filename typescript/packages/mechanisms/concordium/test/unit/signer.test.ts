import { describe, it, expect, vi } from "vitest";
import type { FacilitatorConcordiumSigner, GrpcConfig } from "../../src/signer";

describe("Concordium Signer", () => {
  describe("GrpcConfig", () => {
    it("should accept minimal config", () => {
      const config: GrpcConfig = { host: "grpc.testnet.concordium.com", port: 20000 };
      expect(config.host).toBeDefined();
      expect(config.port).toBe(20000);
      expect(config.useTls).toBeUndefined();
    });

    it("should accept config with TLS flag", () => {
      const config: GrpcConfig = { host: "localhost", port: 20000, useTls: false };
      expect(config.useTls).toBe(false);
    });
  });

  describe("FacilitatorConcordiumSigner interface", () => {
    function createMockSigner(sponsorAddress: string): FacilitatorConcordiumSigner {
      return {
        getAddress: () => sponsorAddress,
        getNetwork: () => "ccd:*",
        getAccountInfo: vi.fn().mockResolvedValue({
          accountAddress: sponsorAddress,
          accountThreshold: 1,
          accountCredentials: {},
        }),
        getTokenBalance: vi.fn().mockResolvedValue(1_000_000n),
        getTokenDecimals: vi.fn().mockResolvedValue(6),
        addSponsorSignature: vi.fn().mockResolvedValue({
          version: 1,
          header: {},
          payload: {},
          signatures: { sender: {}, sponsor: { "0": { "0": "sponsor-sig" } } },
        }),
        submitTransaction: vi.fn().mockResolvedValue("abcdef1234567890"),
        waitForFinalization: vi.fn().mockResolvedValue({
          txHash: "abcdef1234567890",
          status: "finalized",
          sender: "3kBx2h5Y2veb4hZvAE2c1Zr6DYJwWbPr9xQJJBPWyFnXHF9UuN",
          recipient: sponsorAddress,
          amount: "1000000",
          asset: "CCD",
        }),
      };
    }

    it("should return sponsor address", () => {
      const address = "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW";
      const signer = createMockSigner(address);
      expect(signer.getAddress()).toBe(address);
    });

    it("should implement all required methods", () => {
      const signer = createMockSigner("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW");
      expect(signer.getAddress).toBeDefined();
      expect(signer.getAccountInfo).toBeDefined();
      expect(signer.getTokenBalance).toBeDefined();
      expect(signer.addSponsorSignature).toBeDefined();
      expect(signer.submitTransaction).toBeDefined();
      expect(signer.waitForFinalization).toBeDefined();
    });

    it("should return finalized transaction info from waitForFinalization", async () => {
      const signer = createMockSigner("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW");
      const info = await signer.waitForFinalization("abcdef1234567890");

      expect(info.status).toBe("finalized");
      expect(info.txHash).toBe("abcdef1234567890");
      expect(info.amount).toBe("1000000");
      expect(info.asset).toBe("CCD");
    });

    it("should return tx hash from submitTransaction", async () => {
      const signer = createMockSigner("4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW");
      const hash = await signer.submitTransaction({} as any);
      expect(hash).toBe("abcdef1234567890");
    });
  });
});
