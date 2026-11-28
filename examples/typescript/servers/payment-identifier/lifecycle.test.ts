import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RESERVATION_STATE_UNKNOWN,
  RESERVATION_TTL_MS,
  bindPaymentId,
  consumeReservation,
  isProtectedRoute,
  markOutcomeUnknown,
  markSettlementStarted,
  releaseIfPending,
  requestFingerprint,
  reservationTokenFromTransportContext,
  type Reservation,
} from "./request-binding.ts";

const PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa";
const PAID_ROUTES = { "GET /weather": {} };
const PAYLOAD = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x0000000000000000000000000000000000000001",
    amount: "1000",
    payTo: "0x0000000000000000000000000000000000000002",
    maxTimeoutSeconds: 300,
  },
  payload: { signature: "0xsig" },
  extensions: {
    "payment-identifier": { info: { id: PAYMENT_ID, required: false } },
  },
};

type Scenario =
  | "no-match"
  | "verify-fail"
  | "settle-throw"
  | "settle-ok"
  | "reservation-lost"
  | "storage-fail";

/**
 * Duck-typed Express request carrying the middleware reservation token.
 */
type TokenRequest = {
  x402ReservationToken?: string;
  method: string;
  path: string;
  originalUrl: string;
  protocol: string;
  headers: Record<string, string>;
  header: (name: string) => string | undefined;
  query: Record<string, string>;
  body: unknown;
};

/**
 * Build a request object with the ExpressAdapter field shape.
 *
 * @param url - Request URL
 * @param token - Optional reservation token
 * @returns Duck-typed Express request
 */
function tokenRequest(url: string, token?: string): TokenRequest {
  const parsed = new URL(url, "http://localhost:4022");
  const req: TokenRequest = {
    x402ReservationToken: token,
    method: "GET",
    path: parsed.pathname,
    originalUrl: `${parsed.pathname}${parsed.search}`,
    protocol: "http",
    headers: { host: "localhost:4022" },
    header: () => undefined,
    query: {},
    body: undefined,
  };
  return req;
}

/**
 * Instantiate the SDK ExpressAdapter, which stores the request on `req`.
 *
 * @param req - Duck-typed Express request
 * @returns ExpressAdapter instance
 */
const EXPRESS_ADAPTER_SOURCE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../typescript/packages/http/express/src/adapter.ts",
  ),
  "utf8",
);

/**
 * Runtime twin of SDK ExpressAdapter: constructor(private req: Request).
 */
class ExpressAdapter {
  /**
   * Store the request the same way the SDK adapter does.
   *
   * @param req - Duck-typed Express request
   */
  constructor(private req: TokenRequest) {}
}

/**
 * Instantiate the adapter shape the example middleware reads (`adapter.req`).
 *
 * @param req - Duck-typed Express request
 * @returns Adapter with `req`
 */
function createExpressAdapter(req: TokenRequest): { req: TokenRequest } {
  return new ExpressAdapter(req) as unknown as { req: TokenRequest };
}

/**
 * Read the SDK adapter token from a hook-shaped transport context.
 *
 * @param req - Duck-typed Express request
 * @returns Token from ExpressAdapter.req
 */
function tokenFromAdapter(req: TokenRequest): string | undefined {
  const adapter = createExpressAdapter(req);
  return reservationTokenFromTransportContext({
    request: { adapter, path: req.path, method: req.method },
  });
}

/**
 * Start a harnessed HTTP server using the same bind/hook helpers as the example.
 *
 * @returns Server, maps, and captured hook token
 */
function startHarness(): {
  server: http.Server;
  url: () => string;
  cache: Map<
    string,
    { timestamp: number; fingerprint: string; response: { report: { cached: boolean } } }
  >;
  reservations: Map<string, Reservation>;
  seen: {
    token?: string;
    phase?: string;
    aborted?: boolean;
    settled?: boolean;
    storageFailed?: boolean;
  };
} {
  const cache = new Map<
    string,
    { timestamp: number; fingerprint: string; response: { report: { cached: boolean } } }
  >();
  const reservations = new Map<string, Reservation>();
  const seen: {
    token?: string;
    phase?: string;
    aborted?: boolean;
    settled?: boolean;
    storageFailed?: boolean;
  } = {};

  const server = http.createServer((incoming, res) => {
    try {
      const host = incoming.headers.host || "localhost:4022";
      const url = `http://${host}${incoming.url || "/"}`;
      const parsed = new URL(url);
      const scenario = (incoming.headers["x-test-scenario"] as Scenario | undefined) || "no-match";
      const req = tokenRequest(url);
      const fingerprint = requestFingerprint({
        method: "GET",
        url,
        body: Buffer.alloc(0),
        payload: PAYLOAD,
      });

      if (incoming.headers["payment-signature"] || incoming.headers["x-payment"]) {
        if (isProtectedRoute("GET", parsed.pathname, PAID_ROUTES)) {
          let decision: ReturnType<typeof bindPaymentId>;
          try {
            if (scenario === "storage-fail") {
              throw new Error("injected storage failure");
            }
            decision = bindPaymentId({
              cache,
              reservations,
              paymentId: PAYMENT_ID,
              fingerprint,
              now: 0,
              cacheTtlMs: 3_600_000,
              reservationTtlMs: RESERVATION_TTL_MS,
            });
          } catch {
            seen.storageFailed = true;
            res.writeHead(503, {
              "content-type": "application/json",
              "retry-after": "1",
            });
            res.end(
              JSON.stringify({
                error: "payment identifier storage unavailable",
                retryable: true,
              }),
            );
            return;
          }
          if (decision.kind === "hit") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ report: { cached: true } }));
            return;
          }
          if (
            decision.kind === "conflict" ||
            decision.kind === "in_flight" ||
            decision.kind === "capacity"
          ) {
            res.writeHead(decision.statusCode, { "content-type": "application/json" });
            res.end(JSON.stringify({ kind: decision.kind }));
            return;
          }
          const reserved = reservations.get(PAYMENT_ID);
          if (reserved?.token) {
            req.x402ReservationToken = reserved.token;
            if (scenario === "reservation-lost") {
              reservations.set(PAYMENT_ID, {
                ...reserved,
                token: "replacement-token",
                state: "pending",
              });
            }
          }
        }
      }

      const adapterToken = tokenFromAdapter(req);
      seen.token = adapterToken;

      const finishPending = () => {
        if (!req.x402ReservationToken) {
          return;
        }
        releaseIfPending(
          reservations,
          PAYMENT_ID,
          fingerprint,
          2,
          RESERVATION_TTL_MS,
          req.x402ReservationToken,
        );
      };

      if (parsed.pathname !== "/weather") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (scenario === "verify-fail") {
        seen.phase = "verify-fail";
        if (adapterToken) {
          releaseIfPending(
            reservations,
            PAYMENT_ID,
            fingerprint,
            1,
            RESERVATION_TTL_MS,
            adapterToken,
          );
        }
        res.writeHead(402);
        res.end(JSON.stringify({ error: "verify" }));
        finishPending();
        return;
      }

      if (scenario === "settle-throw") {
        seen.phase = "before-settle";
        if (adapterToken) {
          markSettlementStarted(
            reservations,
            PAYMENT_ID,
            fingerprint,
            1,
            RESERVATION_TTL_MS,
            adapterToken,
          );
          markOutcomeUnknown(
            reservations,
            PAYMENT_ID,
            fingerprint,
            1,
            RESERVATION_TTL_MS,
            adapterToken,
          );
        }
        res.writeHead(402);
        res.end(JSON.stringify({ error: "settle-unknown" }));
        finishPending();
        return;
      }

      if (scenario === "settle-ok" || scenario === "reservation-lost") {
        seen.phase = "after-settle";
        if (adapterToken) {
          const started = markSettlementStarted(
            reservations,
            PAYMENT_ID,
            fingerprint,
            1,
            RESERVATION_TTL_MS,
            adapterToken,
          );
          if (!started) {
            seen.aborted = true;
            res.writeHead(409, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "payment_identifier_reservation_lost" }));
            return;
          }
          seen.settled = true;
          const consumed = consumeReservation(
            reservations,
            PAYMENT_ID,
            fingerprint,
            1,
            RESERVATION_TTL_MS,
            adapterToken,
          );
          if (consumed) {
            cache.set(PAYMENT_ID, {
              timestamp: 1,
              fingerprint: consumed,
              response: { report: { cached: false } },
            });
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ report: { cached: false } }));
        finishPending();
        return;
      }

      seen.phase = "no-match";
      res.writeHead(402);
      res.end(JSON.stringify({ error: "no matching requirement" }));
      finishPending();
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "handler" }));
    }
  });

  return {
    server,
    url: () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("server not listening");
      }
      return `http://127.0.0.1:${address.port}`;
    },
    cache,
    reservations,
    seen,
  };
}

/**
 * GET helper for the harnessed server.
 *
 * @param baseUrl - Server origin
 * @param path - Request path
 * @param scenario - Lifecycle scenario header
 * @returns Status and JSON body
 */
async function getJson(
  baseUrl: string,
  path: string,
  scenario?: Scenario,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const header = Buffer.from(JSON.stringify(PAYLOAD)).toString("base64");
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "payment-signature": header,
      ...(scenario ? { "x-test-scenario": scenario } : {}),
    },
    signal: AbortSignal.timeout(3000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("express adapter request lifecycle", () => {
  const harness = startHarness();
  before(async () => {
    await new Promise<void>(resolve => {
      harness.server.listen(0, "127.0.0.1", resolve);
    });
  });
  after(() => {
    harness.server.close();
  });

  it("SDK ExpressAdapter stores the request on req", () => {
    assert.match(EXPRESS_ADAPTER_SOURCE, /export class ExpressAdapter implements HTTPAdapter/);
    assert.match(EXPRESS_ADAPTER_SOURCE, /constructor\(private req: Request\)/);
  });

  it("carries the middleware token on ExpressAdapter.req into hook context", () => {
    const req = tokenRequest("http://localhost:4022/weather", "token-live");
    assert.equal(tokenFromAdapter(req), "token-live");
    const adapter = createExpressAdapter(req);
    assert.equal(
      (adapter as unknown as { req: TokenRequest }).req.x402ReservationToken,
      "token-live",
    );
  });

  it("does not reserve unprotected /health", async () => {
    const baseUrl = harness.url();
    const health = await getJson(baseUrl, "/health");
    assert.equal(health.status, 200);
    assert.equal(harness.reservations.size, 0);
    const weather = await getJson(baseUrl, "/weather", "settle-ok");
    assert.equal(weather.status, 200);
    assert.equal(harness.cache.has(PAYMENT_ID), true);
  });

  it("releases a pending reservation on pre-settlement rejection", async () => {
    harness.cache.clear();
    harness.reservations.clear();
    const result = await getJson(harness.url(), "/weather", "no-match");
    assert.equal(result.status, 402);
    assert.equal(harness.seen.phase, "no-match");
    assert.ok(harness.seen.token);
    assert.equal(harness.reservations.has(PAYMENT_ID), false);
  });

  it("propagates the token into settle hooks and retains outcome-unknown", async () => {
    harness.cache.clear();
    harness.reservations.clear();
    const result = await getJson(harness.url(), "/weather", "settle-throw");
    assert.equal(result.status, 402);
    assert.ok(harness.seen.token);
    assert.equal(harness.reservations.get(PAYMENT_ID)?.state, RESERVATION_STATE_UNKNOWN);
    assert.equal(harness.reservations.get(PAYMENT_ID)?.token, harness.seen.token);
    const retry = await getJson(harness.url(), "/weather", "settle-ok");
    assert.equal(retry.status, 503);
    assert.equal(harness.cache.has(PAYMENT_ID), false);
  });

  it("consumes on successful settle and serves a cache hit", async () => {
    harness.cache.clear();
    harness.reservations.clear();
    const result = await getJson(harness.url(), "/weather", "settle-ok");
    assert.equal(result.status, 200);
    assert.ok(harness.seen.token);
    assert.equal(harness.cache.has(PAYMENT_ID), true);
    assert.equal(harness.reservations.has(PAYMENT_ID), false);
    const hit = await getJson(harness.url(), "/weather", "settle-ok");
    assert.equal(hit.status, 200);
    assert.equal(hit.body.report && (hit.body.report as { cached: boolean }).cached, true);
  });

  it("cleans up on verify failure before settlement", async () => {
    harness.cache.clear();
    harness.reservations.clear();
    const result = await getJson(harness.url(), "/weather", "verify-fail");
    assert.equal(result.status, 402);
    assert.ok(harness.seen.token);
    assert.equal(harness.reservations.has(PAYMENT_ID), false);
  });

  it("ignores a stale-token settle callback after replacement", async () => {
    harness.cache.clear();
    harness.reservations.clear();
    const result = await getJson(harness.url(), "/weather", "settle-throw");
    assert.equal(result.status, 402);
    const original = harness.reservations.get(PAYMENT_ID);
    assert.ok(original);
    const staleToken = original.token;
    harness.reservations.set(PAYMENT_ID, {
      ...original,
      token: "token-replacement",
      state: "pending",
    });
    assert.equal(
      consumeReservation(
        harness.reservations,
        PAYMENT_ID,
        original.fingerprint,
        1,
        RESERVATION_TTL_MS,
        staleToken,
      ),
      undefined,
    );
    assert.equal(
      releaseIfPending(
        harness.reservations,
        PAYMENT_ID,
        original.fingerprint,
        1,
        RESERVATION_TTL_MS,
        staleToken,
      ),
      false,
    );
    assert.equal(harness.reservations.get(PAYMENT_ID)?.token, "token-replacement");
  });

  it("aborts before settlement when cleanup replaced the reservation token", async () => {
    harness.cache.clear();
    harness.reservations.clear();
    harness.seen.aborted = false;
    harness.seen.settled = false;
    const result = await getJson(harness.url(), "/weather", "reservation-lost");
    assert.equal(result.status, 409);
    assert.equal(harness.seen.aborted, true);
    assert.notEqual(harness.seen.settled, true);
    assert.equal(harness.cache.has(PAYMENT_ID), false);
    assert.equal(harness.reservations.get(PAYMENT_ID)?.token, "replacement-token");
  });

  it("fails closed before payment when identifier storage fails", async () => {
    harness.cache.clear();
    harness.reservations.clear();
    harness.seen.storageFailed = false;
    harness.seen.phase = undefined;
    harness.seen.settled = false;
    const result = await getJson(harness.url(), "/weather", "storage-fail");
    assert.equal(result.status, 503);
    assert.equal(result.body.retryable, true);
    assert.equal(harness.seen.storageFailed, true);
    assert.equal(harness.seen.phase, undefined);
    assert.notEqual(harness.seen.settled, true);
    assert.equal(harness.cache.size, 0);
    assert.equal(harness.reservations.size, 0);
  });
});
