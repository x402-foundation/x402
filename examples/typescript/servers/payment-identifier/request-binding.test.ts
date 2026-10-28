import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CAPACITY_MESSAGE,
  CONFLICT_STATUS_CODE,
  FALLBACK_RESERVATION_TTL_MS,
  MAX_PENDING_RESERVATIONS,
  RESERVATION_STATE_PENDING,
  RESERVATION_STATE_SETTLING,
  RESERVATION_STATE_UNKNOWN,
  RESERVATION_TTL_MS,
  RETRYABLE_STATUS_CODE,
  bindPaymentId,
  canonicalAcceptedExtra,
  canonicalMaxTimeoutSeconds,
  canonicalRequestUrl,
  cleanupExpiredReservations,
  consumeReservation,
  isProtectedRoute,
  lookup,
  markOutcomeUnknown,
  markSettlementStarted,
  releaseIfPending,
  releaseReservation,
  requestFingerprint,
  reservationTtlMs,
  tryReserve,
  type PaymentTermsSource,
  type Reservation,
} from "./request-binding.ts";

const PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa";
const TTL_MS = 3600_000;
const NOW = 1_000_000;
const WEATHER = "http://localhost:4022/weather";
const FORECAST = "http://localhost:4022/forecast";
const CANONICAL_SAME_REQUEST_FINGERPRINT =
  "3be3051236cf413f1cb88528fa8d9a7f22de774366f31fa7f319b972e943cc3f";
const CANONICAL_EXTRA_FINGERPRINT =
  "0565bb0ee3d8210ff27002b3c8e0748a570362835e1ef44186e1d4c967f2cf8c";
const PAID_ROUTES = { "GET /weather": {} };
const QUERY_FIXTURES = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../shared/payment-identifier-query-fixtures.json",
    ),
    "utf8",
  ),
) as Array<{ name: string; url: string; canonical: string }>;

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
  input: {
    method?: string;
    url?: string;
    body?: Buffer | string;
    payload?: PaymentTermsSource;
  } = {},
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

const stored = (fingerprint: string, overrides: Partial<Reservation> = {}): Reservation => ({
  fingerprint,
  timestamp: NOW,
  token: "token-a",
  ttlMs: RESERVATION_TTL_MS,
  state: RESERVATION_STATE_PENDING,
  ...overrides,
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

  it("returns 409 and does not grant access on credential drift", () => {
    const other = { ...PAYLOAD, payload: { signature: "0xforged" } };
    const decision = lookup(cached(fp()), fp({ payload: other }), NOW + 1, TTL_MS);
    assert.equal(decision.statusCode, 409);
    assert.equal(decision.grantAccess, false);
    assert.notEqual(fp(), fp({ payload: other }));
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
    assert.equal(second.statusCode, RETRYABLE_STATUS_CODE);
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
    assert.equal(second.statusCode, CONFLICT_STATUS_CODE);
    assert.equal(second.grantAccess, false);
  });

  it("does not overwrite a live reservation", () => {
    const reservations = new Map<string, Reservation>();
    const firstFp = fp({ url: WEATHER });
    const secondFp = fp({ url: FORECAST });
    tryReserve(reservations, PAYMENT_ID, firstFp, NOW, RESERVATION_TTL_MS);
    const token = reservations.get(PAYMENT_ID)?.token;
    tryReserve(reservations, PAYMENT_ID, secondFp, NOW + 1, RESERVATION_TTL_MS);
    assert.equal(reservations.get(PAYMENT_ID)?.fingerprint, firstFp);
    assert.equal(
      consumeReservation(reservations, PAYMENT_ID, firstFp, NOW + 2, RESERVATION_TTL_MS, token),
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
      fp(),
      NOW,
      RESERVATION_TTL_MS,
      "token-a",
    );
    assert.equal(fingerprint, undefined);
  });

  it("accepts an expired exact current-token settlement callback when not replaced", () => {
    const reservations = new Map<string, Reservation>([[PAYMENT_ID, stored(fp())]]);
    const fingerprint = consumeReservation(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + RESERVATION_TTL_MS,
      RESERVATION_TTL_MS,
      "token-a",
    );
    assert.equal(fingerprint, fp());
    assert.equal(reservations.has(PAYMENT_ID), false);
  });

  it("hits on an identical retry after completed settlement", () => {
    const cache = new Map<string, { timestamp: number; fingerprint?: string }>();
    const reservations = new Map<string, Reservation>();
    const first = bind(cache, reservations, fp());
    assert.equal(first.kind, "miss");
    const token = reservations.get(PAYMENT_ID)?.token;
    const storedFp = consumeReservation(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + 2,
      RESERVATION_TTL_MS,
      token,
    );
    assert.equal(storedFp, fp());
    cache.set(PAYMENT_ID, {
      timestamp: NOW + 2,
      fingerprint: storedFp,
    });
    const leftover = stored(fp({ url: FORECAST }), { timestamp: NOW + 2, token: "token-b" });
    reservations.set(PAYMENT_ID, leftover);
    const retry = bind(cache, reservations, fp(), NOW + 3);
    assert.equal(retry.kind, "hit");
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.grantAccess, true);
    assert.deepEqual(reservations.get(PAYMENT_ID), leftover);
  });
});

describe("protected paid routes", () => {
  it("protects GET /weather and ignores query", () => {
    assert.equal(isProtectedRoute("GET", WEATHER, PAID_ROUTES), true);
    assert.equal(isProtectedRoute("GET", "/weather?city=nyc", PAID_ROUTES), true);
  });

  it("does not reserve /health or an unmatched path", () => {
    assert.equal(isProtectedRoute("GET", "http://localhost:4022/health", PAID_ROUTES), false);
    assert.equal(isProtectedRoute("GET", "/not-a-paid-route", PAID_ROUTES), false);
  });

  it("does not let an unprotected header block the paid route", () => {
    const cache = new Map<string, { timestamp: number; fingerprint?: string }>();
    const reservations = new Map<string, Reservation>();
    assert.equal(isProtectedRoute("GET", "http://localhost:4022/health", PAID_ROUTES), false);
    assert.equal(reservations.has(PAYMENT_ID), false);
    const weather = bind(cache, reservations, fp());
    assert.equal(weather.kind, "miss");
    assert.equal(reservations.get(PAYMENT_ID)?.fingerprint, fp());
  });
});

describe("reservation release and matching consume", () => {
  it("releases the matching reservation immediately on verify failure", () => {
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    const token = reservations.get(PAYMENT_ID)?.token;
    const released = releaseReservation(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + 1,
      RESERVATION_TTL_MS,
      token,
    );
    assert.equal(released, true);
    assert.equal(reservations.has(PAYMENT_ID), false);
    const retry = tryReserve(reservations, PAYMENT_ID, fp(), NOW + 2, RESERVATION_TTL_MS);
    assert.equal(retry.kind, "miss");
  });

  it("does not drop a replacement from a stale failure callback", () => {
    const replacement = stored(fp({ url: FORECAST }), {
      timestamp: NOW + 1,
      token: "token-b",
    });
    const reservations = new Map<string, Reservation>([[PAYMENT_ID, replacement]]);
    const dropped = releaseReservation(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + 2,
      RESERVATION_TTL_MS,
      "token-a",
    );
    assert.equal(dropped, false);
    assert.deepEqual(reservations.get(PAYMENT_ID), replacement);
  });

  it("does not consume a replacement from a stale settle callback", () => {
    const replacementFp = fp({ url: FORECAST });
    const reservations = new Map<string, Reservation>([
      [PAYMENT_ID, stored(replacementFp, { timestamp: NOW + 1, token: "token-b" })],
    ]);
    const stolen = consumeReservation(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + 2,
      RESERVATION_TTL_MS,
      "token-a",
    );
    assert.equal(stolen, undefined);
    assert.equal(reservations.get(PAYMENT_ID)?.fingerprint, replacementFp);
  });

  it("does not cache a replacement after the original reservation expires", () => {
    const replacement = stored(fp({ url: FORECAST }), {
      timestamp: NOW + RESERVATION_TTL_MS,
      token: "token-b",
    });
    const reservations = new Map<string, Reservation>([[PAYMENT_ID, replacement]]);
    const cachedFp = consumeReservation(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + RESERVATION_TTL_MS + 1,
      RESERVATION_TTL_MS,
      "token-a",
    );
    assert.equal(cachedFp, undefined);
    assert.deepEqual(reservations.get(PAYMENT_ID), replacement);
  });

  it("requires the matching token for a same-fingerprint replacement", () => {
    const reservations = new Map<string, Reservation>([
      [PAYMENT_ID, stored(fp(), { timestamp: NOW + RESERVATION_TTL_MS, token: "token-b" })],
    ]);
    const stolen = consumeReservation(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + RESERVATION_TTL_MS + 1,
      RESERVATION_TTL_MS,
      "token-a",
    );
    assert.equal(stolen, undefined);
    assert.equal(reservations.has(PAYMENT_ID), true);
  });
});

describe("reservation ttl is server policy", () => {
  it("ignores a tiny client maxTimeoutSeconds when choosing map TTL", () => {
    const payload = { ...PAYLOAD, accepted: { ...PAYLOAD.accepted, maxTimeoutSeconds: 1 } };
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp({ payload }), NOW, reservationTtlMs());
    const blocked = tryReserve(
      reservations,
      PAYMENT_ID,
      fp({ payload }),
      NOW + 2_000,
      reservationTtlMs(),
    );
    assert.equal(blocked.kind, "in_flight");
    assert.equal(reservationTtlMs(), RESERVATION_TTL_MS);
    assert.equal(FALLBACK_RESERVATION_TTL_MS, 300_000);
  });

  it("ignores a huge client maxTimeoutSeconds when choosing map TTL", () => {
    const payload = { ...PAYLOAD, accepted: { ...PAYLOAD.accepted, maxTimeoutSeconds: 1_000_000 } };
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp({ payload }), NOW, reservationTtlMs());
    const removed = cleanupExpiredReservations(
      reservations,
      NOW + RESERVATION_TTL_MS,
      reservationTtlMs(),
    );
    assert.equal(removed, 1);
    assert.equal(reservations.has(PAYMENT_ID), false);
  });

  it("expires only after the server-owned 300s TTL", () => {
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    assert.equal(
      cleanupExpiredReservations(reservations, NOW + RESERVATION_TTL_MS - 1, RESERVATION_TTL_MS),
      0,
    );
    assert.equal(
      cleanupExpiredReservations(reservations, NOW + RESERVATION_TTL_MS, RESERVATION_TTL_MS),
      1,
    );
  });
});

describe("reservation capacity", () => {
  it("fails closed at 1024 live entries without overwriting", () => {
    const reservations = new Map<string, Reservation>();
    for (let index = 0; index < MAX_PENDING_RESERVATIONS; index += 1) {
      const decision = tryReserve(
        reservations,
        `pay_${index.toString().padStart(4, "0")}`,
        fp(),
        NOW,
        RESERVATION_TTL_MS,
      );
      assert.equal(decision.kind, "miss");
    }
    assert.equal(reservations.size, MAX_PENDING_RESERVATIONS);
    const overflow = tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    assert.equal(overflow.kind, "capacity");
    assert.equal(overflow.statusCode, RETRYABLE_STATUS_CODE);
    assert.equal(overflow.grantAccess, false);
    assert.equal(reservations.size, MAX_PENDING_RESERVATIONS);
    assert.equal(reservations.has(PAYMENT_ID), false);
    assert.equal(CAPACITY_MESSAGE.length > 0, true);
  });

  it("accepts a new reservation after expired cleanup below capacity", () => {
    const reservations = new Map<string, Reservation>();
    for (let index = 0; index < MAX_PENDING_RESERVATIONS; index += 1) {
      tryReserve(
        reservations,
        `pay_${index.toString().padStart(4, "0")}`,
        fp(),
        NOW,
        RESERVATION_TTL_MS,
      );
    }
    const retry = tryReserve(
      reservations,
      PAYMENT_ID,
      fp(),
      NOW + RESERVATION_TTL_MS,
      RESERVATION_TTL_MS,
    );
    assert.equal(retry.kind, "miss");
    assert.equal(reservations.has(PAYMENT_ID), true);
  });
});

describe("pre-settlement cleanup and outcome-unknown retention", () => {
  it("releases a pending reservation before settlement begins", () => {
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    const token = reservations.get(PAYMENT_ID)?.token;
    assert.equal(
      releaseIfPending(reservations, PAYMENT_ID, fp(), NOW + 1, RESERVATION_TTL_MS, token),
      true,
    );
    assert.equal(reservations.has(PAYMENT_ID), false);
  });

  it("retains an outcome-unknown tombstone and rejects a fresh credential", () => {
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    const token = reservations.get(PAYMENT_ID)?.token;
    assert.equal(
      markSettlementStarted(reservations, PAYMENT_ID, fp(), NOW + 1, RESERVATION_TTL_MS, token),
      true,
    );
    assert.equal(reservations.get(PAYMENT_ID)?.state, RESERVATION_STATE_SETTLING);
    assert.equal(
      markOutcomeUnknown(reservations, PAYMENT_ID, fp(), NOW + 2, RESERVATION_TTL_MS, token),
      true,
    );
    assert.equal(reservations.get(PAYMENT_ID)?.state, RESERVATION_STATE_UNKNOWN);
    assert.equal(
      releaseIfPending(reservations, PAYMENT_ID, fp(), NOW + 3, RESERVATION_TTL_MS, token),
      false,
    );
    assert.equal(
      consumeReservation(reservations, PAYMENT_ID, fp(), NOW + 3, RESERVATION_TTL_MS, token),
      undefined,
    );
    const other = fp({ payload: { ...PAYLOAD, payload: { signature: "0xforged" } } });
    const fresh = tryReserve(reservations, PAYMENT_ID, other, NOW + 4, RESERVATION_TTL_MS);
    assert.equal(fresh.kind, "conflict");
    assert.equal(reservations.get(PAYMENT_ID)?.state, RESERVATION_STATE_UNKNOWN);
    const same = tryReserve(reservations, PAYMENT_ID, fp(), NOW + 5, RESERVATION_TTL_MS);
    assert.equal(same.kind, "in_flight");
  });

  it("lets an exact current token enter settlement after its prior deadline", () => {
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    const token = reservations.get(PAYMENT_ID)?.token;
    const settlementStarted = NOW + RESERVATION_TTL_MS + 1;
    assert.equal(
      markSettlementStarted(
        reservations,
        PAYMENT_ID,
        fp(),
        settlementStarted,
        RESERVATION_TTL_MS,
        token,
      ),
      true,
    );
    assert.equal(reservations.get(PAYMENT_ID)?.timestamp, settlementStarted);
    assert.equal(
      consumeReservation(
        reservations,
        PAYMENT_ID,
        fp(),
        settlementStarted + RESERVATION_TTL_MS + 1,
        RESERVATION_TTL_MS,
        token,
      ),
      fp(),
    );
    assert.equal(reservations.has(PAYMENT_ID), false);
  });

  it("refreshes a full outcome-unknown window after the original deadline", () => {
    const reservations = new Map<string, Reservation>();
    tryReserve(reservations, PAYMENT_ID, fp(), NOW, RESERVATION_TTL_MS);
    const token = reservations.get(PAYMENT_ID)?.token;
    const settlementStarted = NOW + RESERVATION_TTL_MS - 1;
    const outcomeUnknown = settlementStarted + RESERVATION_TTL_MS + 1;
    assert.equal(
      markSettlementStarted(
        reservations,
        PAYMENT_ID,
        fp(),
        settlementStarted,
        RESERVATION_TTL_MS,
        token,
      ),
      true,
    );
    assert.equal(
      markOutcomeUnknown(reservations, PAYMENT_ID, fp(), outcomeUnknown, RESERVATION_TTL_MS, token),
      true,
    );
    assert.equal(reservations.get(PAYMENT_ID)?.timestamp, outcomeUnknown);
    const other = fp({ payload: { ...PAYLOAD, payload: { signature: "0xforged" } } });
    assert.equal(
      tryReserve(
        reservations,
        PAYMENT_ID,
        other,
        outcomeUnknown + RESERVATION_TTL_MS - 1,
        RESERVATION_TTL_MS,
      ).kind,
      "conflict",
    );
  });

  it("does not mark unknown or consume with a missing or wrong token", () => {
    const reservations = new Map<string, Reservation>([
      [PAYMENT_ID, stored(fp(), { token: "token-b" })],
    ]);
    assert.equal(
      markOutcomeUnknown(reservations, PAYMENT_ID, fp(), NOW + 1, RESERVATION_TTL_MS),
      false,
    );
    assert.equal(
      markOutcomeUnknown(reservations, PAYMENT_ID, fp(), NOW + 1, RESERVATION_TTL_MS, "token-a"),
      false,
    );
    assert.equal(
      markSettlementStarted(reservations, PAYMENT_ID, fp(), NOW + 1, RESERVATION_TTL_MS, "token-a"),
      false,
    );
    assert.equal(
      consumeReservation(reservations, PAYMENT_ID, fp(), NOW + 1, RESERVATION_TTL_MS),
      undefined,
    );
    assert.equal(reservations.get(PAYMENT_ID)?.token, "token-b");
    assert.equal(reservations.get(PAYMENT_ID)?.state, RESERVATION_STATE_PENDING);
    assert.equal(reservations.get(PAYMENT_ID)?.timestamp, NOW);
  });
});

describe("accepted terms fingerprint", () => {
  it("changes when maxTimeoutSeconds mutates", () => {
    const other = { ...PAYLOAD, accepted: { ...PAYLOAD.accepted, maxTimeoutSeconds: 60 } };
    assert.notEqual(fp(), fp({ payload: other }));
    assert.equal(canonicalMaxTimeoutSeconds(PAYLOAD.accepted), "");
    assert.equal(canonicalMaxTimeoutSeconds(other.accepted), "60");
  });

  it("changes when accepted.extra mutates and ignores extra key order", () => {
    const extraA = {
      ...PAYLOAD,
      accepted: { ...PAYLOAD.accepted, extra: { z: 1, a: { b: 2 } } },
    };
    const extraB = {
      ...PAYLOAD,
      accepted: { ...PAYLOAD.accepted, extra: { a: { b: 2 }, z: 1 } },
    };
    const extraC = {
      ...PAYLOAD,
      accepted: { ...PAYLOAD.accepted, extra: { z: 1, a: { b: 3 } } },
    };
    assert.equal(fp({ payload: extraA }), fp({ payload: extraB }));
    assert.notEqual(fp({ payload: extraA }), fp({ payload: extraC }));
    assert.equal(canonicalAcceptedExtra(extraA.accepted), '{"a":{"b":2},"z":1}');
  });
});

describe("canonical query encoding", () => {
  for (const fixture of QUERY_FIXTURES) {
    it(`encodes ${fixture.name}`, () => {
      assert.equal(canonicalRequestUrl(fixture.url), fixture.canonical);
    });
  }
});

describe("cross-language canonical fixture", () => {
  it("matches the Python same-request fingerprint", () => {
    assert.equal(fp({ url: `${WEATHER}?b=2&a=1` }), CANONICAL_SAME_REQUEST_FINGERPRINT);
    assert.equal(fp({ url: `${WEATHER}?a=1&b=2` }), CANONICAL_SAME_REQUEST_FINGERPRINT);
  });

  it("matches the Python extra fingerprint", () => {
    const extra = {
      ...PAYLOAD,
      accepted: { ...PAYLOAD.accepted, extra: { z: 1, a: { b: 2 } } },
    };
    assert.equal(fp({ payload: extra }), CANONICAL_EXTRA_FINGERPRINT);
  });
});
