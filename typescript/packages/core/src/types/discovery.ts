import { PaymentRequirements, ResourceInfo } from "./payments";

/**
 * How to call a discovered resource. The skeleton (`method`, `routeTemplate`) is
 * always derived from the route; the richer fields are present only when the
 * server declared them (e.g. via the bazaar discovery extension).
 */
export interface DiscoveryInput {
  /** HTTP method (GET, POST, …). */
  method?: string;
  /** Canonical route template for dynamic routes, e.g. `/users/:id`. */
  routeTemplate?: string;
  /** JSON Schema for path parameters (when declared). */
  pathParams?: Record<string, unknown>;
  /** JSON Schema for query parameters (when declared). */
  queryParams?: Record<string, unknown>;
  /** JSON Schema for the request body (body methods, when declared). */
  body?: Record<string, unknown>;
  /** Body encoding: `json` | `form-data` | `text` (body methods). */
  bodyType?: string;
  /** MCP tool name (for `type: "mcp"`). */
  toolName?: string;
  /** MCP tool input JSON Schema (for `type: "mcp"`). */
  inputSchema?: Record<string, unknown>;
  /** MCP transport: `streamable-http` | `sse`. */
  transport?: string;
}

/** What a discovered resource returns. Present only when declared. */
export interface DiscoveryOutput {
  /** Response MIME type, e.g. `application/json`. */
  mimeType?: string;
  /** Example response value. */
  example?: unknown;
  /** JSON Schema for the response (when available). */
  schema?: Record<string, unknown>;
}

/**
 * A single discoverable x402 resource in a discovery manifest.
 *
 * Mirrors the core `PaymentRequired` shape for identity + payment (`resource`
 * object + `accepts`), with the invocation contract lifted to top-level
 * `input`/`output`. It deliberately does NOT carry full extension payloads —
 * those are runtime concerns the live `402` provides — only a lightweight
 * `requires` capability hint.
 */
export interface DiscoveryManifestResource {
  /** Resource identity + service metadata (URL, description, tags, …). */
  resource: ResourceInfo;
  /** Resource type, e.g. `http` or `mcp`. */
  type: string;
  /** Accepted payment methods. Advisory — the live 402 is authoritative. */
  accepts: PaymentRequirements[];
  /** How to call the resource (method/route template + any declared schemas). */
  input: DiscoveryInput;
  /** What the resource returns (when declared). */
  output?: DiscoveryOutput;
  /**
   * Lightweight capability hint: keys of extensions a consumer must satisfy to
   * use this resource (e.g. `sign-in-with-x`). The actual extension payloads
   * (challenges, sessions) come from the live `402`, not the manifest.
   */
  requires?: string[];
}

/**
 * A per-origin discovery manifest, served at `/.well-known/x402.json`.
 */
export interface DiscoveryManifest {
  /** Protocol version. Always 2 for v2. */
  x402Version: number;
  /** Unix timestamp (seconds) of when the manifest was generated. */
  lastUpdated?: number;
  /** The discoverable resources for this origin. */
  items: DiscoveryManifestResource[];
}
