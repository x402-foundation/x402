import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("x402-next legacy deprecation warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once across paymentMiddleware and withX402, pointing to @x402/next", async () => {
    const { paymentMiddleware, withX402 } = await import("./index");

    paymentMiddleware("0x1234567890123456789012345678901234567890", {
      "/test": { price: "$0.01", network: "base-sepolia" },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("x402-next");
    expect(warnSpy.mock.calls[0][0]).toContain("@x402/next");

    withX402(
      async () => new Response(null) as never,
      "0x1234567890123456789012345678901234567890",
      {
        price: "$0.01",
        network: "base-sepolia",
      },
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
  }, 20000);
});
