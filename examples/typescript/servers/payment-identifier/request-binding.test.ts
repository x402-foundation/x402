import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESERVATION_TTL_MS,
  bindPaymentId,
  cleanupExpiredReservations,
  consumeReservation,
  lookup,
  requestFingerprint,
  tryReserve,
  type Reservation,
} from "./request-binding.ts";

const PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa";
const TTL_MS = 3600_000;
const NOW = 1_000_000;
const WEATHER = "http://localhost:4022/weather";
const FORECAST = "http://localhost:4022/forecast";

const PAYLOAD = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x0000000000000000000000000000000000000001",
    amount: "1000",
    payTo: "0x0000000000000000000000000000000000000002",
  },
  payload: { signature: "0xsig" },
  extensions: {
    "payment-identifier": { info: { id: PAYMENT_ID, required: false } },
  },
};

const fp = (
  input: { method?: string; url?: string; body?: Buffer | string; payload?: typeof PAYLOAD } = {},
) =>
  requestFingerprint({
    method: input.method ?? "GET",
    url: input.url ?? WEATHER,
    body: input.body ?? Buffer.alloc(0),
    payload: input.payload ?? PAYLOAD,
  });

const cached = (fingerprint: string) => ({
  timestamp: NOW,
  fingerprint,
  response: { report: { weather: "sunny" } },
});

const bind = (
  cache: Map<string, { timestamp: number; fingerprint?: string }>,
  reservations: Map<string, Reservation>,
  fingerprint: string,
  now = NOW + 1,
) =>
  bindPaymentId({
    cache,
    reservations,
    paymentId: PAYMENT_ID,
    fingerprint,
    now,
    cacheTtlMs: TTL_MS,
    reservationTtlMs: RESERVATION_TTL_MS,
  });

describe("request-bound payment identifier", () => {
  it("hits on an identical retry", () => {
    const decision = lookup(cached(fp()), fp(), NOW + 1, TTL_MS);
    assert.equal(decision.kind, "hit");
    assert.equal(decision.statusCode, 200);
    assert.equal(decision.grantAccess, true);
  });

  it("returns 409 and does not grant access on method drift", () => {
    const decision = lookup(cached(fp({ method: "GET" })), fp({ method: "POST" }), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on path drift", () => {
    const decision = lookup(cached(fp({ url: WEATHER })), fp({ url: FORECAST }), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on body drift", () => {
    const decision = lookup(
      cached(fp({ body: Buffer.alloc(0) })),
      fp({ body: '{"city":"nyc"}' }),
      NOW + 1,
      TTL_MS,
    );
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on query drift", () => {
    const decision = lookup(
      cached(fp({ url: WEATHER })),
      fp({ url: `${WEATHER}?city=nyc` }),
      NOW + 1,
      TTL_MS,
    );
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("returns 409 and does not grant access on terms drift", () => {
    const other = { ...PAYLOAD, accepted: { ...PAYLOAD.accepted, amount: "999999" } };
    const decision = lookup(cached(fp()), fp({ payload: other }), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("treats a missing stored fingerprint as conflict", () => {
    const decision = lookup({ timestamp: NOW, response: {} }, fp(), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
  });

  it("misses an unknown payment ID", () => {
    const decision = lookup(undefined, fp(), NOW, TTL_MS);
    assert.equal(decision.kind, "miss");
    assert.equal(decision.grantAccess, false);
  });

  it("canonicalizes query parameter order", () => {
    assert.equal(fp({ url: `${WEATHER}?b=2&a=1` }), fp({ url: `${WEATHER}?a=1&b=2` }));
  });

  it("preserves duplicate query key order", () => {
    assert.notEqual(fp({ url: `${WEATHER}?a=1&a=2` }), fp({ url: `${WEATHER}?a=2&a=1` }));
  });
});

describe("in-flight payment identifier reservation", () => {
  it("returns in-flight conflict for the same ID and same request", () => {
    const cache = new Map<string, { timestamp: number; fingerprint?: string }>();
    const reservations = new Map<string, Reservation>();
    const first = bind(cache, reservations, fp());
    const second = bind(cache, reservations, fp());
    assert.equal(first.kind, "miss");
    assert.equal(second.kind, "in_flight");
    assert.equal(second.statusCode, 409);
    assert.equal(second.grantAccess, false);
    assert.equal(reservations.get(PAYMENT_ID)?.fingerprint, fp());
  });

  it("returns request conflict for the same ID and a different request", () => {
    const cache = new Map<string, { timestamp: number; fingerprint?: string }>();
    const reservations = new Map<string, Reservation>();
    const first = bind(cache, reservations, fp({ url: WEATHER }));
    const second = bind(cache, reservations, fp({ url: FORECAST }));
    assert.equal(first.kind, "miss");
    assert.equal(second.kind, "conflict");
    assert.equal(second.statusCode, 409);
    assert.equal(second.grantAccess, false);
  });

  it("does not overwrite a live reservation", () => {
    const reservations = new Map<string, Reservation>();
    const firstFp = fp({ url: WEATHER });
    const secondFp = fp({ url: FORECAST });
    tryReserve(reservations, PAYMENT_ID, firstFp, NOW, RESERVATION_TTL_MS);
    tryReserve(reservations, PAYMENT_ID, secondFp, NOW + 1, RESERVATION_TTL_MS);
    assert.equal(reservations.get(PAYMENT_ID)?.fingerprint, firstFp);
    assert.equal(
      consumeReservation(reservations, PAYMENT_ID, NOW + 2, RESERVATION_TTL_MS),
      firstFp,
    );
  });

  it("expires a failed-payment reservation so the ID can proceed again", () => {
    const reservations = new Map<string, Reservation>();
    const first = tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    assert.equal(first.kind, "miss");
    const blocked = tryReserve(reservations, PAYMENT_ID, fp(), NOW + 1, RESERVATION_TTL_MS);
    assert.equal(blocked.kind, "in_flight");
    const removed = cleanupExpiredReservations(
      reservations,
      NOW + RESERVATION_TTL_MS,
      RESERVATION_TTL_MS,
    );
    assert.equal(removed, 1);
    assert.equal(reservations.has(PAYMENT_ID), false);
    const retry = tryReserve(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + RESERVATION_TTL_MS,
      RESERVATION_TTL_MS,
    );
    assert.equal(retry.kind, "miss");
    assert.equal(retry.grantAccess, false);
  });

  it("does not cache when the reservation is missing at settle", () => {
    const fingerprint = consumeReservation(
      new Map<string, Reservation>(),
      PAYMENT_ID,
      NOW,
      RESERVATION_TTL_MS,
    );
    assert.equal(fingerprint, undefined);
  });

  it("does not cache when the reservation is expired at settle", () => {
    const reservations = new Map<string, Reservation>([
      [PAYMENT_ID, { fingerprint: fp(), timestamp: NOW }],
    ]);
    const fingerprint = consumeReservation(
      reservations,
      PAYMENT_ID,
      NOW + RESERVATION_TTL_MS,
      RESERVATION_TTL_MS,
    );
    assert.equal(fingerprint, undefined);
    assert.equal(reservations.has(PAYMENT_ID), false);
  });

  it("hits on an identical retry after completed settlement", () => {
    const cache = new Map<string, { timestamp: number; fingerprint?: string }>();
    const reservations = new Map<string, Reservation>();
    const first = bind(cache, reservations, fp());
    assert.equal(first.kind, "miss");
    const stored = consumeReservation(reservations, PAYMENT_ID, NOW + 2, RESERVATION_TTL_MS);
    assert.equal(stored, fp());
    cache.set(PAYMENT_ID, {
      timestamp: NOW + 2,
      fingerprint: stored,
    });
    const leftover: Reservation = { fingerprint: fp({ url: FORECAST }), timestamp: NOW + 2 };
    reservations.set(PAYMENT_ID, leftover);
    const retry = bind(cache, reservations, fp(), NOW + 3);
    assert.equal(retry.kind, "hit");
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.grantAccess, true);
    assert.deepEqual(reservations.get(PAYMENT_ID), leftover);
  });
});
