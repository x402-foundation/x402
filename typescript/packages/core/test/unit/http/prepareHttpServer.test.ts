import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareHttpServer } from "../../../src/http/prepareHttpServer";
import type { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";

function createHttpServer(initialize: () => Promise<void>): x402HTTPResourceServer {
  return {
    initialize,
    registerPaywallProvider: vi.fn(),
    routes: {},
  } as unknown as x402HTTPResourceServer;
}

describe("prepareHttpServer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the paywall provider", () => {
    const httpServer = createHttpServer(vi.fn().mockResolvedValue(undefined));
    const paywall = { generateHtml: vi.fn() };

    prepareHttpServer(httpServer, paywall, false);

    expect(httpServer.registerPaywallProvider).toHaveBeenCalledWith(paywall);
  });

  it("initializes once and reuses the result across protected requests", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const { init } = prepareHttpServer(createHttpServer(initialize), undefined, true);

    await init();
    await init();

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure instead of latching it", async () => {
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new Error("facilitator request timed out"))
      .mockResolvedValueOnce(undefined);
    const { init } = prepareHttpServer(createHttpServer(initialize), undefined, true);

    await expect(init()).rejects.toThrow("facilitator request timed out");
    await expect(init()).resolves.toBeUndefined();
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it("does not initialize when startup sync is disabled", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const { init } = prepareHttpServer(createHttpServer(initialize), undefined, false);

    await init();

    expect(initialize).not.toHaveBeenCalled();
  });

  it("shares the eager initialization with the first protected request", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const { init } = prepareHttpServer(createHttpServer(initialize), undefined, true);

    await init();
    await init();

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("retries on the next request when the eager initialization failed", async () => {
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(new Error("facilitator request timed out"))
      .mockResolvedValueOnce(undefined);
    const { init } = prepareHttpServer(createHttpServer(initialize), undefined, true);

    await expect(init()).rejects.toThrow("facilitator request timed out");
    await expect(init()).resolves.toBeUndefined();
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it("does not surface an eager initialization failure as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const initialize = vi
        .fn()
        .mockRejectedValueOnce(new Error("facilitator request timed out"))
        .mockResolvedValueOnce(undefined);
      const { init } = prepareHttpServer(createHttpServer(initialize), undefined, true);

      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(unhandled).toHaveLength(0);
      await expect(init()).rejects.toThrow("facilitator request timed out");
      await expect(init()).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
