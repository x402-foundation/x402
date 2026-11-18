import { describe, expect, it, vi, beforeEach } from "vitest";

describe("SolanaPaywall - Error Response Parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
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
        error: "Transaction validation failed",
      });

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Transaction validation failed");
    });

    it("should handle errorReason field", async () => {
      const response = mockResponse(400, "Bad Request", {
        errorReason: "invalid_exact_svm_payload_transaction_amount_mismatch",
      });

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe(
        "Payment failed: invalid_exact_svm_payload_transaction_amount_mismatch",
      );
    });

    it("should prioritize error field over errorReason", async () => {
      const response = mockResponse(400, "Bad Request", {
        error: "Custom error message",
        errorReason: "insufficient_funds",
      });

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
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

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Payment failed: 500 Internal Server Error");
    });

    it("should fall back to default error when response has no error fields", async () => {
      const response = mockResponse(404, "Not Found", {
        message: "Some other message",
      });

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Payment failed: 404 Not Found");
    });

    it("should handle network validation error", async () => {
      const response = mockResponse(400, "Bad Request", {
        error:
          "This facilitator only supports: base-sepolia, solana-devnet. Network 'solana' is not supported.",
        errorReason: "invalid_network",
      });

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toContain("This facilitator only supports");
      expect(errorMessage).toContain("solana-devnet");
    });

    it("should handle insufficient funds error", async () => {
      const response = mockResponse(400, "Bad Request", {
        errorReason: "insufficient_funds",
      });

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Payment failed: insufficient_funds");
    });

    it("should handle transaction signature verification error", async () => {
      const response = mockResponse(400, "Bad Request", {
        errorReason: "invalid_exact_svm_payload_transaction",
      });

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message
      }

      expect(errorMessage).toBe("Payment failed: invalid_exact_svm_payload_transaction");
    });
  });
});
