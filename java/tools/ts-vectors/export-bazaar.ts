/**
 * Exports TS @x402/extensions bazaar behaviour as JSON fixtures for java/x402-extensions:
 * declareDiscoveryExtension output and bazaarResourceServerExtension.enrichDeclaration.
 * Objects are written in the key order TS produces; the Java side must match it.
 *
 * Run: npm run export:bazaar (from java/tools/ts-vectors).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bazaar = "../../../typescript/packages/extensions/src/bazaar";
const { declareDiscoveryExtension } = require(`${bazaar}/resourceService.ts`);
const { bazaarResourceServerExtension } = require(`${bazaar}/server.ts`);
const outDir = join(here, "../../x402-extensions/src/test/resources/vectors");
mkdirSync(outDir, { recursive: true });

const tsCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here }).toString().trim();

// Mirrors e2e/src/mechanisms.ts routeDiscoveryOutput() and the paid-route body.
const e2eOutput = {
  example: { message: "Protected endpoint accessed successfully", timestamp: "2024-01-01T00:00:00Z" },
  schema: {
    properties: { message: { type: "string" }, timestamp: { type: "string" } },
    required: ["message", "timestamp"],
  },
};

const declareCases: { name: string; config: Record<string, unknown> }[] = [
  { name: "e2e paid route (GET, output only)", config: { output: e2eOutput } },
  { name: "GET with explicit method and no output", config: { method: "GET" } },
  {
    name: "GET with query params and schema",
    config: {
      method: "GET",
      input: { city: "Zurich" },
      inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
      output: { example: { temp: 12 } },
    },
  },
  {
    name: "GET with path params schema",
    config: {
      method: "GET",
      pathParams: { id: "42" },
      pathParamsSchema: { properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    name: "DELETE with schema overriding type",
    config: { method: "DELETE", inputSchema: { type: "string", properties: {} } },
  },
  {
    name: "POST with JSON body",
    config: {
      method: "POST",
      bodyType: "json",
      input: { name: "John", age: 30 },
      inputSchema: {
        properties: { name: { type: "string" }, age: { type: "number" } },
        required: ["name"],
      },
      output: { example: { success: true, id: "123" }, schema: { properties: { id: { type: "string" } } } },
    },
  },
  { name: "PUT with default body", config: { method: "PUT", bodyType: "text" } },
  { name: "body without method, with path params", config: { bodyType: "form-data", pathParams: { a: "b" }, pathParamsSchema: {} } },
  { name: "falsy example omits output", config: { method: "GET", output: { example: 0 } } },
  {
    name: "MCP tool with all optional fields",
    config: {
      toolName: "financial_analysis",
      description: "Analyze financial data",
      transport: "streamable-http",
      inputSchema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
      example: { ticker: "AAPL" },
      output: { example: { pe_ratio: 28.5 }, schema: { properties: { pe_ratio: { type: "number" } } } },
    },
  },
  {
    name: "MCP tool e2e shape",
    config: {
      toolName: "protected",
      transport: "sse",
      inputSchema: { type: "object", properties: {} },
      output: e2eOutput,
    },
  },
  {
    name: "MCP tool minimal with unknown transport",
    config: { toolName: "t", transport: "websocket", inputSchema: { type: "object" } },
  },
];

const declares = declareCases.map(({ name, config }) => ({
  name,
  kind: "declare",
  config,
  expected: declareDiscoveryExtension(config).bazaar,
}));

const adapter = (path: string) => ({ getPath: () => path });
const e2eGet = declareDiscoveryExtension({ output: e2eOutput }).bazaar;
const post = declareCases[5].config;
const postDecl = declareDiscoveryExtension(post).bazaar;
const withPathSchema = declareDiscoveryExtension({
  method: "GET",
  pathParamsSchema: { properties: { id: { type: "string" } } },
}).bazaar;
const mcpDecl = declareDiscoveryExtension(declareCases[10].config).bazaar;

const enrichCases: {
  name: string;
  declaration: unknown;
  context: { method: string; path: string; routePattern?: string } | null;
}[] = [
  { name: "e2e paid route narrows to GET", declaration: e2eGet, context: { method: "GET", path: "/protected", routePattern: "/protected" } },
  { name: "POST body route narrows to POST", declaration: postDecl, context: { method: "POST", path: "/orders" } },
  { name: "bracket param route", declaration: e2eGet, context: { method: "GET", path: "/users/123", routePattern: "/users/[userId]" } },
  { name: "colon param route", declaration: e2eGet, context: { method: "GET", path: "/users/123/posts/9", routePattern: "/users/:userId/posts/:postId" } },
  { name: "mixed bracket and colon", declaration: e2eGet, context: { method: "GET", path: "/a/1/b/2", routePattern: "/a/[x]/b/:y" } },
  { name: "dot in literal is not a wildcard", declaration: e2eGet, context: { method: "GET", path: "/api/v1X0/123", routePattern: "/api/v1.0/[id]" } },
  { name: "param route, path does not match", declaration: e2eGet, context: { method: "GET", path: "/other", routePattern: "/users/:id" } },
  { name: "wildcard segments become varN", declaration: e2eGet, context: { method: "GET", path: "/files/x/y", routePattern: "/files/*/*" } },
  { name: "bare wildcard gets no template", declaration: e2eGet, context: { method: "GET", path: "/anything", routePattern: "*" } },
  { name: "schema already has pathParams", declaration: withPathSchema, context: { method: "GET", path: "/users/7", routePattern: "/users/:id" } },
  { name: "mcp declaration untouched", declaration: mcpDecl, context: { method: "POST", path: "/mcp", routePattern: "/mcp" } },
  { name: "declaration without schema", declaration: { info: { input: { type: "http" } } }, context: { method: "GET", path: "/x" } },
  { name: "empty declaration", declaration: {}, context: { method: "GET", path: "/x" } },
  { name: "non-HTTP transport context", declaration: e2eGet, context: null },
];

const enriches = enrichCases.map(({ name, declaration, context }) => {
  const transportContext = context
    ? { method: context.method, routePattern: context.routePattern, adapter: adapter(context.path) }
    : { something: "else" };
  return {
    name,
    kind: "enrich",
    declaration,
    context,
    expected: bazaarResourceServerExtension.enrichDeclaration(declaration, transportContext),
  };
});

const doc = {
  generatedFrom: "typescript/packages/extensions/src/bazaar",
  tsCommit,
  cases: [...declares, ...enriches],
};
writeFileSync(join(outDir, "bazaar.json"), JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote bazaar.json (${declares.length} declare, ${enriches.length} enrich)`);
