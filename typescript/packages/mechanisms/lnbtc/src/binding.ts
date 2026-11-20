import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { BINDING_DOMAIN_PREFIX, Errors, HTTP_PROFILE, LnbtcError, MCP_PROFILE } from "./constants";
import { canonicalize, isWellFormed } from "./jcs";

export type RequestBindingProfile = typeof HTTP_PROFILE | typeof MCP_PROFILE;

/**
 * The request-binding fields carried in `PaymentRequirements.extra`.
 */
export interface RequestBindingExtra {
  requestHash: string;
  requestBindingProfile: RequestBindingProfile;
  requestBindingParams: Record<string, unknown>;
}

/**
 * A request binding computed from the actual request or tool call.
 */
export interface RequestBinding extends RequestBindingExtra {
  /** For `http:1`, the request URL that `PaymentRequired.resource.url` must equal. */
  resourceUrl?: string;
}

/**
 * HTTP request inputs for the `http:1` profile.
 */
export interface HttpRequestInput {
  /** HTTP method, case preserved (RFC 9421 `@method`). */
  method: string;
  /** Absolute http(s) target URI including the query, no fragment or userinfo. */
  url: string;
  /** Content bytes after transfer decoding, before content decoding; empty if absent. */
  body?: Uint8Array;
  /** Lowercase header names to bind, configured by the server for the resource. */
  boundHeaders: readonly string[];
  /** Header lookup by lowercase name; `undefined` when absent. */
  getHeader: (name: string) => string | readonly string[] | undefined;
}

/**
 * MCP `tools/call` inputs for the `mcp:1` profile.
 */
export interface McpToolCallInput {
  /** Configured absolute URI identifying the MCP server. */
  server: string;
  /** Actual `params.name`. */
  name: string;
  /** Actual `params.arguments`, before defaults; `undefined` when omitted. */
  arguments?: unknown;
  /** Actual `params._meta`; `undefined` when omitted. */
  meta?: unknown;
  /** `_meta` member names to bind, configured by the server for the tool. */
  boundMetadata: readonly string[];
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOWER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
// RFC 3986 URI characters (no fragment) with well-formed percent escapes.
// Square brackets are accepted outside the host too, as common clients send them raw.
const URI_SYNTAX =
  /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;
const ABSENT_HASH = bytesToHex(sha256(Uint8Array.of(0x00)));
const EXCLUDED_METADATA = new Set(["x402/payment", "progressToken"]);

/**
 * Computes the `http:1` binding for an HTTP request.
 *
 * @param input - The actual request and the configured bound headers
 * @returns The binding, including the expected `PaymentRequired.resource.url`
 * @throws LnbtcError `invalid_exact_lnbtc_request_binding` on malformed input
 */
export function httpRequestBinding(input: HttpRequestInput): RequestBinding {
  const params = { headers: [...input.boundHeaders] };
  validateHttpParams(params);
  if (typeof input.method !== "string" || !TOKEN.test(input.method)) fail();
  validateAbsoluteUri(input.url, true);
  if (input.body !== undefined && !(input.body instanceof Uint8Array)) fail();

  const headers = params.headers.map(name => ({
    name,
    valueHash: headerValueHash(input.getHeader(name)),
  }));
  const binding = {
    domain: `${BINDING_DOMAIN_PREFIX}${HTTP_PROFILE}`,
    method: input.method,
    url: input.url,
    bodyHash: bytesToHex(sha256(input.body ?? new Uint8Array())),
    headers,
  };
  return {
    requestHash: hashBinding(binding),
    requestBindingProfile: HTTP_PROFILE,
    requestBindingParams: params,
    resourceUrl: input.url,
  };
}

/**
 * Computes the `mcp:1` binding for an MCP `tools/call`.
 *
 * @param input - The actual tool call and the configured server and metadata names
 * @returns The binding
 * @throws LnbtcError `invalid_exact_lnbtc_request_binding` on malformed input
 */
export function mcpToolCallBinding(input: McpToolCallInput): RequestBinding {
  const params = { server: input.server, metadata: [...input.boundMetadata] };
  validateMcpParams(params);
  if (typeof input.name !== "string" || input.name.length === 0) fail();
  const args = input.arguments === undefined ? {} : input.arguments;
  if (!isPlainObject(args)) fail();
  const meta = input.meta === undefined ? {} : input.meta;
  if (!isPlainObject(meta)) fail();

  const metadata = params.metadata.map(name => ({
    name,
    valueHash: Object.prototype.hasOwnProperty.call(meta, name)
      ? hashPresent(new TextEncoder().encode(jcs(meta[name])))
      : ABSENT_HASH,
  }));
  const binding = {
    domain: `${BINDING_DOMAIN_PREFIX}${MCP_PROFILE}`,
    server: params.server,
    method: "tools/call",
    name: input.name,
    arguments: args,
    metadata,
  };
  return {
    requestHash: hashBinding(binding),
    requestBindingProfile: MCP_PROFILE,
    requestBindingParams: params,
  };
}

/**
 * Validates the binding fields of a requirements `extra` object.
 *
 * @param extra - `PaymentRequirements.extra`
 * @returns The validated binding fields
 * @throws LnbtcError `invalid_exact_lnbtc_request_binding` when missing or malformed
 */
export function parseBindingExtra(extra: Record<string, unknown> | undefined): RequestBindingExtra {
  const requestHash = extra?.requestHash;
  const profile = extra?.requestBindingProfile;
  const params = extra?.requestBindingParams;
  if (typeof requestHash !== "string" || !HEX64.test(requestHash)) fail();
  if (!isPlainObject(params)) fail();
  if (profile === HTTP_PROFILE) validateHttpParams(params);
  else if (profile === MCP_PROFILE) validateMcpParams(params);
  else fail();
  return {
    requestHash,
    requestBindingProfile: profile as RequestBindingProfile,
    requestBindingParams: params,
  };
}

/**
 * Compares two validated bindings: hash, profile, and JCS-equal parameters.
 *
 * @param a - First binding
 * @param b - Second binding
 * @returns Whether they are equal
 */
export function bindingsEqual(a: RequestBindingExtra, b: RequestBindingExtra): boolean {
  return (
    a.requestHash === b.requestHash &&
    a.requestBindingProfile === b.requestBindingProfile &&
    jcs(a.requestBindingParams) === jcs(b.requestBindingParams)
  );
}

/**
 * Validates `http:1` parameters: exactly `headers`, lowercase tokens, strictly
 * ascending, excluding `payment-signature`.
 *
 * @param params - Candidate parameters
 */
function validateHttpParams(params: Record<string, unknown>): void {
  if (Object.keys(params).length !== 1 || !Array.isArray(params.headers)) fail();
  validateSortedNames(params.headers as unknown[], name => LOWER_TOKEN.test(name));
  if ((params.headers as string[]).includes("payment-signature")) fail();
}

/**
 * Validates `mcp:1` parameters: exactly `server` and `metadata`.
 *
 * @param params - Candidate parameters
 */
function validateMcpParams(params: Record<string, unknown>): void {
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== "metadata" || keys[1] !== "server") fail();
  if (typeof params.server !== "string") fail();
  validateAbsoluteUri(params.server as string, false);
  if (!Array.isArray(params.metadata)) fail();
  validateSortedNames(
    params.metadata as unknown[],
    name => name.length > 0 && isWellFormed(name) && !EXCLUDED_METADATA.has(name),
  );
}

/**
 * Requires a strictly ascending list of valid names.
 *
 * @param names - Candidate names
 * @param valid - Per-name validity check
 */
function validateSortedNames(names: unknown[], valid: (name: string) => boolean): void {
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (typeof name !== "string" || !valid(name)) fail();
    // JS string comparison orders by UTF-16 code units: ASCII order for header
    // names, JCS property order for metadata names.
    if (i > 0 && (names[i - 1] as string) >= (name as string)) fail();
  }
}

/**
 * Validates an absolute URI in RFC 3986 ASCII syntax with no userinfo or
 * fragment, without normalizing it. `http` and `https` URIs need an authority
 * with a host (`scheme://host...`).
 *
 * @param uri - Candidate URI
 * @param httpOnly - Require the `http` or `https` scheme
 */
function validateAbsoluteUri(uri: string, httpOnly: boolean): void {
  if (typeof uri !== "string" || !URI_SYNTAX.test(uri)) fail();
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    fail();
  }
  if (parsed.username || parsed.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?]*@/i.test(uri)) fail();
  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  if (httpOnly && !isHttp) fail();
  if (isHttp && (!/^https?:\/\/[^/?]/i.test(uri) || parsed.hostname === "")) fail();
}

/**
 * Hashes a header per RFC 9421 section 2.1 default field-component rules.
 *
 * @param value - Header value(s), or `undefined` when absent
 * @returns The value hash, lowercase hex
 */
function headerValueHash(value: string | readonly string[] | undefined): string {
  // No field lines (undefined or an empty list) means the header is absent.
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return ABSENT_HASH;
  const lines = typeof value === "string" ? [value] : value;
  const parts = lines.map(line => {
    if (typeof line !== "string" || !/^[\t\x20-\x7e]*$/.test(line)) fail();
    return line.replace(/^[\t ]+|[\t ]+$/g, "");
  });
  return hashPresent(new TextEncoder().encode(parts.join(", ")));
}

/**
 * Hashes a present value as SHA-256 of `0x01 || bytes`.
 *
 * @param bytes - Value bytes
 * @returns Lowercase hex digest
 */
function hashPresent(bytes: Uint8Array): string {
  const input = new Uint8Array(bytes.length + 1);
  input[0] = 0x01;
  input.set(bytes, 1);
  return bytesToHex(sha256(input));
}

/**
 * Hashes a binding object: SHA-256 of UTF-8 JCS.
 *
 * @param binding - The binding object
 * @returns Lowercase hex request hash
 */
function hashBinding(binding: Record<string, unknown>): string {
  return bytesToHex(sha256(new TextEncoder().encode(jcs(binding))));
}

/**
 * Canonicalizes, mapping serialization errors to the binding error.
 *
 * @param value - Value to canonicalize
 * @returns JCS text
 */
function jcs(value: unknown): string {
  try {
    return canonicalize(value);
  } catch {
    fail();
  }
}

/**
 * Checks for a plain (non-array, non-null) object.
 *
 * @param value - Candidate value
 * @returns Whether it is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Throws the request-binding error.
 *
 * @returns Never returns
 */
function fail(): never {
  throw new LnbtcError(Errors.requestBinding);
}
