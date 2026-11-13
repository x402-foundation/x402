import { createHash, randomBytes } from "crypto";

export const CONFLICT_MESSAGE = "payment identifier already used with different request";
export const IN_FLIGHT_MESSAGE = "payment identifier is already being processed for this request";
export const CAPACITY_MESSAGE = "payment identifier reservation map is at capacity";

export const CONFLICT_STATUS_CODE = 409;
export const RETRYABLE_STATUS_CODE = 503;
export const RETRY_AFTER_SECONDS = 1;

/**
 * Server-owned in-flight reservation TTL for this GET-only example.
 * Client `accepted.maxTimeoutSeconds` is fingerprinted, never used as map TTL.
 */
export const RESERVATION_TTL_MS = 300_000;
export const FALLBACK_RESERVATION_TTL_MS = RESERVATION_TTL_MS;
export const MAX_PENDING_RESERVATIONS = 1024;

export const RESERVATION_STATE_PENDING = "pending";
export const RESERVATION_STATE_SETTLING = "settling";
export const RESERVATION_STATE_UNKNOWN = "unknown";

export type ReservationState = "pending" | "settling" | "unknown";

export type PaymentTermsSource = {
  accepted?: {
    scheme?: string;
    network?: string;
    asset?: string;
    amount?: string;
    payTo?: string;
    pay_to?: string;
    maxTimeoutSeconds?: number;
    max_timeout_seconds?: number;
    extra?: unknown;
  };
  payload?: unknown;
};

export type Reservation = {
  fingerprint: string;
  timestamp: number;
  token: string;
  ttlMs: number;
  state: ReservationState;
};

export type RequestFingerprintInput = {
  method: string;
  url: string;
  body?: Buffer | string | null;
  payload?: PaymentTermsSource | null;
};

export type BindPaymentIdInput = {
  cache: {
    get(paymentId: string): { timestamp: number; fingerprint?: string } | undefined;
    delete(paymentId: string): boolean;
  };
  reservations: Map<string, Reservation>;
  paymentId: string;
  fingerprint: string;
  now: number;
  cacheTtlMs: number;
  reservationTtlMs?: number;
  maxPending?: number;
};

export type CacheDecision =
  | { kind: "hit"; statusCode: 200; grantAccess: true }
  | { kind: "conflict"; statusCode: 409; grantAccess: false }
  | { kind: "in_flight"; statusCode: 503; grantAccess: false }
  | { kind: "capacity"; statusCode: 503; grantAccess: false }
  | { kind: "miss"; statusCode: null; grantAccess: false }
  | { kind: "expired"; statusCode: null; grantAccess: false };

/**
 * Canonical JSON with recursively sorted object keys.
 *
 * @param value - JSON-compatible value
 * @returns Canonical JSON string
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * RFC 3986 percent-encode one query component.
 *
 * Unreserved characters (`A-Z a-z 0-9 - . _ ~`) stay literal. Every other
 * octet, including space, is `%`-encoded uppercase UTF-8. `~` is not encoded.
 *
 * @param value - Decoded query key or value
 * @returns Encoded component
 */
export function rfc3986Encode(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    if (unreserved) {
      out += String.fromCharCode(byte);
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * Canonical path and query, without host or fragment.
 *
 * Query pairs are decoded, stably sorted by decoded key (duplicate-key order
 * preserved), and re-encoded with {@link rfc3986Encode}. Spaces become `%20`.
 *
 * @param url - Absolute URL or path with optional query
 * @returns Canonical request target
 */
export function canonicalRequestUrl(url: string): string {
  const parsed = new URL(url, "http://localhost");
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams) {
    pairs.push([key, value]);
  }
  pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const query = pairs
    .map(([key, value]) => `${rfc3986Encode(key)}=${rfc3986Encode(value)}`)
    .join("&");
  return query ? `${parsed.pathname}?${query}` : parsed.pathname;
}

/**
 * Path only for paid-route matching. Does not collapse `/foo/../weather`.
 *
 * @param url - Absolute URL or path with optional query
 * @returns Request path
 */
export function requestPath(url: string): string {
  const noQuery = url.split("?")[0] || "/";
  const scheme = noQuery.indexOf("://");
  if (scheme === -1) {
    return noQuery.startsWith("/") ? noQuery || "/" : `/${noQuery}`;
  }
  const pathStart = noQuery.indexOf("/", scheme + 3);
  return pathStart === -1 ? "/" : noQuery.slice(pathStart) || "/";
}

/**
 * True when method+path is an exact paid route table key (e.g. `GET /weather`).
 *
 * @param method - HTTP method
 * @param url - Absolute URL or path
 * @param routes - Paid route table
 * @returns Whether the route is protected
 */
export function isProtectedRoute(method: string, url: string, routes: object): boolean {
  const key = `${(method || "").toUpperCase()} ${requestPath(url)}`;
  return Object.prototype.hasOwnProperty.call(routes, key);
}

/**
 * SHA-256 hex digest of the raw request body. Missing bodies hash as empty bytes.
 *
 * @param body - Raw request body
 * @returns Hex digest
 */
export function bodySha256(body: Buffer | string | null | undefined): string {
  const data = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 of canonical JSON for `payload.payload` (signature / authorization).
 *
 * @param payload - Payment payload
 * @returns Hex digest
 */
export function credentialSha256(payload?: PaymentTermsSource | null): string {
  const credential = payload?.payload;
  const canonical =
    credential === undefined || credential === null ? "" : canonicalJson(credential);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Canonical `maxTimeoutSeconds` string from camelCase or snake_case accepted terms.
 *
 * @param accepted - Accepted payment terms
 * @returns String form, or empty when absent
 */
export function canonicalMaxTimeoutSeconds(accepted?: PaymentTermsSource["accepted"]): string {
  const terms = accepted ?? {};
  const raw = terms.maxTimeoutSeconds ?? terms.max_timeout_seconds;
  return raw === undefined || raw === null ? "" : String(raw);
}

/**
 * Recursively canonical JSON of `accepted.extra`. Missing extra is `{}`.
 *
 * @param accepted - Accepted payment terms
 * @returns Canonical extra JSON
 */
export function canonicalAcceptedExtra(accepted?: PaymentTermsSource["accepted"]): string {
  const extra = accepted?.extra;
  if (extra === undefined || extra === null) {
    return "{}";
  }
  return canonicalJson(extra);
}

/**
 * Server-owned reservation TTL. Ignores client `maxTimeoutSeconds`.
 *
 * @returns TTL in milliseconds
 */
export function reservationTtlMs(): number {
  return RESERVATION_TTL_MS;
}

/**
 * Fingerprint the HTTP request, accepted terms, extra, timeout, and credential.
 *
 * Hashing the payment payload or payment header is not request binding: the same
 * signed payload can be replayed against a different method, path, or body.
 * Hashing only the HTTP request is also insufficient: a stolen payment ID plus
 * a fabricated credential must not retrieve the cached paid response.
 *
 * @param input - HTTP method, URL, raw body, and payment payload
 * @returns SHA-256 hex digest
 */
export function requestFingerprint(input: RequestFingerprintInput): string {
  const accepted = input.payload?.accepted ?? {};
  const material = {
    amount: String(accepted.amount ?? ""),
    asset: String(accepted.asset ?? ""),
    bodySha256: bodySha256(input.body),
    credentialSha256: credentialSha256(input.payload),
    extra: canonicalAcceptedExtra(accepted),
    maxTimeoutSeconds: canonicalMaxTimeoutSeconds(accepted),
    method: (input.method || "").toUpperCase(),
    network: String(accepted.network ?? ""),
    payTo: String(accepted.payTo ?? accepted.pay_to ?? ""),
    scheme: String(accepted.scheme ?? ""),
    url: canonicalRequestUrl(input.url),
  };
  const keys = Object.keys(material).sort();
  return createHash("sha256").update(JSON.stringify(material, keys)).digest("hex");
}

/**
 * Look up a cached payment ID against the current request fingerprint.
 *
 * A conflict never grants access.
 *
 * @param cached - Existing cache entry, if any
 * @param fingerprint - Fingerprint of the incoming HTTP request and credential
 * @param now - Current time in milliseconds
 * @param ttlMs - Cache time to live in milliseconds
 * @returns Cache decision
 */
export function lookup(
  cached: { timestamp: number; fingerprint?: string } | undefined,
  fingerprint: string,
  now: number,
  ttlMs: number,
): CacheDecision {
  if (!cached) {
    return { kind: "miss", statusCode: null, grantAccess: false };
  }
  if (now - cached.timestamp >= ttlMs) {
    return { kind: "expired", statusCode: null, grantAccess: false };
  }
  if (!cached.fingerprint || cached.fingerprint !== fingerprint) {
    return { kind: "conflict", statusCode: CONFLICT_STATUS_CODE, grantAccess: false };
  }
  return { kind: "hit", statusCode: 200, grantAccess: true };
}

/**
 * Stored reservation TTL, falling back to the server-owned constant.
 *
 * @param storedTtlMs - TTL stored on the reservation
 * @param ttlMs - Server-owned fallback TTL
 * @returns Live window in milliseconds
 */
function liveLimit(storedTtlMs: number | undefined, ttlMs: number): number {
  return storedTtlMs && storedTtlMs > 0 ? storedTtlMs : ttlMs;
}

/**
 * True when the caller owns this reservation. Missing token never matches.
 *
 * @param existing - Stored reservation
 * @param fingerprint - Caller fingerprint
 * @param token - Caller token
 * @returns Whether the caller may mutate the reservation
 */
function ownsReservation(
  existing: Reservation,
  fingerprint: string,
  token: string | undefined,
): boolean {
  if (!token || !existing.token) {
    return false;
  }
  if (!existing.fingerprint || existing.fingerprint !== fingerprint) {
    return false;
  }
  return existing.token === token;
}

/**
 * True when the reservation is still inside its server-owned TTL.
 *
 * @param existing - Stored reservation
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned fallback TTL
 * @returns Whether the reservation is live
 */
function isLive(existing: Reservation, now: number, ttlMs: number): boolean {
  return now - existing.timestamp < liveLimit(existing.ttlMs, ttlMs);
}

/**
 * Remove expired in-flight reservations in one pass over the current map.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned reservation time to live in milliseconds
 * @returns Number of reservations removed
 */
export function cleanupExpiredReservations(
  reservations: Map<string, Reservation>,
  now: number,
  ttlMs: number = RESERVATION_TTL_MS,
): number {
  let removed = 0;
  for (const [key, value] of reservations.entries()) {
    if (!isLive(value, now, ttlMs)) {
      reservations.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Reserve a payment ID for an in-flight request, or refuse without granting access.
 *
 * A live reservation is never overwritten. Same fingerprint is a retryable
 * in-flight response; a different fingerprint is a request conflict. Expired
 * entries are removed and replaced with a fresh token. After expired cleanup,
 * a full map of {@link MAX_PENDING_RESERVATIONS} fails closed with capacity.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param fingerprint - Fingerprint of the incoming HTTP request and credential
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned reservation time to live in milliseconds
 * @param token - Optional caller-supplied reservation token
 * @param maxPending - Maximum live reservations after cleanup
 * @returns Reservation decision; never grants access
 */
export function tryReserve(
  reservations: Map<string, Reservation>,
  paymentId: string,
  fingerprint: string,
  now: number,
  ttlMs: number = RESERVATION_TTL_MS,
  token?: string,
  maxPending: number = MAX_PENDING_RESERVATIONS,
): CacheDecision {
  cleanupExpiredReservations(reservations, now, ttlMs);
  const existing = reservations.get(paymentId);
  if (existing && isLive(existing, now, ttlMs)) {
    if (existing.fingerprint && existing.fingerprint === fingerprint) {
      return { kind: "in_flight", statusCode: RETRYABLE_STATUS_CODE, grantAccess: false };
    }
    return { kind: "conflict", statusCode: CONFLICT_STATUS_CODE, grantAccess: false };
  }
  if (existing) {
    reservations.delete(paymentId);
  }
  if (reservations.size >= maxPending) {
    return { kind: "capacity", statusCode: RETRYABLE_STATUS_CODE, grantAccess: false };
  }
  reservations.set(paymentId, {
    fingerprint,
    timestamp: now,
    token: token ?? randomBytes(16).toString("hex"),
    ttlMs,
    state: RESERVATION_STATE_PENDING,
  });
  return { kind: "miss", statusCode: null, grantAccess: false };
}

/**
 * Consume a matching current reservation and return its fingerprint for caching.
 *
 * Outcome-unknown tombstones are retained. A stale callback that does not own
 * the current reservation must not pop it. Missing token is never ownership.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param fingerprint - Fingerprint that must match the reservation
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned reservation time to live in milliseconds
 * @param token - Reservation token from the request that reserved
 * @returns Fingerprint to cache, or undefined if missing, mismatched, or unknown
 */
export function consumeReservation(
  reservations: Map<string, Reservation>,
  paymentId: string,
  fingerprint: string,
  now: number,
  ttlMs: number = RESERVATION_TTL_MS,
  token?: string,
): string | undefined {
  // Retained for call-site symmetry and compatibility. Exact current-token
  // callbacks are authoritative even after this phase deadline; cleanup and a
  // replacement token, rather than wall-clock age alone, revoke ownership.
  void now;
  void ttlMs;
  const existing = reservations.get(paymentId);
  if (!existing || !ownsReservation(existing, fingerprint, token)) {
    return undefined;
  }
  if (existing.state === RESERVATION_STATE_UNKNOWN) {
    return undefined;
  }
  if (!existing.fingerprint) {
    return undefined;
  }
  // An exact current token may finish after its phase deadline if no cleanup
  // request has replaced it. A replacement has a different token and fails
  // ownership above, so a stale callback cannot consume newer work.
  reservations.delete(paymentId);
  return existing.fingerprint;
}

/**
 * Drop a matching pending or settling reservation. Unknown tombstones stay.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param fingerprint - Fingerprint that must match the reservation
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned reservation time to live in milliseconds
 * @param token - Reservation token from the request that reserved
 * @returns True when a live matching reservation was removed
 */
export function releaseReservation(
  reservations: Map<string, Reservation>,
  paymentId: string,
  fingerprint: string,
  now: number,
  ttlMs: number = RESERVATION_TTL_MS,
  token?: string,
): boolean {
  const existing = reservations.get(paymentId);
  if (!existing || !ownsReservation(existing, fingerprint, token)) {
    return false;
  }
  if (existing.state === RESERVATION_STATE_UNKNOWN) {
    return false;
  }
  if (!isLive(existing, now, ttlMs)) {
    return false;
  }
  reservations.delete(paymentId);
  return true;
}

/**
 * Release only a pending pre-settlement reservation owned by this token.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param fingerprint - Fingerprint that must match the reservation
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned reservation time to live in milliseconds
 * @param token - Reservation token from the request that reserved
 * @returns True when a pending reservation was removed
 */
export function releaseIfPending(
  reservations: Map<string, Reservation>,
  paymentId: string,
  fingerprint: string,
  now: number,
  ttlMs: number = RESERVATION_TTL_MS,
  token?: string,
): boolean {
  const existing = reservations.get(paymentId);
  if (!existing || existing.state !== RESERVATION_STATE_PENDING) {
    return false;
  }
  return releaseReservation(reservations, paymentId, fingerprint, now, ttlMs, token);
}

/**
 * Mark a matching exact-token reservation as having entered settlement.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param fingerprint - Fingerprint that must match the reservation
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned reservation time to live in milliseconds
 * @param token - Reservation token from the request that reserved
 * @returns True when the reservation was marked settling
 */
export function markSettlementStarted(
  reservations: Map<string, Reservation>,
  paymentId: string,
  fingerprint: string,
  now: number,
  ttlMs: number = RESERVATION_TTL_MS,
  token?: string,
): boolean {
  const existing = reservations.get(paymentId);
  // Retained for call-site symmetry. If cleanup has not replaced the exact
  // current token, that token still owns the right to enter settlement even
  // after the prior pending deadline. A replacement fails ownership.
  void ttlMs;
  if (!existing || !ownsReservation(existing, fingerprint, token)) {
    return false;
  }
  if (existing.state === RESERVATION_STATE_UNKNOWN) {
    return false;
  }
  existing.state = RESERVATION_STATE_SETTLING;
  existing.timestamp = now;
  return true;
}

/**
 * Retain a tokenized outcome-unknown tombstone until the server TTL expires.
 *
 * A fresh credential under this ID is a conflict. The same fingerprint is
 * retryable in-flight until expiry. Missing token does not mutate.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param fingerprint - Fingerprint that must match the reservation
 * @param now - Current time in milliseconds
 * @param ttlMs - Server-owned reservation time to live in milliseconds
 * @param token - Reservation token from the request that reserved
 * @returns True when the reservation was marked unknown
 */
export function markOutcomeUnknown(
  reservations: Map<string, Reservation>,
  paymentId: string,
  fingerprint: string,
  now: number,
  ttlMs: number = RESERVATION_TTL_MS,
  token?: string,
): boolean {
  // Retained for call-site symmetry. Exact current-token ownership, not an
  // already elapsed phase deadline, controls this final transition.
  void ttlMs;
  const existing = reservations.get(paymentId);
  if (!existing || !ownsReservation(existing, fingerprint, token)) {
    return false;
  }
  if (existing.state === RESERVATION_STATE_UNKNOWN) {
    return false;
  }
  existing.state = RESERVATION_STATE_UNKNOWN;
  existing.timestamp = now;
  return true;
}

/**
 * Read the middleware reservation token from an Express SDK transport context.
 *
 * ExpressAdapter stores the request on `adapter.req`. Missing adapter or token
 * is not fingerprint-only ownership.
 *
 * @param transportContext - SDK `HTTPTransportContext`
 * @returns Reservation token, or undefined when the adapter did not carry it
 */
export function reservationTokenFromTransportContext(
  transportContext: unknown,
): string | undefined {
  const transport = transportContext as
    | {
        request?: {
          adapter?: { req?: { x402ReservationToken?: string } };
        };
      }
    | undefined;
  return transport?.request?.adapter?.req?.x402ReservationToken;
}

/**
 * Look up the settled cache, then reserve the payment ID if needed.
 *
 * Cache hits and settled conflicts win over reservations. An unexpired
 * reservation never grants access and never proceeds to a second settlement.
 *
 * @param input - Cache, reservations, payment ID, fingerprint, and TTLs
 * @returns Cache or reservation decision
 */
export function bindPaymentId(input: BindPaymentIdInput): CacheDecision {
  const cached = input.cache.get(input.paymentId);
  const decision = lookup(cached, input.fingerprint, input.now, input.cacheTtlMs);
  if (decision.kind === "hit" || decision.kind === "conflict") {
    return decision;
  }
  if (decision.kind === "expired") {
    input.cache.delete(input.paymentId);
  }
  return tryReserve(
    input.reservations,
    input.paymentId,
    input.fingerprint,
    input.now,
    input.reservationTtlMs ?? RESERVATION_TTL_MS,
    undefined,
    input.maxPending ?? MAX_PENDING_RESERVATIONS,
  );
}
