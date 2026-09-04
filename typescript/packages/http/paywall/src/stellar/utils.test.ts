import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPaymentError, formatUnits, getNetworkDisplayName, parseError } from "./utils";

describe("formatUnits", () => {
  it("formats stroops with 7 decimals and trims trailing zeros", () => {
    expect(formatUnits(10000000n, 7)).toBe("1");
    expect(formatUnits(5100000n, 7)).toBe("0.51");
    expect(formatUnits(123456789n, 7)).toBe("12.3456789");
    expect(formatUnits(1n, 7)).toBe("0.0000001");
  });

  it("handles zero decimals and negative values", () => {
    expect(formatUnits(42n, 0)).toBe("42");
    expect(formatUnits(-5100000n, 7)).toBe("-0.51");
  });
});

describe("getNetworkDisplayName", () => {
  it("maps Stellar CAIP-2 ids to display names", () => {
    expect(getNetworkDisplayName("stellar:testnet")).toBe("Stellar Testnet");
    expect(getNetworkDisplayName("stellar:pubnet")).toBe("Stellar Mainnet");
    expect(getNetworkDisplayName("eip155:8453")).toBe("eip155:8453");
  });
});

describe("parseError", () => {
  it("returns Error.message, otherwise the fallback", () => {
    expect(parseError(new Error("boom"), "fallback")).toBe("boom");
    expect(parseError("raw", "fallback")).toBe("fallback");
    expect(parseError(42)).toBe("42");
  });
});

describe("formatPaymentError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns status code when body is empty or whitespace", () => {
    expect(formatPaymentError("Failed", 402, "")).toBe("Failed: 402");
    expect(formatPaymentError("Failed", 500, "   \n\t  ")).toBe("Failed: 500");
  });

  it("extracts .error, .message and .detail from JSON body", () => {
    expect(formatPaymentError("Payment failed", 402, JSON.stringify({ error: "timed out" }))).toBe(
      "Payment failed: timed out",
    );
    expect(formatPaymentError("Rejected", 402, JSON.stringify({ message: "Insufficient" }))).toBe(
      "Rejected: Insufficient",
    );
    expect(formatPaymentError("Error", 429, JSON.stringify({ detail: "Rate limit" }))).toBe(
      "Error: Rate limit",
    );
  });

  it("prefers the PAYMENT-REQUIRED header error over the body", () => {
    const header = Buffer.from(
      JSON.stringify({ error: "invalid_exact_stellar_payload_fee_exceeds_maximum" }),
    ).toString("base64");

    expect(
      formatPaymentError("Payment failed", 402, JSON.stringify({ error: "fallback" }), header),
    ).toBe("Payment failed: invalid_exact_stellar_payload_fee_exceeds_maximum");
  });

  it("warns and falls through when the header is malformed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatPaymentError("Err", 402, "Forbidden", "%%%not-base64-json")).toBe(
      "Err: Forbidden",
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("ignores non-string error fields and falls through to raw body", () => {
    const body = JSON.stringify({ error: { nested: true } });
    expect(formatPaymentError("Err", 400, body)).toBe(`Err: ${body}`);
  });

  it("returns short plain text trimmed", () => {
    expect(formatPaymentError("Err", 403, "  Forbidden  ")).toBe("Err: Forbidden");
  });

  it("uses the console fallback for long bodies and HTML", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(formatPaymentError("Err", 500, "x".repeat(201))).toBe(
      "Err: 500 (see browser console for details)",
    );
    expect(formatPaymentError("Err", 502, "<html><body>Bad Gateway</body></html>")).toBe(
      "Err: 502 (see browser console for details)",
    );
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("shows the body directly when exactly 200 chars", () => {
    const body = "y".repeat(200);
    expect(formatPaymentError("Err", 500, body)).toBe(`Err: ${body}`);
  });

  it("handles invalid JSON and JSON primitives without crashing", () => {
    expect(formatPaymentError("Err", 400, "{bad json")).toBe("Err: {bad json");
    expect(formatPaymentError("Err", 500, "null")).toBe("Err: null");
    expect(formatPaymentError("Err", 500, "42")).toBe("Err: 42");
  });
});
