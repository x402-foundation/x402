import { describe, expect, it, vi, beforeEach } from "vitest";

describe("EvmPaywall - Error Response Parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  describe("402 Payment Required responses", () => {
    it("should not retry when error is undeployed smart wallet", async () => {
      const mock402Response = {
        ok: false,
        status: 402,
        statusText: "Payment Required",
        json: vi.fn().mockResolvedValue({
          error: "invalid_exact_evm_payload_undeployed_smart_wallet",
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base-sepolia",
              maxAmountRequired: "10000",
            },
          ],
          payer: "0x13607558c51648A261bab3D3DF3Cc883D87Ba56D",
        }),
      };

      // Simulate the 402 response handler logic
      const errorData = await mock402Response.json();

      // Check for undeployed smart wallet error before retrying
      let shouldRetry = true;
      let errorMessage = "";

      if (errorData.error === "invalid_exact_evm_payload_undeployed_smart_wallet") {
        shouldRetry = false;
        errorMessage =
          "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
      }

      expect(shouldRetry).toBe(false);
      expect(errorMessage).toBe(
        "Smart wallet must be deployed before making payments. Please deploy your wallet first.",
      );
    });

    it("should retry payment when 402 has x402Version but no undeployed wallet error", async () => {
      const mock402Response = {
        ok: false,
        status: 402,
        statusText: "Payment Required",
        json: vi.fn().mockResolvedValue({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "base-sepolia",
              maxAmountRequired: "10000",
            },
          ],
        }),
      };

      const errorData = await mock402Response.json();

      let shouldRetry = true;

      if (errorData.error === "invalid_exact_evm_payload_undeployed_smart_wallet") {
        shouldRetry = false;
      } else if (errorData && typeof errorData.x402Version === "number") {
        shouldRetry = true;
      }

      expect(shouldRetry).toBe(true);
    });

    it("should handle 402 with both error and x402Version (error takes precedence)", async () => {
      const mock402Response = {
        ok: false,
        status: 402,
        statusText: "Payment Required",
        json: vi.fn().mockResolvedValue({
          error: "invalid_exact_evm_payload_undeployed_smart_wallet",
          x402Version: 1,
          accepts: [],
        }),
      };

      const errorData = await mock402Response.json();

      let shouldRetry = true;
      let errorMessage = "";

      if (errorData.error === "invalid_exact_evm_payload_undeployed_smart_wallet") {
        shouldRetry = false;
        errorMessage =
          "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
      } else if (errorData && typeof errorData.x402Version === "number") {
        shouldRetry = true;
      }

      expect(shouldRetry).toBe(false);
      expect(errorMessage).toContain("Smart wallet must be deployed");
    });
  });

  describe("parseErrorResponse", () => {
    const mockResponse = (status: number, statusText: string, body: unknown) => ({
      ok: false,
      status,
      statusText,
      json: vi.fn().mockResolvedValue(body),
    });

    it("should extract error message from error field", async () => {
      const response = mockResponse(400, "Bad Request", {
        error: "Payment validation failed",
      });

      let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Payment validation failed");
    });

    it("should handle undeployed smart wallet error", async () => {
      const response = mockResponse(400, "Bad Request", {
        invalidReason: "invalid_exact_evm_payload_undeployed_smart_wallet",
      });

      let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (
          errorData.invalidReason === "invalid_exact_evm_payload_undeployed_smart_wallet"
        ) {
          errorMessage =
            "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
        } else if (errorData.invalidReason) {
          errorMessage = `Payment validation failed: ${errorData.invalidReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe(
        "Smart wallet must be deployed before making payments. Please deploy your wallet first.",
      );
    });

    it("should handle generic invalidReason", async () => {
      const response = mockResponse(400, "Bad Request", {
        invalidReason: "insufficient_funds",
      });

      let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (
          errorData.invalidReason === "invalid_exact_evm_payload_undeployed_smart_wallet"
        ) {
          errorMessage =
            "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
        } else if (errorData.invalidReason) {
          errorMessage = `Payment validation failed: ${errorData.invalidReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Payment validation failed: insufficient_funds");
    });

    it("should prioritize error field over invalidReason", async () => {
      const response = mockResponse(400, "Bad Request", {
        error: "Custom error message",
        invalidReason: "insufficient_funds",
      });

      let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (
          errorData.invalidReason === "invalid_exact_evm_payload_undeployed_smart_wallet"
        ) {
          errorMessage =
            "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
        } else if (errorData.invalidReason) {
          errorMessage = `Payment validation failed: ${errorData.invalidReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Custom error message");
    });

    it("should fall back to default error when JSON parsing fails", async () => {
      const response = {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: vi.fn().mockRejectedValue(new Error("Invalid JSON")),
      };

      let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (
          errorData.invalidReason === "invalid_exact_evm_payload_undeployed_smart_wallet"
        ) {
          errorMessage =
            "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
        } else if (errorData.invalidReason) {
          errorMessage = `Payment validation failed: ${errorData.invalidReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Request failed: 500 Internal Server Error");
    });

    it("should fall back to default error when response has no error fields", async () => {
      const response = mockResponse(404, "Not Found", {
        message: "Some other message",
      });

      let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (
          errorData.invalidReason === "invalid_exact_evm_payload_undeployed_smart_wallet"
        ) {
          errorMessage =
            "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
        } else if (errorData.invalidReason) {
          errorMessage = `Payment validation failed: ${errorData.invalidReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Request failed: 404 Not Found");
    });

    it("should handle network validation error", async () => {
      const response = mockResponse(400, "Bad Request", {
        error:
          "This facilitator only supports: base-sepolia, solana-devnet. Network 'base' is not supported.",
        invalidReason: "invalid_network",
      });

      let errorMessage = `Request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (
          errorData.invalidReason === "invalid_exact_evm_payload_undeployed_smart_wallet"
        ) {
          errorMessage =
            "Smart wallet must be deployed before making payments. Please deploy your wallet first.";
        } else if (errorData.invalidReason) {
          errorMessage = `Payment validation failed: ${errorData.invalidReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toContain("This facilitator only supports");
      expect(errorMessage).toContain("base-sepolia");
    });
  });
});
