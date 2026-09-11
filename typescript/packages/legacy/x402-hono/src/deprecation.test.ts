import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("x402-hono legacy deprecation warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once on middleware construction pointing to @x402/hono", async () => {
    const { paymentMiddleware } = await import("./index");

    paymentMiddleware("0x1234567890123456789012345678901234567890", {
      "/test": { price: "$0.01", network: "base-sepolia" },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("x402-hono");
    expect(warnSpy.mock.calls[0][0]).toContain("@x402/hono");

    paymentMiddleware("0x1234567890123456789012345678901234567890", {
      "/other": { price: "$0.01", network: "base-sepolia" },
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
  }, 20000);

  it("warns once on session-token POST invocation pointing to @x402/hono", async () => {
    const { POST } = await import("./session-token");
    const mockContext = {
      req: { json: vi.fn().mockResolvedValue({}) },
      json: vi.fn(),
    } as unknown as Context;

    await POST(mockContext);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("x402-hono");
    expect(warnSpy.mock.calls[0][0]).toContain("@x402/hono");
  }, 20000);
});
