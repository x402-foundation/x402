import { createHash } from "crypto";

export const CONFLICT_MESSAGE = "payment identifier already used with different request";
export const IN_FLIGHT_MESSAGE = "payment identifier is already being processed for this request";

/**
 * In-flight reservation TTL in milliseconds.
 *
 * Distinct from the one-hour settled cache TTL. Failed payment verification
 * must not leak a pending entry or block the payment ID forever.
 */
export const RESERVATION_TTL_MS = 30_000;

export type PaymentTermsSource = {
  accepted?: {
    scheme?: string;
    network?: string;
    asset?: string;
    amount?: string;
    payTo?: string;
    pay_to?: string;
  };
};

export type Reservation = {
  fingerprint: string;
  timestamp: number;
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
  reservationTtlMs: number;
};

export type CacheDecision =
  | { kind: "hit"; statusCode: 200; grantAccess: true }
  | { kind: "conflict"; statusCode: 409; grantAccess: false }
  | { kind: "in_flight"; statusCode: 409; grantAccess: false }
  | { kind: "miss"; statusCode: null; grantAccess: false }
  | { kind: "expired"; statusCode: null; grantAccess: false };

/**
 * Canonical path and sorted query, without host or fragment.
 *
 * Keys are sorted; duplicate-key order is preserved (URLSearchParams.sort()).
 *
 * @param url - Absolute URL or path with optional query
 * @returns Canonical request target
 */
export function canonicalRequestUrl(url: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.searchParams.sort();
  return parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
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
 * Fingerprint the HTTP request plus accepted payment terms.
 *
 * Hashing the payment payload or payment header is not request binding: the same
 * signed payload can be replayed against a different method, path, or body.
 *
 * @param input - HTTP method, URL, raw body, and payment payload terms
 * @returns SHA-256 hex digest
 */
export function requestFingerprint(input: RequestFingerprintInput): string {
  const accepted = input.payload?.accepted ?? {};
  const material = {
    amount: String(accepted.amount ?? ""),
    asset: String(accepted.asset ?? ""),
    bodySha256: bodySha256(input.body),
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
 * @param fingerprint - Fingerprint of the incoming HTTP request
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
    return { kind: "conflict", statusCode: 409, grantAccess: false };
  }
  return { kind: "hit", statusCode: 200, grantAccess: true };
}

/**
 * Remove expired in-flight reservations in one pass over the current map.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param now - Current time in milliseconds
 * @param ttlMs - Reservation time to live in milliseconds
 * @returns Number of reservations removed
 */
export function cleanupExpiredReservations(
  reservations: Map<string, Reservation>,
  now: number,
  ttlMs: number,
): number {
  let removed = 0;
  for (const [key, value] of reservations.entries()) {
    if (now - value.timestamp >= ttlMs) {
      reservations.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Reserve a payment ID for an in-flight request, or refuse without granting access.
 *
 * A live reservation is never overwritten. Same fingerprint is an in-flight
 * conflict; a different fingerprint is a request conflict. Expired entries are
 * removed and replaced.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param fingerprint - Fingerprint of the incoming HTTP request
 * @param now - Current time in milliseconds
 * @param ttlMs - Reservation time to live in milliseconds
 * @returns Reservation decision; never grants access
 */
export function tryReserve(
  reservations: Map<string, Reservation>,
  paymentId: string,
  fingerprint: string,
  now: number,
  ttlMs: number,
): CacheDecision {
  const existing = reservations.get(paymentId);
  if (existing && now - existing.timestamp < ttlMs) {
    if (existing.fingerprint && existing.fingerprint === fingerprint) {
      return { kind: "in_flight", statusCode: 409, grantAccess: false };
    }
    return { kind: "conflict", statusCode: 409, grantAccess: false };
  }
  if (existing) {
    reservations.delete(paymentId);
  }
  reservations.set(paymentId, { fingerprint, timestamp: now });
  return { kind: "miss", statusCode: null, grantAccess: false };
}

/**
 * Consume a live reservation and return its fingerprint for caching.
 *
 * Missing or expired reservations return undefined and must not be cached.
 *
 * @param reservations - In-flight reservations keyed by payment ID
 * @param paymentId - Payment identifier
 * @param now - Current time in milliseconds
 * @param ttlMs - Reservation time to live in milliseconds
 * @returns Fingerprint to cache, or undefined if missing or expired
 */
export function consumeReservation(
  reservations: Map<string, Reservation>,
  paymentId: string,
  now: number,
  ttlMs: number,
): string | undefined {
  const existing = reservations.get(paymentId);
  if (!existing) {
    return undefined;
  }
  reservations.delete(paymentId);
  if (now - existing.timestamp >= ttlMs || !existing.fingerprint) {
    return undefined;
  }
  return existing.fingerprint;
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
    input.reservationTtlMs,
  );
}
