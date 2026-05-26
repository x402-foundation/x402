/**
 * Unit tests for MCP utils module
 */
import { describe, it, expect } from "vitest";
import {
  isObject,
  extractPaymentFromMeta,
  attachPaymentToMeta,
  extractPaymentResponseFromMeta,
  attachPaymentResponseToMeta,
  createPaymentRequiredError,
  extractPaymentRequiredFromError,
  createToolResourceUrl,
} from "../../src/utils/encoding";
import { MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY } from "../../src/types";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";

// ============================================================================
// Test Fixtures
// ============================================================================

const mockPaymentPayload: PaymentPayload = {
  x402Version: 2,
  payload: {
    signature: "0x123",
    authorization: {
      from: "0xabc",
      to: "0xdef",
      value: "1000",
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: "0x1",
    },
  },
};

const mockSettleResponse: SettleResponse = {
  success: true,
  transaction: "0xtxhash123",
  network: "eip155:84532",
};

const mockPaymentRequired: PaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000",
      asset: "0xtoken",
      payTo: "0xrecipient",
      maxAmountRequired: "1000",
      extra: {},
    },
  ],
  error: "Payment required",
  resource: {
    url: "mcp://tool/test",
    description: "Test tool",
    mimeType: "application/json",
  },
};

// ============================================================================
// isObject Tests
// ============================================================================

describe("isObject", () => {
  it("should return true for plain objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ key: "value" })).toBe(true);
    expect(isObject({ nested: { object: true } })).toBe(true);
  });

  it("should return true for arrays", () => {
    // Arrays are objects in JavaScript
    expect(isObject([])).toBe(true);
    expect(isObject([1, 2, 3])).toBe(true);
  });

  it("should return false for null", () => {
    expect(isObject(null)).toBe(false);
  });

  it("should return false for primitives", () => {
    expect(isObject(undefined)).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject("string")).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject(Symbol("test"))).toBe(false);
  });
});

// ============================================================================
// extractPaymentFromMeta Tests
// ============================================================================

describe("extractPaymentFromMeta", () => {
  it("should extract valid payment payload from _meta", () => {
    const params = {
      name: "test_tool",
      arguments: {},
      _meta: {
        [MCP_PAYMENT_META_KEY]: mockPaymentPayload,
      },
    };

    const result = extractPaymentFromMeta(params);
    expect(result).toEqual(mockPaymentPayload);
  });

  it("should return null if _meta is missing", () => {
    const params = {
      name: "test_tool",
      arguments: {},
    };

    expect(extractPaymentFromMeta(params)).toBeNull();
  });

  it("should return null if payment key is missing", () => {
    const params = {
      name: "test_tool",
      arguments: {},
      _meta: {},
    };

    expect(extractPaymentFromMeta(params)).toBeNull();
  });

  it("should return null if params is undefined", () => {
    expect(extractPaymentFromMeta(undefined)).toBeNull();
  });

  it("should return null if payment structure is invalid", () => {
    const params = {
      name: "test_tool",
      _meta: {
        [MCP_PAYMENT_META_KEY]: { invalid: "structure" },
      },
    };

    expect(extractPaymentFromMeta(params)).toBeNull();
  });
});

// ============================================================================
// attachPaymentToMeta Tests
// ============================================================================

describe("attachPaymentToMeta", () => {
  it("should attach payment payload to params", () => {
    const params = { name: "test_tool", arguments: { arg: "value" } };

    const result = attachPaymentToMeta(params, mockPaymentPayload);

    expect(result.name).toBe("test_tool");
    expect(result.arguments).toEqual({ arg: "value" });
    expect(result._meta?.[MCP_PAYMENT_META_KEY]).toEqual(mockPaymentPayload);
  });

  it("should work with empty arguments", () => {
    const params = { name: "test_tool" };

    const result = attachPaymentToMeta(params, mockPaymentPayload);

    expect(result._meta?.[MCP_PAYMENT_META_KEY]).toEqual(mockPaymentPayload);
  });

  it("should preserve existing metadata when attaching payment", () => {
    const params = {
      name: "test_tool",
      _meta: {
        traceId: "trace_123",
        authHint: { subject: "agent_1" },
      },
    };

    const result = attachPaymentToMeta(params, mockPaymentPayload);

    expect(result._meta?.traceId).toBe("trace_123");
    expect(result._meta?.authHint).toEqual({ subject: "agent_1" });
    expect(result._meta?.[MCP_PAYMENT_META_KEY]).toEqual(mockPaymentPayload);
  });
});

// ============================================================================
// extractPaymentResponseFromMeta Tests
// ============================================================================

describe("extractPaymentResponseFromMeta", () => {
  it("should extract valid settle response from _meta", () => {
    const result = {
      content: [{ type: "text", text: "result" }],
      _meta: {
        [MCP_PAYMENT_RESPONSE_META_KEY]: mockSettleResponse,
      },
    };

    const response = extractPaymentResponseFromMeta(result);
    expect(response).toEqual(mockSettleResponse);
  });

  it("should return null if _meta is missing", () => {
    const result = {
      content: [{ type: "text", text: "result" }],
    };

    expect(extractPaymentResponseFromMeta(result)).toBeNull();
  });

  it("should return null if result is undefined", () => {
    expect(extractPaymentResponseFromMeta(undefined)).toBeNull();
  });

  it("should return null if response structure is invalid", () => {
    const result = {
      content: [],
      _meta: {
        [MCP_PAYMENT_RESPONSE_META_KEY]: { invalid: "structure" },
      },
    };

    expect(extractPaymentResponseFromMeta(result)).toBeNull();
  });
});

// ============================================================================
// attachPaymentResponseToMeta Tests
// ============================================================================

describe("attachPaymentResponseToMeta", () => {
  it("should attach settle response to result", () => {
    const result = {
      content: [{ type: "text" as const, text: "result" }],
      isError: false,
    };

    const withMeta = attachPaymentResponseToMeta(result, mockSettleResponse);

    expect(withMeta.content).toEqual(result.content);
    expect(withMeta.isError).toBe(false);
    expect(withMeta._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
  });

  it("should preserve existing metadata when attaching settle response", () => {
    const result = {
      content: [{ type: "text" as const, text: "result" }],
      _meta: {
        traceId: "trace_123",
        evidence: { ledgerId: "ledger_1" },
      },
    };

    const withMeta = attachPaymentResponseToMeta(result, mockSettleResponse);

    expect(withMeta._meta?.traceId).toBe("trace_123");
    expect(withMeta._meta?.evidence).toEqual({ ledgerId: "ledger_1" });
    expect(withMeta._meta?.[MCP_PAYMENT_RESPONSE_META_KEY]).toEqual(mockSettleResponse);
  });
});

// ============================================================================
// createPaymentRequiredError Tests
// ============================================================================

describe("createPaymentRequiredError", () => {
  it("should create error with default message", () => {
    const error = createPaymentRequiredError(mockPaymentRequired);

    expect(error.code).toBe(402);
    expect(error.message).toBe("Payment required");
    expect(error.data).toEqual(mockPaymentRequired);
  });

  it("should create error with custom message", () => {
    const error = createPaymentRequiredError(mockPaymentRequired, "Custom error message");

    expect(error.code).toBe(402);
    expect(error.message).toBe("Custom error message");
    expect(error.data).toEqual(mockPaymentRequired);
  });
});

// ============================================================================
// extractPaymentRequiredFromError Tests
// ============================================================================

describe("extractPaymentRequiredFromError", () => {
  it("should extract PaymentRequired from valid error", () => {
    const error = {
      code: 402,
      message: "Payment required",
      data: mockPaymentRequired,
    };

    const result = extractPaymentRequiredFromError(error);
    expect(result).toEqual(mockPaymentRequired);
  });

  it("should return null for non-402 error code", () => {
    const error = {
      code: 500,
      message: "Server error",
      data: mockPaymentRequired,
    };

    expect(extractPaymentRequiredFromError(error)).toBeNull();
  });

  it("should return null for null error", () => {
    expect(extractPaymentRequiredFromError(null)).toBeNull();
  });

  it("should return null for non-object error", () => {
    expect(extractPaymentRequiredFromError("error")).toBeNull();
    expect(extractPaymentRequiredFromError(42)).toBeNull();
  });

  it("should return null if data is missing x402 fields", () => {
    const error = {
      code: 402,
      message: "Payment required",
      data: { invalid: "structure" },
    };

    expect(extractPaymentRequiredFromError(error)).toBeNull();
  });
});

// ============================================================================
// createToolResourceUrl Tests
// ============================================================================

describe("createToolResourceUrl", () => {
  it("should return custom URL if provided", () => {
    const url = createToolResourceUrl("test_tool", "https://custom.url/tool");
    expect(url).toBe("https://custom.url/tool");
  });

  it("should generate default mcp:// URL", () => {
    const url = createToolResourceUrl("test_tool");
    expect(url).toBe("mcp://tool/test_tool");
  });

  it("should handle empty custom URL", () => {
    const url = createToolResourceUrl("test_tool", "");
    expect(url).toBe("mcp://tool/test_tool");
  });
});
