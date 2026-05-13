/**
 * Integration tests for the Postgres-backed Bazaar catalog.
 *
 * Uses Testcontainers to spin up an ephemeral Postgres for each `describe`
 * block. Gated behind `RUN_DB_TESTS=1` so CI / contributors without Docker
 * don't have to pay the startup cost on every test run.
 *
 *   pnpm test:db   # runs this file in addition to the rest
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { BAZAAR, declareDiscoveryExtension, extractDiscoveryInfo } from "../src/bazaar/index";
import { PostgresBazaarCatalog, migrateBazaar } from "../src/bazaar/facilitator-service/postgres";

const SUITE_ENABLED = process.env.RUN_DB_TESTS === "1";
const describeDb = SUITE_ENABLED ? describe : describe.skip;

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
 * Builds a v2 HTTP PaymentPayload carrying a bazaar discovery extension.
 *
 * @param opts - Fixture overrides.
 * @param opts.url - Resource URL.
 * @param opts.method - HTTP method ("GET" default).
 * @param opts.description - Optional description.
 * @param opts.serviceName - Optional service name metadata.
 * @param opts.tags - Optional tags array.
 * @returns A v2 PaymentPayload suitable for extractDiscoveryInfo.
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
 * Builds a v2 MCP PaymentPayload carrying a bazaar discovery extension.
 *
 * @param opts - Fixture overrides.
 * @param opts.url - MCP server URL.
 * @param opts.toolName - MCP tool name.
 * @param opts.description - Optional tool description.
 * @returns A v2 PaymentPayload.
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

describeDb("PostgresBazaarCatalog (Testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let db: NodePgDatabase;
  let catalog: PostgresBazaarCatalog;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    db = drizzle(pool);
    await migrateBazaar(db);
    catalog = new PostgresBazaarCatalog(db);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  /**
   * Truncates the table between tests. Faster than restarting the container.
   */
  async function reset() {
    await pool.query("TRUNCATE TABLE discovered_resources RESTART IDENTITY");
  }

  /**
   * Mirrors `installBazaarFacilitator`'s extraction + upsert flow for tests.
   *
   * @param payload - The PaymentPayload carrying the bazaar extension.
   * @param requirements - The selected PaymentRequirements.
   */
  async function ingest(payload: PaymentPayload, requirements: PaymentRequirements = REQ_BASE_EVM) {
    const discovered = extractDiscoveryInfo(payload, {} as never);
    if (!discovered) throw new Error("extractDiscoveryInfo returned null");
    await catalog.upsert({ discovered, paymentRequirements: requirements });
  }

  it("upserts a new row and surfaces it via list()", async () => {
    await reset();
    await ingest(makeHttpPayload({ url: "https://api.example.com/weather", method: "GET" }));

    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(1);
    expect(items[0].resource).toBe("https://api.example.com/weather");
    expect(items[0].accepts).toHaveLength(1);
    expect(items[0].accepts[0].network).toBe("eip155:8453");
  });

  it("merges accepts deduped by (scheme, network) and replaces in-place on collision", async () => {
    await reset();
    const payload = makeHttpPayload({ url: "https://api.example.com/x", method: "GET" });
    await ingest(payload, REQ_BASE_EVM);
    await ingest(payload, REQ_SVM);
    await ingest(payload, { ...REQ_BASE_EVM, amount: "999" });

    const { items } = await catalog.list();
    expect(items).toHaveLength(1);
    expect(items[0].accepts).toHaveLength(2);
    const evm = items[0].accepts.find(a => a.network === "eip155:8453");
    expect(evm?.amount).toBe("999"); // replaced, not duplicated
  });

  it("treats GET and POST on the same URL as distinct rows", async () => {
    await reset();
    await ingest(makeHttpPayload({ url: "https://api.example.com/x", method: "GET" }));
    await ingest(makeHttpPayload({ url: "https://api.example.com/x", method: "POST" }));
    expect((await catalog.list()).pagination.total).toBe(2);
  });

  it("treats distinct MCP toolNames at the same URL as distinct rows", async () => {
    await reset();
    await ingest(makeMcpPayload({ url: "https://api.example.com/mcp", toolName: "analyze" }));
    await ingest(makeMcpPayload({ url: "https://api.example.com/mcp", toolName: "search" }));
    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(2);
    expect(items.every(i => i.type === "mcp")).toBe(true);
  });

  it("filters by type / payTo / scheme / network via jsonb containment", async () => {
    await reset();
    await ingest(makeHttpPayload({ url: "https://a.com/x", method: "GET" }), REQ_BASE_EVM);
    await ingest(makeHttpPayload({ url: "https://b.com/x", method: "GET" }), REQ_SVM);
    await ingest(makeMcpPayload({ url: "https://c.com/mcp", toolName: "t" }));

    expect((await catalog.list({ type: "mcp" })).pagination.total).toBe(1);
    expect((await catalog.list({ payTo: "SolanaMerchant" })).pagination.total).toBe(1);
    expect((await catalog.list({ network: "eip155:8453" })).pagination.total).toBe(2);
    // MCP row was also ingested with REQ_BASE_EVM, so total for eip155 is 2 (a + mcp).
    expect((await catalog.list({ scheme: "exact" })).pagination.total).toBe(3);
  });

  it("paginates list() with limit/offset", async () => {
    await reset();
    for (let i = 0; i < 5; i++) {
      await ingest(makeHttpPayload({ url: `https://a.com/x${i}`, method: "GET" }));
    }
    const page1 = await catalog.list({ limit: 2, offset: 0 });
    const page2 = await catalog.list({ limit: 2, offset: 2 });
    const page3 = await catalog.list({ limit: 2, offset: 4 });
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page3.items).toHaveLength(1);
    expect(page1.pagination.total).toBe(5);
  });

  it("ranks tsvector matches: serviceName > description > tags", async () => {
    await reset();
    await ingest(
      makeHttpPayload({
        url: "https://weather.example.com/forecast",
        method: "GET",
        serviceName: "Weather Service",
        description: "Forecasts for cities",
        tags: ["meteo"],
      }),
    );
    await ingest(
      makeHttpPayload({
        url: "https://news.example.com/finance",
        method: "GET",
        serviceName: "Finance News",
        description: "Articles about weather and markets",
      }),
    );

    const result = await catalog.search({ query: "weather" });
    expect(result.resources.length).toBeGreaterThanOrEqual(1);
    expect(result.resources[0].resource).toBe("https://weather.example.com/forecast");
  });

  it("returns empty results for searches with no matches", async () => {
    await reset();
    await ingest(
      makeHttpPayload({
        url: "https://x.com/y",
        method: "GET",
        serviceName: "Finance",
      }),
    );
    const result = await catalog.search({ query: "completelyunrelatedterm" });
    expect(result.resources).toHaveLength(0);
  });

  it("paginates search() with a stable keyset cursor", async () => {
    await reset();
    for (let i = 0; i < 6; i++) {
      await ingest(
        makeHttpPayload({
          url: `https://a${i}.example.com/x`,
          method: "GET",
          description: `weather service ${i}`,
        }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await catalog.search({
        query: "weather",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      for (const r of page.resources) seen.push(r.resource);
      cursor = page.pagination?.cursor ?? null;
      pages++;
      if (pages > 10) throw new Error("search pagination did not terminate");
    } while (cursor);

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6); // no duplicates across pages
  });

  it("canonicalizes dynamic routes through routeTemplate (one row regardless of param value)", async () => {
    await reset();
    const declared = declareDiscoveryExtension({
      method: "GET",
      input: { id: "x" },
      inputSchema: { properties: { id: { type: "string" } } },
    });
    const base = declared.bazaar;
    const withTemplate = {
      ...base,
      info: { ...base.info, input: { ...base.info.input, pathParams: { id: "123" } } },
      schema: {
        ...base.schema,
        properties: {
          ...base.schema.properties,
          input: {
            ...base.schema.properties.input,
            properties: {
              ...base.schema.properties.input.properties,
              pathParams: { type: "object" },
            },
          },
        },
      },
      routeTemplate: "/users/:id",
    };
    const mkPayload = (concreteUrl: string) =>
      ({
        x402Version: 2,
        payload: {},
        accepted: REQ_BASE_EVM,
        resource: { url: concreteUrl },
        extensions: { [BAZAAR.key]: withTemplate },
      }) as unknown as PaymentPayload;

    await ingest(mkPayload("https://api.example.com/users/123"));
    await ingest(mkPayload("https://api.example.com/users/456"));

    const { items, pagination } = await catalog.list();
    expect(pagination.total).toBe(1);
    expect(items[0].resource).toBe("https://api.example.com/users/:id");
  });

  it("is idempotent across re-runs of migrateBazaar", async () => {
    await migrateBazaar(db);
    await migrateBazaar(db);
    const rows = await pool.query("SELECT count(*) FROM bazaar_schema_migrations");
    expect(Number(rows.rows[0].count)).toBe(1);
  });
});
