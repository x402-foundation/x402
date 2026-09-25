import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("x402-express legacy deprecation warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once on middleware construction pointing to @x402/express", async () => {
    const { paymentMiddleware } = await import("./index");

    paymentMiddleware("0x1234567890123456789012345678901234567890", {
      "/test": { price: "$0.01", network: "base-sepolia" },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("x402-express");
    expect(warnSpy.mock.calls[0][0]).toContain("@x402/express");

    paymentMiddleware("0x1234567890123456789012345678901234567890", {
      "/other": { price: "$0.01", network: "base-sepolia" },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
  }, 20000);
});
