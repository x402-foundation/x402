import { describe, expect, it } from "vitest";
import { getResponseHeadersOverflowError } from "../../../src/http/headerErrors";

describe("getResponseHeadersOverflowError", () => {
  it.each(["UND_ERR_HEADERS_OVERFLOW", "HPE_HEADER_OVERFLOW"])(
    "recognizes %s through causes",
    code => {
      const original = new Error("request failed", { cause: { cause: { code } } });
      const result = getResponseHeadersOverflowError(original);

      expect(result?.message).toContain("Response headers exceed");
      expect(result?.message).toContain("PAYMENT-REQUIRED");
      expect(result?.message).toContain("may be responsible");
      expect(result?.cause).toBe(original);
      expect(original.message).toBe("request failed");
    },
  );

  it("recognizes a direct parser error", () => {
    const original = { code: "HPE_HEADER_OVERFLOW" };
    expect(getResponseHeadersOverflowError(original)?.cause).toBe(original);
  });

  it.each([
    null,
    undefined,
    "error",
    42,
    {},
    new Error("headers overflow"),
    { code: "ECONNRESET" },
  ])("does not diagnose unrelated errors: %s", error => {
    expect(getResponseHeadersOverflowError(error)).toBeUndefined();
  });

  it("stops at a circular cause chain", () => {
    const error: { cause?: unknown } = {};
    error.cause = { cause: error };
    expect(getResponseHeadersOverflowError(error)).toBeUndefined();
  });
});
