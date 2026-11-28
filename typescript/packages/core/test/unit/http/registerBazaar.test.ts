import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBazaar, type BazaarStartupModule } from "../../../src/http/registerBazaar";
import type { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";

const routes = { "GET /weather": { accepts: [], extensions: { bazaar: {} } } };

function createHttpServer(hasBazaar: boolean): x402HTTPResourceServer {
  return {
    routes,
    server: {
      hasExtension: vi.fn().mockReturnValue(hasBazaar),
      registerExtension: vi.fn(),
    },
  } as unknown as x402HTTPResourceServer;
}

function createBazaarModule(): BazaarStartupModule {
  return {
    bazaarResourceServerExtension: { key: "bazaar" },
    validateBazaarRouteExtensions: vi.fn(),
  };
}

describe("registerBazaar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the extension when missing, then validates routes", async () => {
    const httpServer = createHttpServer(false);
    const bazaar = createBazaarModule();

    await registerBazaar(httpServer, async () => bazaar);

    expect(httpServer.server.registerExtension).toHaveBeenCalledWith(
      bazaar.bazaarResourceServerExtension,
    );
    expect(bazaar.validateBazaarRouteExtensions).toHaveBeenCalledWith(routes);
  });

  it("keeps an already registered extension and still validates routes", async () => {
    const httpServer = createHttpServer(true);
    const bazaar = createBazaarModule();

    await registerBazaar(httpServer, async () => bazaar);

    expect(httpServer.server.registerExtension).not.toHaveBeenCalled();
    expect(bazaar.validateBazaarRouteExtensions).toHaveBeenCalledWith(routes);
  });

  it("logs load failures instead of rejecting", async () => {
    const error = new Error("Cannot find module '@x402/extensions/bazaar'");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      registerBazaar(createHttpServer(false), () => Promise.reject(error)),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith("Failed to load bazaar extension:", error);
  });
});
