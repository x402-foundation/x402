import { describe, it, expect, vi, beforeEach } from "vitest";
import { useFacilitator } from "./useFacilitator";
import { PaymentPayload, PaymentRequirements, SettleError, VerifyError } from "../types/verify";

describe("useFacilitator", () => {
  const mockPaymentPayload: PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0x1234567890123456789012345678901234567890123456789012345678901234",
      authorization: {
        from: "0x1234567890123456789012345678901234567890",
        to: "0x1234567890123456789012345678901234567890",
        value: "1000000",
        validAfter: "1234567890",
        validBefore: "1234567899",
        nonce: "1234567890",
      },
    },
  };

  const mockPaymentRequirements: PaymentRequirements = {
    scheme: "exact",
    network: "base-sepolia",
    maxAmountRequired: "1000000",
    resource: "https://example.com/resource",
    description: "Test resource",
    mimeType: "application/json",
    payTo: "0x1234567890123456789012345678901234567890",
    maxTimeoutSeconds: 300,
    asset: "0x1234567890123456789012345678901234567890",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: "OK",
      json: async () => ({ isValid: true, success: true }),
    });
  });

  describe("verify", () => {
    it("should call fetch with the correct data and default URL", async () => {
      const { verify } = useFacilitator();
      await verify(mockPaymentPayload, mockPaymentRequirements);

      expect(fetch).toHaveBeenCalledWith("https://x402.org/facilitator/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: mockPaymentPayload.x402Version,
          paymentPayload: mockPaymentPayload,
          paymentRequirements: mockPaymentRequirements,
        }),
      });
    });

    it("should use custom URL when provided", async () => {
      const customUrl = "https://custom-facilitator.org";
      const { verify } = useFacilitator({ url: customUrl });
      await verify(mockPaymentPayload, mockPaymentRequirements);

      expect(fetch).toHaveBeenCalledWith(`${customUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: mockPaymentPayload.x402Version,
          paymentPayload: mockPaymentPayload,
          paymentRequirements: mockPaymentRequirements,
        }),
      });
    });

    it("should include auth headers when createAuthHeaders is provided", async () => {
      const mockHeaders = {
        verify: { Authorization: "Bearer test-token" },
        settle: { Authorization: "Bearer test-token" },
        supported: { Authorization: "Bearer test-token" },
      };
      const { verify } = useFacilitator({
        url: "https://x402.org/facilitator",
        createAuthHeaders: async () => mockHeaders,
      });
      await verify(mockPaymentPayload, mockPaymentRequirements);

      expect(fetch).toHaveBeenCalledWith(
        "https://x402.org/facilitator/verify",
        expect.objectContaining({
          headers: { "Content-Type": "application/json", ...mockHeaders.verify },
        }),
      );
    });

    it("should throw VerifyError when 400 response has isValid field", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 400,
        statusText: "Bad Request",
        json: async () => ({
          isValid: false,
          invalidReason: "invalid_network",
          payer: "0x1234",
        }),
      });
      const { verify } = useFacilitator();

      await expect(verify(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow(
        VerifyError,
      );
      try {
        await verify(mockPaymentPayload, mockPaymentRequirements);
      } catch (e) {
        expect(e).toBeInstanceOf(VerifyError);
        expect((e as VerifyError).invalidReason).toBe("invalid_network");
        expect((e as VerifyError).statusCode).toBe(400);
      }
    });

    it("should throw generic error when 400 response lacks isValid field", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: "some error" }),
      });
      const { verify } = useFacilitator();

      await expect(verify(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow(
        "Failed to verify payment: 400 Bad Request",
      );
    });

    it("should throw when JSON parsing fails", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
        json: async () => {
          throw new Error("Invalid JSON");
        },
      });
      const { verify } = useFacilitator();

      await expect(verify(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow();
    });
  });

  describe("settle", () => {
    it("should call fetch with the correct data and default URL", async () => {
      const { settle } = useFacilitator();
      await settle(mockPaymentPayload, mockPaymentRequirements);

      expect(fetch).toHaveBeenCalledWith("https://x402.org/facilitator/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: mockPaymentPayload.x402Version,
          paymentPayload: mockPaymentPayload,
          paymentRequirements: mockPaymentRequirements,
        }),
      });
    });

    it("should use custom URL when provided", async () => {
      const customUrl = "https://custom-facilitator.org";
      const { settle } = useFacilitator({ url: customUrl });
      await settle(mockPaymentPayload, mockPaymentRequirements);

      expect(fetch).toHaveBeenCalledWith(`${customUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: mockPaymentPayload.x402Version,
          paymentPayload: mockPaymentPayload,
          paymentRequirements: mockPaymentRequirements,
        }),
      });
    });

    it("should include auth headers when createAuthHeaders is provided", async () => {
      const mockHeaders = {
        verify: { Authorization: "Bearer test-token" },
        settle: { Authorization: "Bearer test-token" },
        supported: { Authorization: "Bearer test-token" },
      };
      const { settle } = useFacilitator({
        url: "https://x402.org/facilitator",
        createAuthHeaders: async () => mockHeaders,
      });
      await settle(mockPaymentPayload, mockPaymentRequirements);

      expect(fetch).toHaveBeenCalledWith(
        "https://x402.org/facilitator/settle",
        expect.objectContaining({
          headers: { "Content-Type": "application/json", ...mockHeaders.settle },
        }),
      );
    });

    it("should throw SettleError when 400 response has success field", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 400,
        statusText: "Bad Request",
        json: async () => ({
          success: false,
          errorReason: "insufficient_allowance",
          network: "base-sepolia",
          transaction: "",
        }),
      });
      const { settle } = useFacilitator();

      await expect(settle(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow(
        SettleError,
      );
      try {
        await settle(mockPaymentPayload, mockPaymentRequirements);
      } catch (e) {
        expect(e).toBeInstanceOf(SettleError);
        expect((e as SettleError).errorReason).toBe("insufficient_allowance");
        expect((e as SettleError).statusCode).toBe(400);
      }
    });

    it("should throw generic error when 400 response lacks success field", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: "some error" }),
      });
      const { settle } = useFacilitator();

      await expect(settle(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow(
        "Failed to settle payment: 400 Bad Request",
      );
    });

    it("should throw when JSON parsing fails", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
        json: async () => {
          throw new Error("Invalid JSON");
        },
      });
      const { settle } = useFacilitator();

      await expect(settle(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow();
    });
  });

  describe("supported", () => {
    it("should call fetch with the correct default URL", async () => {
      const { supported } = useFacilitator();
      await supported();

      expect(fetch).toHaveBeenCalledWith("https://x402.org/facilitator/supported", {
        headers: { "Content-Type": "application/json" },
        method: "GET",
      });
    });

    it("should call fetch with the correct custom URL", async () => {
      const { supported } = useFacilitator({ url: "https://custom-facilitator.org" });
      await supported();

      expect(fetch).toHaveBeenCalledWith("https://custom-facilitator.org/supported", {
        headers: { "Content-Type": "application/json" },
        method: "GET",
      });
    });

    it("should throw error on non-200 response", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 500,
        statusText: "Internal Server Error",
      });

      const { supported } = useFacilitator();

      await expect(supported()).rejects.toThrow(
        "Failed to get supported payment kinds: Internal Server Error",
      );
    });
  });

  describe("list", () => {
    it("should call fetch with the correct URL and method", async () => {
      const { list } = useFacilitator();
      await list();

      expect(fetch).toHaveBeenCalledWith("https://x402.org/facilitator/discovery/resources?", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
    });

    it("should use custom URL when provided", async () => {
      const customUrl = "https://custom-facilitator.org";
      const { list } = useFacilitator({ url: customUrl });
      await list();

      expect(fetch).toHaveBeenCalledWith(`${customUrl}/discovery/resources?`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
    });

    it("should properly encode query parameters", async () => {
      const { list } = useFacilitator();
      const config = {
        type: "test-type",
        limit: 10,
        offset: 20,
      };
      await list(config);

      const expectedUrl =
        "https://x402.org/facilitator/discovery/resources?type=test-type&limit=10&offset=20";
      expect(fetch).toHaveBeenCalledWith(expectedUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
    });

    it("should filter out undefined query parameters", async () => {
      const { list } = useFacilitator();
      const config = {
        type: "test-type",
        limit: 10,
        offset: undefined,
      };
      await list(config);

      const expectedUrl =
        "https://x402.org/facilitator/discovery/resources?type=test-type&limit=10";
      expect(fetch).toHaveBeenCalledWith(expectedUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
    });

    it("should throw error on non-200 response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 400,
        statusText: "Bad Request",
        json: async () => ({}),
      });
      const { list } = useFacilitator();

      await expect(list()).rejects.toThrow("Failed to list discovery: 400 Bad Request");
    });
  });
});
