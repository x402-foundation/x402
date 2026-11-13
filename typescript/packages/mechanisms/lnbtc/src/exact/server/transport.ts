import type { HTTPAdapter, HTTPTransportContext } from "@x402/core/http";
import { httpRequestBinding, mcpToolCallBinding } from "../../binding";
import { Errors, LnbtcError } from "../../constants";
import type { ServerRequestBinding } from "./scheme";

/**
 * Configuration for binding HTTP requests (`http:1`).
 */
export interface HttpTransportBindingConfig {
  /**
   * The resource's public origin, e.g. `https://api.example.com`. The request
   * target is appended to it; the `Host` header is never trusted.
   */
  publicOrigin: string;
  /** Lowercase names of every header that affects the purchased operation. */
  boundHeaders?: readonly string[];
  /**
   * Returns the raw request content bytes. Parsed bodies cannot be used: the
   * specification hashes the bytes as received. Defaults to the adapter's
   * body when it is bytes (for example after `express.raw()`).
   */
  rawBody?: (
    context: HTTPTransportContext,
  ) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
}

// RFC 3986 authority without userinfo: host (IP-literal, IPv4address, or
// reg-name, which also covers IPv4) and an optional port.
const AUTHORITY =
  /^(?:\[[0-9A-Fa-f:.]+\]|\[v[0-9A-Fa-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+\]|(?:[A-Za-z0-9\-._~!$&'()*+;=]|%[0-9A-Fa-f]{2})+)(?::[0-9]*)?$/;
// Headers first-party adapters build the URL's authority from: Express uses
// Host; Fastify uses Host, then :authority, or X-Forwarded-Host behind a
// trusted proxy; Hono and Next.js parse a URL built from Host (or :authority).
const AUTHORITY_HEADERS = ["host", ":authority", "x-forwarded-host"];
const SCHEME_TOKEN = /^[A-Za-z][A-Za-z0-9+.-]*$/;

/**
 * Reads raw body bytes from the adapter. A request without content hashes as
 * empty; content that a parser already consumed is refused, because the
 * original bytes are gone.
 *
 * @param context - HTTP transport context
 * @returns The body bytes
 */
async function adapterRawBody(context: HTTPTransportContext): Promise<Uint8Array> {
  const adapter = context.request.adapter;
  const body = await adapter.getBody?.();
  if (body instanceof Uint8Array) return body;
  const length = adapter.getHeader("content-length");
  const hasContent =
    adapter.getHeader("transfer-encoding") !== undefined ||
    (length !== undefined && !/^\s*0+\s*$/.test(length)) ||
    !isEmptyParsedBody(body);
  if (!hasContent) return new Uint8Array();
  throw new TypeError(
    "lnbtc http:1 binding needs the raw request body bytes: mount a raw body parser " +
      "(e.g. express.raw()) for this route or pass rawBody",
  );
}

/**
 * Whether a parsed adapter body carries no content: absent, `null`, an empty
 * string, or an empty plain object (some parsers default the body to `{}`).
 *
 * @param body - Parsed body from the adapter
 * @returns Whether the body is empty
 */
function isEmptyParsedBody(body: unknown): boolean {
  if (body === undefined || body === null || body === "") return true;
  return (
    typeof body === "object" &&
    Object.getPrototypeOf(body) === Object.prototype &&
    Object.keys(body).length === 0
  );
}

/**
 * Builds the server's `requestBinding` for HTTP resources.
 *
 * @param config - Public origin, bound headers, and raw-body accessor
 * @returns A binding function for {@link ExactLnbtcServerOptions.requestBinding}
 * @throws LnbtcError `invalid_exact_lnbtc_request_binding` when the configured
 *   origin or bound headers are invalid
 */
export function httpTransportBinding(config: HttpTransportBindingConfig): ServerRequestBinding {
  const origin = config.publicOrigin.replace(/\/+$/, "");
  const boundHeaders = [...(config.boundHeaders ?? [])];
  if (/[?#]/.test(origin)) throw new LnbtcError(Errors.requestBinding);
  // Validates the origin and header configuration once, up front.
  httpRequestBinding({
    method: "GET",
    url: `${origin}/`,
    boundHeaders,
    getHeader: () => undefined,
  });

  return async transportContext => {
    const context = transportContext as HTTPTransportContext | undefined;
    const adapter = context?.request?.adapter;
    if (!context || !adapter) throw new LnbtcError(Errors.requestBinding);
    const target = requestTarget(adapter.getUrl(), name => authorityHeader(adapter, name));
    const body = config.rawBody ? await config.rawBody(context) : await adapterRawBody(context);
    return httpRequestBinding({
      method: adapter.getMethod(),
      url: origin + target,
      body,
      boundHeaders,
      getHeader: name => adapter.getHeader(name),
    });
  };
}

/**
 * Reads an authority header. Fetch-based adapters (Hono, Next) back `getHeader`
 * with WHATWG `Headers`, whose `get` throws on HTTP/2 pseudo-header names such
 * as `:authority`; that header cannot be present there, so it reads as absent.
 *
 * @param adapter - HTTP adapter
 * @param name - Lowercase header name
 * @returns The header value, or undefined
 */
function authorityHeader(adapter: HTTPAdapter, name: string): string | undefined {
  if (!name.startsWith(":")) return adapter.getHeader(name);
  try {
    return adapter.getHeader(name);
  } catch {
    return undefined;
  }
}

/**
 * Configuration for binding MCP tool calls (`mcp:1`).
 */
export interface McpTransportBindingConfig {
  /** Configured absolute URI identifying this MCP server. */
  server: string;
  /** `_meta` member names that affect the purchased operation. */
  boundMetadata?: readonly string[];
}

/**
 * Builds the server's `requestBinding` for tools wrapped by `@x402/mcp`.
 *
 * @param config - Server identity and bound metadata names
 * @returns A binding function for {@link ExactLnbtcServerOptions.requestBinding}
 */
export function mcpTransportBinding(config: McpTransportBindingConfig): ServerRequestBinding {
  return transportContext => {
    const context = transportContext as
      | {
          toolName?: unknown;
          arguments?: unknown;
          meta?: unknown;
          rawToolCall?: { name?: unknown; arguments?: unknown; _meta?: unknown };
        }
      | undefined;
    // `@x402/mcp` servers that call `captureRawToolCalls` supply the call as
    // received; the spec binds arguments before schema defaults. Without it,
    // the validated arguments are bound, and a schema that adds defaults makes
    // the client refuse to pay (it never makes a wrong proof acceptable).
    const raw = context?.rawToolCall;
    const call = raw
      ? { name: raw.name, arguments: raw.arguments, meta: raw._meta }
      : { name: context?.toolName, arguments: context?.arguments, meta: context?.meta };
    if (typeof call.name !== "string") {
      throw new LnbtcError(Errors.requestBinding);
    }
    return mcpToolCallBinding({
      server: config.server,
      name: call.name,
      arguments: call.arguments,
      meta: call.meta,
      boundMetadata: config.boundMetadata ?? [],
    });
  };
}

/**
 * Extracts the raw request target (origin-form path and query) from the
 * adapter's absolute URL without normalizing it.
 *
 * Express and Fastify build that URL by concatenating request headers, so a
 * header such as `Host: x/search?q=` would turn a request for `/article/B`
 * into the target `/search?q=/article/B`. The URL alone cannot reveal this,
 * so the authority is checked at its source: every authority header present
 * must be a valid RFC 3986 authority, the URL's authority must equal one of
 * them (so a request with no authority header is refused), and
 * `X-Forwarded-Proto` must be a scheme token.
 *
 * @param url - Absolute request URL from the adapter
 * @param getHeader - Request header lookup
 * @returns The path and query, starting with `/`
 * @throws LnbtcError `invalid_exact_lnbtc_request_binding` on an unusable URL
 */
function requestTarget(url: string, getHeader: (name: string) => string | undefined): string {
  const match = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(url);
  if (!match) throw new LnbtcError(Errors.requestBinding);
  const [, scheme, authority, rest] = match;

  const forwardedProto = getHeader("x-forwarded-proto");
  if (forwardedProto !== undefined && !hops(forwardedProto).every(p => SCHEME_TOKEN.test(p))) {
    throw new LnbtcError(Errors.requestBinding);
  }
  const sources = AUTHORITY_HEADERS.flatMap(name => {
    const value = getHeader(name);
    return value === undefined ? [] : hops(value);
  });
  if (!sources.every(source => AUTHORITY.test(source))) {
    throw new LnbtcError(Errors.requestBinding);
  }
  const actual = normalizeAuthority(authority, scheme);
  if (!sources.some(source => normalizeAuthority(source, scheme) === actual)) {
    throw new LnbtcError(Errors.requestBinding);
  }

  if (rest === "") return "/";
  // A fragment left in the target fails URI validation in httpRequestBinding.
  if (!rest.startsWith("/") || rest.startsWith("//")) throw new LnbtcError(Errors.requestBinding);
  return rest;
}

/**
 * Splits a header into its comma-separated hops, as proxies append them.
 *
 * @param value - Header value
 * @returns Hops with optional whitespace (spaces and tabs, RFC 9110 OWS)
 *   trimmed; any other whitespace stays and fails validation
 */
function hops(value: string): string[] {
  return value.split(",").map(part => part.replace(/^[\t ]+|[\t ]+$/g, ""));
}

/**
 * Normalizes an authority for comparison the way WHATWG URL parsing does for
 * Hono and Next.js: lowercase, without the scheme's default port.
 *
 * @param authority - Authority text
 * @param scheme - `http` or `https`, any case
 * @returns The comparable authority
 */
function normalizeAuthority(authority: string, scheme: string): string {
  const lower = authority.toLowerCase();
  const defaultPort = scheme.toLowerCase() === "https" ? ":443" : ":80";
  return lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower;
}
