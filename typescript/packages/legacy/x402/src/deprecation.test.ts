import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("x402 legacy deprecation warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once on module load pointing to @x402/core", async () => {
    await import("./index");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("x402");
    expect(warnSpy.mock.calls[0][0]).toContain("@x402/core");
  }, 20000);
});
