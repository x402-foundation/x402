import { describe, it, expect } from "vitest";
import { DefaultErrorClassifier, ErrorCategory, createErrorClassifier } from "../src/classifier";

describe("DefaultErrorClassifier", () => {
  const classifier = new DefaultErrorClassifier();

  describe("Network Errors (Non-HTTP)", () => {
    it("should NOT classify ECONNREFUSED as retryable (no HTTP status)", () => {
      const error = { code: "ECONNREFUSED", message: "Connection refused" };
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it("should NOT classify ENOTFOUND as retryable (no HTTP status)", () => {
      const error = { code: "ENOTFOUND", message: "DNS lookup failed" };
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it("should NOT classify ETIMEDOUT as retryable (no HTTP status)", () => {
      const error = { code: "ETIMEDOUT", message: "Request timed out" };
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it("should NOT classify TypeError as retryable", () => {
      const error = new TypeError("fetch failed");
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it("should NOT classify generic errors as retryable", () => {
      const error = new Error("Unable to fetch user profile from network database");
      expect(classifier.isRetryable(error)).toBe(false);
    });
  });

  describe("HTTP Status Codes - Retryable", () => {
    it("should classify 429 (Rate Limit) as retryable", () => {
      const error = { status: 429 };
      expect(classifier.isRetryable(error)).toBe(true);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.RETRYABLE);
    });

    it("should classify 500 (Internal Server Error) as retryable", () => {
      const error = { status: 500 };
      expect(classifier.isRetryable(error)).toBe(true);
    });

    it("should classify 502 (Bad Gateway) as retryable", () => {
      const error = { status: 502 };
      expect(classifier.isRetryable(error)).toBe(true);
    });

    it("should classify 503 (Service Unavailable) as retryable", () => {
      const error = { status: 503 };
      expect(classifier.isRetryable(error)).toBe(true);
    });

    it("should classify 504 (Gateway Timeout) as retryable", () => {
      const error = { status: 504 };
      expect(classifier.isRetryable(error)).toBe(true);
    });

    it("should handle axios-style error structure", () => {
      const error = {
        response: { status: 503 },
        message: "Request failed",
      };
      expect(classifier.isRetryable(error)).toBe(true);
    });
  });

  describe("HTTP Status Codes - Non-Retryable", () => {
    it("should classify 400 (Bad Request) as non-retryable", () => {
      const error = { status: 400 };
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.NON_RETRYABLE);
    });

    it("should classify 401 (Unauthorized) as non-retryable", () => {
      const error = { status: 401 };
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should classify 403 (Forbidden) as non-retryable", () => {
      const error = { status: 403 };
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should classify 404 (Not Found) as non-retryable", () => {
      const error = { status: 404 };
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should classify 409 (Conflict) as non-retryable", () => {
      const error = { status: 409 };
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should classify 422 (Unprocessable Entity) as non-retryable", () => {
      const error = { status: 422 };
      expect(classifier.isRetryable(error)).toBe(false);
    });
  });

  describe("Facilitator Errors", () => {
    it("should NOT classify unknown facilitator errors as retryable by default", () => {
      const error = { errorReason: "settle_exact_evm_transaction_confirmation_timed_out" };
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it("should NOT classify facilitator errors as retryable without documented codes", () => {
      const error = { errorReason: "network_temporarily_unavailable" };
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it("should treat facilitator errors with errorReason as unknown", () => {
      const error = { errorReason: "some_unknown_facilitator_error" };
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });
  });

  describe("Timeout Errors", () => {
    it("should NOT classify timeout error messages as retryable without HTTP status", () => {
      const error = new Error("Request timeout exceeded");
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it('should NOT classify "timed out" messages as retryable without HTTP status', () => {
      const error = new Error("Operation timed out");
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should classify HTTP 504 (Gateway Timeout) as retryable", () => {
      const error = { status: 504 };
      expect(classifier.isRetryable(error)).toBe(true);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.RETRYABLE);
    });
  });

  describe("Unknown Errors", () => {
    it("should classify unknown errors as non-retryable by default", () => {
      const error = new Error("Some random error");
      expect(classifier.isRetryable(error)).toBe(false);
      expect(classifier.classifyError(error)).toBe(ErrorCategory.UNKNOWN);
    });

    it("should classify unknown HTTP codes as non-retryable", () => {
      const error = { status: 418 }; // I'm a teapot
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should handle null errors safely", () => {
      expect(classifier.isRetryable(null)).toBe(false);
    });

    it("should handle undefined errors safely", () => {
      expect(classifier.isRetryable(undefined)).toBe(false);
    });

    it("should handle string errors safely", () => {
      expect(classifier.isRetryable("error string")).toBe(false);
    });

    it("should handle number errors safely", () => {
      expect(classifier.isRetryable(500)).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle errors with multiple properties", () => {
      const error = {
        status: 503,
        errorReason: "network_temporarily_unavailable",
        message: "Service unavailable",
      };
      expect(classifier.isRetryable(error)).toBe(true);
    });

    it("should prioritize HTTP status over facilitator errors", () => {
      const error = {
        status: 400,
        errorReason: "network_temporarily_unavailable",
      };
      // HTTP error check comes first, so should be non-retryable
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should handle empty errorReason", () => {
      const error = { errorReason: "" };
      expect(classifier.isRetryable(error)).toBe(false);
    });

    it("should handle non-string errorReason", () => {
      const error = { errorReason: 123 };
      expect(classifier.isRetryable(error)).toBe(false);
    });
  });
});

describe("createErrorClassifier", () => {
  it("should create classifier with custom retryable HTTP codes", () => {
    const classifier = createErrorClassifier({
      retryableHttpCodes: [418],
    });

    const error = { status: 418 };
    expect(classifier.isRetryable(error)).toBe(true);
  });

  it("should create classifier with custom non-retryable HTTP codes", () => {
    const classifier = createErrorClassifier({
      nonRetryableHttpCodes: [503],
    });

    const error = { status: 503 };
    // Still retryable by default, but now also in non-retryable set
    expect(classifier.isRetryable(error)).toBe(true);
  });

  it("should create classifier with multiple custom HTTP code rules", () => {
    const classifier = createErrorClassifier({
      retryableHttpCodes: [418, 420],
      nonRetryableHttpCodes: [451],
    });

    expect(classifier.isRetryable({ status: 418 })).toBe(true);
    expect(classifier.isRetryable({ status: 420 })).toBe(true);
    expect(classifier.isRetryable({ status: 451 })).toBe(false);
  });

  it("should work without any options", () => {
    const classifier = createErrorClassifier();
    expect(classifier.isRetryable({ status: 503 })).toBe(true);
  });
});
