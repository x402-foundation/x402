import { describe, it, expect, beforeEach } from "vitest";
import { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
  buildVerifyResponse,
} from "../../mocks";
import { Network, Price } from "../../../src/types";

const ORIGIN = "https://api.example.com";

describe("x402HTTPResourceServer.buildDiscoveryManifest", () => {
  let ResourceServer: x402ResourceServer;

  beforeEach(async () => {
    const mockFacilitator = new MockFacilitatorClient(
      buildSupportedResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
      }),
      buildVerifyResponse({ isValid: true }),
    );
    ResourceServer = new x402ResourceServer(mockFacilitator);
    ResourceServer.register(
      "eip155:8453" as Network,
      new MockSchemeNetworkServer("exact", {
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: {},
      }),
    );
    await ResourceServer.initialize();
  });

  const evmOption = (payTo = "0xabc") => ({
    scheme: "exact",
    payTo,
    price: "$1.00" as Price,
    network: "eip155:8453" as Network,
  });

  it("returns a v2 manifest envelope (top-level version + numeric lastUpdated) with one item per route", async () => {
    const httpServer = new x402HTTPResourceServer(ResourceServer, {
      "GET /weather/:city": { accepts: evmOption() },
      "GET /news": { accepts: evmOption() },
    });

    const manifest = await httpServer.buildDiscoveryManifest(ORIGIN);

    expect(manifest.x402Version).toBe(2);
    expect(typeof manifest.lastUpdated).toBe("number");
    expect(manifest.items).toHaveLength(2);
    expect(manifest.items.map(i => i.resource.url).sort()).toEqual([
      "https://api.example.com/news",
      "https://api.example.com/weather/:city",
    ]);
  });

  it("emits a resource object + resolved accepts + input skeleton; no per-item version/extensions", async () => {
    const httpServer = new x402HTTPResourceServer(ResourceServer, {
      "GET /weather/:city": {
        accepts: evmOption(),
        description: "Weather",
        mimeType: "application/json",
      },
    });

    const { items } = await httpServer.buildDiscoveryManifest(ORIGIN);
    const item = items[0];

    expect(item.resource.url).toBe("https://api.example.com/weather/:city");
    expect(item.resource.description).toBe("Weather");
    expect(item.resource.mimeType).toBe("application/json");
    expect(item.type).toBe("http");
    expect(item.accepts).toHaveLength(1);
    expect(item.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453" });
    expect(item.input).toEqual({ method: "GET", routeTemplate: "/weather/:city" });
    // optimized shape: no per-item version, no extensions blob, no top-level metadata
    expect(item).not.toHaveProperty("x402Version");
    expect(item).not.toHaveProperty("extensions");
    expect(item).not.toHaveProperty("lastUpdated");
    expect(item.output).toBeUndefined();
    expect(item.requires).toBeUndefined();
  });

  it("respects a route's `resource` URL override", async () => {
    const httpServer = new x402HTTPResourceServer(ResourceServer, {
      "GET /proxied": { accepts: evmOption(), resource: "https://api.example.com/real/path" },
    });

    const { items } = await httpServer.buildDiscoveryManifest(ORIGIN);
    expect(items[0].resource.url).toBe("https://api.example.com/real/path");
  });

  it("normalizes a single-route (wildcard) config to '/' with a method-only input", async () => {
    const httpServer = new x402HTTPResourceServer(ResourceServer, { accepts: evmOption() });

    const { items } = await httpServer.buildDiscoveryManifest(ORIGIN);
    expect(items).toHaveLength(1);
    expect(items[0].resource.url).toBe("https://api.example.com/");
    expect(items[0].input).toEqual({ method: "GET" });
  });

  it("lifts a declared bazaar body contract into input/output and drops the envelope", async () => {
    const bodySchema = {
      type: "object",
      properties: { q: { type: "string", description: "query" } },
      required: ["q"],
    };
    const httpServer = new x402HTTPResourceServer(ResourceServer, {
      "POST /search": {
        accepts: evmOption(),
        mimeType: "application/json",
        extensions: {
          bazaar: {
            info: {
              input: { type: "http", method: "POST", bodyType: "json", body: { q: "hi" } },
              output: { type: "json", example: { results: [] } },
            },
            schema: { properties: { input: { properties: { body: bodySchema } } } },
          },
        },
      },
    });

    const { items } = await httpServer.buildDiscoveryManifest(ORIGIN);
    const item = items[0];

    expect(item.input.method).toBe("POST");
    expect(item.input.bodyType).toBe("json");
    expect(item.input.body).toEqual(bodySchema); // declared JSON Schema, not the example
    expect(item.output).toEqual({ mimeType: "application/json", example: { results: [] } });
    expect(item).not.toHaveProperty("extensions");
  });

  it("derives type from bazaar info and lifts MCP tool fields", async () => {
    const inputSchema = { type: "object", properties: { ticker: { type: "string" } } };
    const httpServer = new x402HTTPResourceServer(ResourceServer, {
      "POST /mcp": {
        accepts: evmOption(),
        extensions: {
          bazaar: {
            info: { input: { type: "mcp", toolName: "analyze", inputSchema } },
          },
        },
      },
    });

    const { items } = await httpServer.buildDiscoveryManifest(ORIGIN);
    expect(items[0].type).toBe("mcp");
    expect(items[0].input.toolName).toBe("analyze");
    expect(items[0].input.inputSchema).toEqual(inputSchema);
  });

  it("surfaces non-bazaar extensions as a `requires` capability hint (no payloads)", async () => {
    const httpServer = new x402HTTPResourceServer(ResourceServer, {
      "GET /gated": {
        accepts: evmOption(),
        extensions: {
          bazaar: { info: { input: { type: "http", method: "GET" } } },
          "sign-in-with-x": { info: { domain: "api.example.com" } },
        },
      },
    });

    const { items } = await httpServer.buildDiscoveryManifest(ORIGIN);
    const item = items[0];

    expect(item.requires).toEqual(["sign-in-with-x"]); // bazaar excluded (lifted, not required)
    expect(item).not.toHaveProperty("extensions"); // no full payloads in the manifest
  });

  it("produces only an input skeleton for a bare route (no discovery declared)", async () => {
    const httpServer = new x402HTTPResourceServer(ResourceServer, {
      "GET /weather/:city": { accepts: evmOption() },
    });

    const { items } = await httpServer.buildDiscoveryManifest(ORIGIN);
    const item = items[0];

    expect(item.input).toEqual({ method: "GET", routeTemplate: "/weather/:city" });
    expect(item.output).toBeUndefined();
    expect(item.requires).toBeUndefined();
    expect(item.type).toBe("http");
  });
});
