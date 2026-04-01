import { describe, it, expect, vi, beforeEach } from "vitest";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  buildSupportedResponse,
  buildVerifyResponse,
  buildSettleResponse,
  buildPaymentPayload,
  buildPaymentRequirements,
} from "../../mocks";
import { Network } from "../../../src/types";

describe("x402ResourceServer - Hook Error Isolation", () => {
  let server: x402ResourceServer;
  let mockFacilitator: MockFacilitatorClient;

  beforeEach(async () => {
    mockFacilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "test-scheme", network: "test:network" as Network }],
      }),
      buildVerifyResponse({ isValid: true }),
      buildSettleResponse({
        success: true,
        transaction: "0xSettledTx",
        network: "test:network" as Network,
      }),
    );

    server = new x402ResourceServer(mockFacilitator);
    await server.initialize();
  });

  describe("afterVerify error isolation", () => {
    it("should return successful verify result even if afterVerify hook throws", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      server.onAfterVerify(async () => {
        throw new Error("afterVerify hook crashed");
      });

      const result = await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

      expect(result.isValid).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith("Error in afterVerify hook:", expect.any(Error));

      consoleSpy.mockRestore();
    });

    it("should continue executing remaining afterVerify hooks after one throws", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let secondHookCalled = false;

      server
        .onAfterVerify(async () => {
          throw new Error("First hook throws");
        })
        .onAfterVerify(async () => {
          secondHookCalled = true;
        });

      const result = await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

      expect(result.isValid).toBe(true);
      expect(secondHookCalled).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  describe("onVerifyFailure error isolation", () => {
    it("should propagate original error even if onVerifyFailure hook throws", async () => {
      mockFacilitator.setVerifyResponse(new Error("Original verification error"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      server.onVerifyFailure(async () => {
        throw new Error("Failure hook also crashed");
      });

      await expect(
        server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements()),
      ).rejects.toThrow("Original verification error");

      expect(consoleSpy).toHaveBeenCalledWith("Error in onVerifyFailure hook:", expect.any(Error));

      consoleSpy.mockRestore();
    });

    it("should still allow recovery even with error isolation", async () => {
      mockFacilitator.setVerifyResponse(new Error("Verification failed"));

      server.onVerifyFailure(async () => {
        return {
          recovered: true,
          result: { isValid: true, payer: "0xRecovered" },
        };
      });

      const result = await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe("0xRecovered");
    });

    it("should try subsequent failure hooks if first one throws", async () => {
      mockFacilitator.setVerifyResponse(new Error("Verification failed"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      server
        .onVerifyFailure(async () => {
          throw new Error("First failure hook crashes");
        })
        .onVerifyFailure(async () => {
          return {
            recovered: true,
            result: { isValid: true, payer: "0xRecoveredBySecond" },
          };
        });

      const result = await server.verifyPayment(buildPaymentPayload(), buildPaymentRequirements());

      expect(result.isValid).toBe(true);
      expect(result.payer).toBe("0xRecoveredBySecond");

      consoleSpy.mockRestore();
    });
  });

  describe("afterSettle error isolation", () => {
    it("should return successful settlement even if afterSettle hook throws", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      server.onAfterSettle(async () => {
        throw new Error("afterSettle hook crashed (e.g. external API failed)");
      });

      const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

      // Settlement succeeded — must return result despite hook error
      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xSettledTx");
      expect(consoleSpy).toHaveBeenCalledWith("Error in afterSettle hook:", expect.any(Error));

      consoleSpy.mockRestore();
    });

    it("should continue executing remaining afterSettle hooks after one throws", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let secondHookCalled = false;

      server
        .onAfterSettle(async () => {
          throw new Error("First hook throws");
        })
        .onAfterSettle(async () => {
          secondHookCalled = true;
        });

      const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

      expect(result.success).toBe(true);
      expect(secondHookCalled).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  describe("onSettleFailure error isolation", () => {
    it("should propagate original error even if onSettleFailure hook throws", async () => {
      mockFacilitator.setSettleResponse(new Error("Original settlement error"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      server.onSettleFailure(async () => {
        throw new Error("Failure hook also crashed");
      });

      await expect(
        server.settlePayment(buildPaymentPayload(), buildPaymentRequirements()),
      ).rejects.toThrow("Original settlement error");

      expect(consoleSpy).toHaveBeenCalledWith("Error in onSettleFailure hook:", expect.any(Error));

      consoleSpy.mockRestore();
    });

    it("should still allow recovery even with error isolation", async () => {
      mockFacilitator.setSettleResponse(new Error("Settlement failed"));

      server.onSettleFailure(async () => {
        return {
          recovered: true,
          result: {
            success: true,
            transaction: "0xRecoveredTx",
            network: "test:network",
          },
        };
      });

      const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xRecoveredTx");
    });

    it("should try subsequent failure hooks if first one throws", async () => {
      mockFacilitator.setSettleResponse(new Error("Settlement failed"));

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      server
        .onSettleFailure(async () => {
          throw new Error("First failure hook crashes");
        })
        .onSettleFailure(async () => {
          return {
            recovered: true,
            result: {
              success: true,
              transaction: "0xRecoveredBySecond",
              network: "test:network",
            },
          };
        });

      const result = await server.settlePayment(buildPaymentPayload(), buildPaymentRequirements());

      expect(result.success).toBe(true);
      expect(result.transaction).toBe("0xRecoveredBySecond");

      consoleSpy.mockRestore();
    });
  });
});
