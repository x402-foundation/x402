import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("x402/client", () => ({
  createPaymentHeader: vi.fn(),
  selectPaymentRequirements: vi.fn(),
}));

describe("x402-fetch legacy deprecation warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("tags wrapFetchWithPayment construction as the x402-fetch client, pointing to @x402/fetch", async () => {
    const { wrapFetchWithPayment } = await import("./index");
    const mockWalletClient = { signMessage: vi.fn() } as never;

    wrapFetchWithPayment(vi.fn() as never, mockWalletClient);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("x402-fetch");
    expect(warnSpy.mock.calls[0][0]).toContain("@x402/fetch");
  }, 20000);
});
