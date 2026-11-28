import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPAdapter,
  RouteConfig,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import { Network } from "../../../src/types";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
} from "../../mocks";
import { decodePaymentRequiredHeader } from "../../../src/http";

class MockHTTPAdapter implements HTTPAdapter {
  constructor(private readonly url: string) {}

  getHeader(): string | undefined {
    return undefined;
  }

  getMethod(): string {
    return "GET";
  }

  getPath(): string {
    return new URL(this.url).pathname;
  }

  getUrl(): string {
    return this.url;
  }

  getAcceptHeader(): string {
    return "application/json";
  }

  getUserAgent(): string {
    return "Vitest";
  }
}

describe("x402HTTPResourceServer PAYMENT-REQUIRED header size", () => {
  const network = "eip155:8453" as Network;
  // Pushes resource.url, and so the header, past 16 KB when combined with a ~10 KB route.
  const longQuery = `?q=${"y".repeat(7000)}`;
  let resourceServer: x402ResourceServer;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const route = (exampleLength: number): RouteConfig => ({
    accepts: { scheme: "exact", payTo: "0xabc", price: "$1.00", network },
    extensions: { bazaar: { info: { output: { example: "x".repeat(exampleLength) } } } },
  });

  const request = async (
    httpServer: x402HTTPResourceServer,
    path: string,
    query = "",
  ): Promise<string> => {
    const result = await httpServer.processHTTPRequest({
      adapter: new MockHTTPAdapter(`https://example.com${path}${query}`),
      path,
      method: "GET",
    });
    if (result.type !== "payment-error") {
      throw new Error(`expected a 402, got ${result.type}`);
    }
    return result.response.headers["PAYMENT-REQUIRED"];
  };

  beforeEach(async () => {
    resourceServer = new x402ResourceServer(
      new MockFacilitatorClient(
        buildSupportedResponse({ kinds: [{ x402Version: 2, scheme: "exact", network }] }),
      ),
    );
    resourceServer.register(network, new MockSchemeNetworkServer("exact"));
    await resourceServer.initialize();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not warn when the header is within 8,190 bytes", async () => {
    const httpServer = new x402HTTPResourceServer(resourceServer, { "GET /api/data": route(5500) });

    const header = await request(httpServer, "/api/data");

    expect(header.length).toBeLessThanOrEqual(8190);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns at 8,192 bytes, which aiohttp already rejects", async () => {
    let header = "";
    for (let n = 5000; n < 7000 && header.length !== 8192; n++) {
      warnSpy.mockClear();
      const httpServer = new x402HTTPResourceServer(resourceServer, { "GET /api/data": route(n) });
      header = await request(httpServer, "/api/data");
    }

    expect(header.length).toBe(8192);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("bytes encoded, over 8190");
  });

  it("warns once over 8,190 bytes with the route, size and largest fields", async () => {
    const config = route(7000);
    const httpServer = new x402HTTPResourceServer(resourceServer, { "GET /api/data": config });

    const header = await request(httpServer, "/api/data");
    await request(httpServer, "/api/data");

    expect(header.length).toBeGreaterThan(8190);
    expect(header.length).toBeLessThanOrEqual(16384);
    expect(decodePaymentRequiredHeader(header).extensions).toEqual(config.extensions);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('Route "GET /api/data"');
    expect(message).toContain(
      `PAYMENT-REQUIRED header is ${header.length} bytes encoded, over 8190`,
    );
    expect(message).toMatch(
      /Largest fields: extensions\.bazaar \(\d+ bytes\), accepts \(\d+ bytes\)/,
    );
  });

  it("warns a second time, differently, over 16 KB", async () => {
    const httpServer = new x402HTTPResourceServer(resourceServer, { "GET /api/data": route(7000) });

    await request(httpServer, "/api/data");
    const header = await request(httpServer, "/api/data", longQuery);

    expect(header.length).toBeGreaterThan(16384);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const [first, second] = warnSpy.mock.calls.map(([message]) => message as string);
    expect(first).not.toContain("UND_ERR_HEADERS_OVERFLOW");
    expect(second).toContain(
      `PAYMENT-REQUIRED header is ${header.length} bytes encoded, over 16384`,
    );
    expect(second).toContain("UND_ERR_HEADERS_OVERFLOW");
    expect(second).toMatch(/Largest fields: resource \(\d+ bytes\), extensions\.bazaar/);
  });

  it("does not repeat a warning for the same route", async () => {
    const httpServer = new x402HTTPResourceServer(resourceServer, { "GET /api/data": route(7000) });

    await request(httpServer, "/api/data", longQuery);
    await request(httpServer, "/api/data");
    await request(httpServer, "/api/data", longQuery);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("over 16384");
  });

  it("warns for each route independently", async () => {
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "GET /api/a": route(7000),
      "GET /api/b": route(7000),
    });

    await request(httpServer, "/api/a");
    await request(httpServer, "/api/b");
    await request(httpServer, "/api/a");

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toContain('Route "GET /api/a"');
    expect(warnSpy.mock.calls[1][0]).toContain('Route "GET /api/b"');
  });
});
