/**
 * Tests for the Bazaar facilitator service helpers:
 *   - InMemoryBazaarCatalog
 *   - installBazaarFacilitator
 *
 * The catalog tests cover upsert/merge/list/search semantics. The install
 * tests use a minimal mock x402Facilitator to verify the hook wiring; the
 * full verify/settle integration is exercised by the e2e suite.
 */

import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { x402Facilitator } from "@x402/core/facilitator";

import {
  BAZAAR,
  InMemoryBazaarCatalog,
  declareDiscoveryExtension,
  installBazaarFacilitator,
} from "../src/bazaar/index";
import type { CatalogUpsertInput } from "../src/bazaar/facilitator-service";

// ---------- helpers ----------------------------------------------------------

const REQ_BASE_EVM: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0xUSDC",
  amount: "100000",
  payTo: "0xMerchant",
  maxTimeoutSeconds: 60,
  extra: {},
};

const REQ_SVM: PaymentRequirements = {
  scheme: "exact",
  network: "solana:mainnet",
  asset: "USDC",
  amount: "100000",
  payTo: "SolanaMerchant",
  maxTimeoutSeconds: 60,
  extra: {},
};

/**
 * Builds a v2 PaymentPayload for an HTTP endpoint with a bazaar extension.
 *
 * @param opts - Fixture overrides.
 * @param opts.url - Resource URL recorded in the payload.
 * @param opts.method - HTTP method to declare ("GET" by default).
 * @param opts.description - Optional resource description.
 * @param opts.serviceName - Optional service name metadata.
 * @param opts.tags - Optional service tags.
 * @returns A PaymentPayload suitable for feeding into extractDiscoveryInfo.
 */
function makeHttpPayload(opts: {
  url: string;
  method?: "GET" | "POST";
  description?: string;
  serviceName?: string;
  tags?: string[];
}): PaymentPayload {
  const declared = declareDiscoveryExtension(
    opts.method === "POST"
      ? {
          method: "POST",
          input: { q: "x" },
          inputSchema: { properties: { q: { type: "string" } } },
          bodyType: "json",
        }
      : {
          method: "GET",
          input: { q: "x" },
          inputSchema: { properties: { q: { type: "string" } } },
        },
  );
  return {
    x402Version: 2,
    payload: {},
    accepted: REQ_BASE_EVM,
    resource: {
      url: opts.url,
      description: opts.description,
      serviceName: opts.serviceName,
      tags: opts.tags,
    },
    extensions: { [BAZAAR.key]: declared.bazaar },
  } as unknown as PaymentPayload;
}

/**
 * Builds a v2 PaymentPayload for an MCP tool with a bazaar extension.
 *
 * @param opts - Fixture overrides.
 * @param opts.url - MCP server URL.
 * @param opts.toolName - MCP tool name (catalog key for the row).
 * @param opts.description - Optional tool description.
 * @returns A PaymentPayload suitable for feeding into extractDiscoveryInfo.
 */
function makeMcpPayload(opts: {
  url: string;
  toolName: string;
  description?: string;
}): PaymentPayload {
  const declared = declareDiscoveryExtension({
    toolName: opts.toolName,
    description: opts.description,
    inputSchema: {
      type: "object",
      properties: { ticker: { type: "string" } },
      required: ["ticker"],
    },
  });
  return {
    x402Version: 2,
    payload: {},
    accepted: REQ_BASE_EVM,
    resource: { url: opts.url, description: opts.description },
    extensions: { [BAZAAR.key]: declared.bazaar },
  } as unknown as PaymentPayload;
}

/**
 * Extracts a discovery resource from `payload` and upserts it into `catalog`.
 * Mirrors what `installBazaarFacilitator`'s hook does, but synchronously so tests
 * can assert directly on the catalog after each call.
 *
 * @param catalog - The catalog under test.
 * @param payload - The PaymentPayload carrying a bazaar extension.
 * @param requirements - The selected PaymentRequirements for this payment.
 */
async function ingest(
  catalog: InMemoryBazaarCatalog,
  payload: PaymentPayload,
  requirements: PaymentRequirements = REQ_BASE_EVM,
) {
  // Re-derive the discovered resource using the same extraction the install
  // hook performs, so tests describe the catalog API rather than re-test extraction.
  const { extractDiscoveryInfo } = await import("../src/bazaar/facilitator");
  const discovered = extractDiscoveryInfo(payload, {} as never);
  if (!discovered) throw new Error("extractDiscoveryInfo returned null");
  await catalog.upsert({ discovered, paymentRequirements: requirements });
}

// ---------- InMemoryBazaarCatalog -------------------------------------------

describe("InMemoryBazaarCatalog", () => {
  it("stores a single HTTP row with the selected accepts entry", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(
      catalog,
      makeHttpPayload({ url: "https://api.example.com/weather", method: "GET" }),
    );

    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(1);
    expect(items[0].resource).toBe("https://api.example.com/weather");
    expect(items[0].type).toBe("http");
    expect(items[0].accepts).toEqual([REQ_BASE_EVM]);
  });

  it("merges accepts on second upsert with a different (scheme, network)", async () => {
    const catalog = new InMemoryBazaarCatalog();
    const payload = makeHttpPayload({ url: "https://api.example.com/weather", method: "GET" });
    await ingest(catalog, payload, REQ_BASE_EVM);
    await ingest(catalog, payload, REQ_SVM);

    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(1);
    expect(items[0].accepts).toHaveLength(2);
    expect(items[0].accepts.map(a => a.network)).toEqual(
      expect.arrayContaining(["eip155:8453", "solana:mainnet"]),
    );
  });

  it("replaces in-place when (scheme, network) matches — no growth", async () => {
    const catalog = new InMemoryBazaarCatalog();
    const payload = makeHttpPayload({ url: "https://api.example.com/weather", method: "GET" });
    await ingest(catalog, payload, REQ_BASE_EVM);
    await ingest(catalog, payload, { ...REQ_BASE_EVM, amount: "200000" });

    const { items } = await catalog.list();
    expect(items[0].accepts).toHaveLength(1);
    expect(items[0].accepts[0].amount).toBe("200000");
  });

  it("keys HTTP rows by method — GET and POST on the same URL are distinct", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(catalog, makeHttpPayload({ url: "https://api.example.com/x", method: "GET" }));
    await ingest(catalog, makeHttpPayload({ url: "https://api.example.com/x", method: "POST" }));

    const { pagination } = await catalog.list();
    expect(pagination.total).toBe(2);
  });

  it("keys MCP rows by toolName — distinct tools at the same URL are distinct rows", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(
      catalog,
      makeMcpPayload({ url: "https://api.example.com/mcp", toolName: "analyze" }),
    );
    await ingest(
      catalog,
      makeMcpPayload({ url: "https://api.example.com/mcp", toolName: "search" }),
    );

    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(2);
    expect(items.map(i => i.type)).toEqual(["mcp", "mcp"]);
  });

  it("list filters by type", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(catalog, makeHttpPayload({ url: "https://a.com/x", method: "GET" }));
    await ingest(catalog, makeMcpPayload({ url: "https://b.com/mcp", toolName: "t" }));

    const httpOnly = await catalog.list({ type: "http" });
    expect(httpOnly.pagination.total).toBe(1);
    expect(httpOnly.items[0].type).toBe("http");

    const mcpOnly = await catalog.list({ type: "mcp" });
    expect(mcpOnly.pagination.total).toBe(1);
    expect(mcpOnly.items[0].type).toBe("mcp");
  });

  it("list filters by payTo / scheme / network across the accepts array", async () => {
    const catalog = new InMemoryBazaarCatalog();
    const a = makeHttpPayload({ url: "https://a.com/x", method: "GET" });
    const b = makeHttpPayload({ url: "https://b.com/x", method: "GET" });
    await ingest(catalog, a, REQ_BASE_EVM);
    await ingest(catalog, b, REQ_SVM);

    expect((await catalog.list({ payTo: "0xMerchant" })).pagination.total).toBe(1);
    expect((await catalog.list({ payTo: "SolanaMerchant" })).pagination.total).toBe(1);
    expect((await catalog.list({ network: "eip155:8453" })).pagination.total).toBe(1);
    expect((await catalog.list({ scheme: "exact" })).pagination.total).toBe(2);
    // scheme filter rejects rows that don't match
    expect((await catalog.list({ scheme: "upto" })).pagination.total).toBe(0);
  });

  it("list filters by extensions key presence on the row", async () => {
    const catalog = new InMemoryBazaarCatalog();
    // Upsert directly so we control the extensions field.
    const { extractDiscoveryInfo } = await import("../src/bazaar/facilitator");
    const payloadWithExt = makeHttpPayload({ url: "https://ext.com/x", method: "GET" });
    const discovered = extractDiscoveryInfo(payloadWithExt, {} as never);
    if (!discovered) throw new Error("extractDiscoveryInfo returned null");
    await catalog.upsert({
      discovered,
      paymentRequirements: REQ_BASE_EVM,
      extensions: { bazaar: true },
    });
    await ingest(catalog, makeHttpPayload({ url: "https://noext.com/x", method: "GET" }));

    expect((await catalog.list({ extensions: "bazaar" })).pagination.total).toBe(1);
    expect((await catalog.list({ extensions: "other" })).pagination.total).toBe(0);
  });

  it("list paginates with limit/offset", async () => {
    const catalog = new InMemoryBazaarCatalog();
    for (let i = 0; i < 5; i++) {
      await ingest(catalog, makeHttpPayload({ url: `https://a.com/x${i}`, method: "GET" }));
    }
    const page1 = await catalog.list({ limit: 2, offset: 0 });
    const page2 = await catalog.list({ limit: 2, offset: 2 });
    const page3 = await catalog.list({ limit: 2, offset: 4 });
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page3.items).toHaveLength(1);
    expect(page1.pagination.total).toBe(5);
  });

  it("clear() empties the catalog", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(catalog, makeHttpPayload({ url: "https://a.com/x", method: "GET" }));
    expect(catalog.size).toBe(1);
    catalog.clear();
    expect(catalog.size).toBe(0);
    const { items } = await catalog.list();
    expect(items).toHaveLength(0);
  });

  it("upsert merges extensions into an existing row", async () => {
    const catalog = new InMemoryBazaarCatalog();
    const { extractDiscoveryInfo } = await import("../src/bazaar/facilitator");
    const payload = makeHttpPayload({ url: "https://a.com/x", method: "GET" });
    const discovered = extractDiscoveryInfo(payload, {} as never);
    if (!discovered) throw new Error("extractDiscoveryInfo returned null");

    await catalog.upsert({ discovered, paymentRequirements: REQ_BASE_EVM, extensions: { foo: 1 } });
    await catalog.upsert({ discovered, paymentRequirements: REQ_BASE_EVM, extensions: { bar: 2 } });

    const { items } = await catalog.list();
    expect(items[0].extensions).toMatchObject({ foo: 1, bar: 2 });
  });

  it("clamps invalid limit/offset to safe values", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(catalog, makeHttpPayload({ url: "https://a.com/x", method: "GET" }));
    const negOffset = await catalog.list({ offset: -5 });
    expect(negOffset.items).toHaveLength(1);
    const tooBig = await catalog.list({ limit: 999999 });
    expect(tooBig.pagination.limit).toBeLessThanOrEqual(500);
  });

  it("search ranks serviceName matches above description above tags", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(
      catalog,
      makeHttpPayload({
        url: "https://weather.example.com/forecast",
        method: "GET",
        serviceName: "Weather",
        description: "Forecasts for cities",
        tags: ["meteo"],
      }),
    );
    await ingest(
      catalog,
      makeHttpPayload({
        url: "https://news.example.com/finance",
        method: "GET",
        serviceName: "Finance News",
        description: "Articles about weather and markets",
      }),
    );

    const result = await catalog.search({ query: "weather" });
    expect(result.resources).toHaveLength(2);
    // serviceName "Weather" beats description-only match.
    expect(result.resources[0].resource).toBe("https://weather.example.com/forecast");
  });

  it("search omits non-matching rows", async () => {
    const catalog = new InMemoryBazaarCatalog();
    await ingest(
      catalog,
      makeHttpPayload({
        url: "https://x.com/y",
        method: "GET",
        serviceName: "Finance",
      }),
    );
    const result = await catalog.search({ query: "weather" });
    expect(result.resources).toHaveLength(0);
  });

  it("search paginates with cursor when limit is supplied", async () => {
    const catalog = new InMemoryBazaarCatalog();
    for (let i = 0; i < 6; i++) {
      await ingest(
        catalog,
        makeHttpPayload({
          url: `https://a${i}.example.com/x`,
          method: "GET",
          description: `weather service ${i}`,
        }),
      );
    }
    const page1 = await catalog.search({ query: "weather", limit: 4 });
    expect(page1.resources).toHaveLength(4);
    expect(page1.pagination?.cursor).not.toBeNull();

    const page2 = await catalog.search({
      query: "weather",
      limit: 4,
      cursor: page1.pagination!.cursor!,
    });
    expect(page2.resources).toHaveLength(2);
    expect(page2.pagination?.cursor).toBeNull();
  });

  it("canonicalizes dynamic routes via routeTemplate (one row regardless of param value)", async () => {
    // Mirror what bazaarResourceServerExtension.enrichDeclaration produces for a
    // dynamic route: pathParams in info.input AND in the schema's input properties.
    const declared = declareDiscoveryExtension({
      method: "GET",
      input: { id: "123" },
      inputSchema: { properties: { id: { type: "string" } } },
    });
    const baseSchema = declared.bazaar.schema;
    const withTemplate = {
      ...declared.bazaar,
      info: {
        ...declared.bazaar.info,
        input: { ...declared.bazaar.info.input, pathParams: { id: "123" } },
      },
      schema: {
        ...baseSchema,
        properties: {
          ...baseSchema.properties,
          input: {
            ...baseSchema.properties.input,
            properties: {
              ...baseSchema.properties.input.properties,
              pathParams: { type: "object" },
            },
          },
        },
      },
      routeTemplate: "/users/:id",
    };

    const catalog = new InMemoryBazaarCatalog();
    const payload1 = {
      x402Version: 2,
      payload: {},
      accepted: REQ_BASE_EVM,
      resource: { url: "https://api.example.com/users/123" },
      extensions: { [BAZAAR.key]: withTemplate },
    } as unknown as PaymentPayload;
    const payload2 = {
      ...payload1,
      resource: { url: "https://api.example.com/users/456" },
    } as unknown as PaymentPayload;

    await ingest(catalog, payload1);
    await ingest(catalog, payload2);

    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(1);
    expect(items[0].resource).toBe("https://api.example.com/users/:id");
  });
});

// ---------- installBazaarFacilitator -----------------------------------------

describe("installBazaarFacilitator", () => {
  /**
   * Minimal mock that captures the registered after-verify hook. We exercise
   * the hook directly to assert wiring without standing up a full facilitator.
   *
   * @returns A `{ mock, state }` pair: `mock` is cast to `x402Facilitator`, `state` records the captured registration data.
   */
  function makeMockFacilitator() {
    const state: {
      registeredKeys: string[];
      afterVerifyHook: ((ctx: never) => Promise<void>) | null;
    } = { registeredKeys: [], afterVerifyHook: null };

    const mock = {
      registerExtension(ext: { key: string }) {
        state.registeredKeys.push(ext.key);
        return mock;
      },
      onAfterVerify(hook: (ctx: never) => Promise<void>) {
        state.afterVerifyHook = hook;
        return mock;
      },
    } as unknown as x402Facilitator;

    return { mock, state };
  }

  /**
   * Builds a minimal `FacilitatorVerifyResultContext`-shaped object for hook tests.
   *
   * @param payload - The PaymentPayload to feed the hook.
   * @param requirements - The PaymentRequirements to feed the hook.
   * @returns A context object cast to `never` (caller doesn't need the real type).
   */
  function makeVerifyContext(
    payload: PaymentPayload,
    requirements: PaymentRequirements = REQ_BASE_EVM,
  ) {
    return { paymentPayload: payload, requirements, result: { isValid: true } } as never;
  }

  it("registers the bazaar extension marker", () => {
    const { mock, state } = makeMockFacilitator();
    installBazaarFacilitator(mock, new InMemoryBazaarCatalog());
    expect(state.registeredKeys).toContain(BAZAAR.key);
  });

  it("forwards a payload with a bazaar extension to catalog.upsert", async () => {
    const catalog = new InMemoryBazaarCatalog();
    const { mock, state } = makeMockFacilitator();
    installBazaarFacilitator(mock, catalog);

    const payload = makeHttpPayload({ url: "https://api.example.com/x", method: "GET" });
    await state.afterVerifyHook!(makeVerifyContext(payload));

    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(1);
    expect(items[0].resource).toBe("https://api.example.com/x");
  });

  it("does not call upsert when the payload has no bazaar extension", async () => {
    const upsertSpy = vi.fn();
    const catalog: import("../src/bazaar/facilitator-service").BazaarCatalog = {
      upsert: upsertSpy as unknown as (i: CatalogUpsertInput) => Promise<void>,
      list: async () => ({
        x402Version: 2,
        items: [],
        pagination: { limit: 0, offset: 0, total: 0 },
      }),
      search: async () => ({ x402Version: 2, resources: [] }),
    };
    const { mock, state } = makeMockFacilitator();
    installBazaarFacilitator(mock, catalog);

    const payload = {
      x402Version: 2,
      payload: {},
      accepted: REQ_BASE_EVM,
      resource: { url: "https://api.example.com/x" },
    } as unknown as PaymentPayload;

    await state.afterVerifyHook!(makeVerifyContext(payload));
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("swallows catalog errors via the onError handler — does not throw", async () => {
    const onError = vi.fn();
    const catalog: import("../src/bazaar/facilitator-service").BazaarCatalog = {
      upsert: async () => {
        throw new Error("boom");
      },
      list: async () => ({
        x402Version: 2,
        items: [],
        pagination: { limit: 0, offset: 0, total: 0 },
      }),
      search: async () => ({ x402Version: 2, resources: [] }),
    };
    const { mock, state } = makeMockFacilitator();
    installBazaarFacilitator(mock, catalog, { onError });

    const payload = makeHttpPayload({ url: "https://api.example.com/x", method: "GET" });
    await expect(state.afterVerifyHook!(makeVerifyContext(payload))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("uses console.warn as default onError when no handler is provided", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog: import("../src/bazaar/facilitator-service").BazaarCatalog = {
      upsert: async () => {
        throw new Error("default-handler-test");
      },
      list: async () => ({
        x402Version: 2,
        items: [],
        pagination: { limit: 0, offset: 0, total: 0 },
      }),
      search: async () => ({ x402Version: 2, resources: [] }),
    };
    const { mock, state } = makeMockFacilitator();
    installBazaarFacilitator(mock, catalog); // no onError option

    const payload = makeHttpPayload({ url: "https://api.example.com/x", method: "GET" });
    await expect(state.afterVerifyHook!(makeVerifyContext(payload))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("default-handler-test"));
    warnSpy.mockRestore();
  });
});
