import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("x402/client", () => ({
  createPaymentHeader: vi.fn(),
  selectPaymentRequirements: vi.fn(),
}));

describe("x402-axios legacy deprecation warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("tags withPaymentInterceptor construction as the x402-axios client, pointing to @x402/axios", async () => {
    const { withPaymentInterceptor } = await import("./index");
    const mockAxiosClient = { interceptors: { response: { use: vi.fn() } } } as never;
    const mockWalletClient = { signMessage: vi.fn() } as never;

    withPaymentInterceptor(mockAxiosClient, mockWalletClient);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("x402-axios");
    expect(warnSpy.mock.calls[0][0]).toContain("@x402/axios");
  }, 20000);
});
