import { config } from "dotenv";
import express from "express";
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  HTTPFacilitatorClient,
  type HTTPTransportContext,
  type SettleFailureContext,
  type SettleResultContext,
  type VerifiedPaymentCanceledContext,
  type VerifyFailureContext,
  type VerifyResultContext,
} from "@x402/core/server";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";
import {
  CAPACITY_MESSAGE,
  CONFLICT_MESSAGE,
  IN_FLIGHT_MESSAGE,
  RESERVATION_TTL_MS,
  RETRY_AFTER_SECONDS,
  RETRYABLE_STATUS_CODE,
  bindPaymentId,
  cleanupExpiredReservations,
  consumeReservation,
  isProtectedRoute,
  markOutcomeUnknown,
  markSettlementStarted,
  releaseIfPending,
  releaseReservation,
  requestFingerprint,
  reservationTokenFromTransportContext,
  type PaymentTermsSource,
  type Reservation,
} from "./request-binding.js";
config();

const address = process.env.ADDRESS as `0x${string}`;
if (!address) {
  console.error("❌ ADDRESS environment variable is required");
  process.exit(1);
}

// Use default x402.org facilitator
const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });

/**
 * Simple in-memory cache for idempotency.
 * In production, use Redis or another distributed cache.
 */
interface CachedResponse {
  timestamp: number;
  fingerprint: string;
  response: { report: { weather: string; temperature: number; cached: boolean } };
}

const idempotencyCache = new Map<string, CachedResponse>();
const pendingReservations = new Map<string, Reservation>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type ReservationRequest = express.Request & { x402ReservationToken?: string };

/**
 * HTTP method and URL from an SDK hook transport context.
 *
 * @param ctx - Hook context with optional transport
 * @param ctx.transportContext - SDK HTTP transport context
 * @returns Method and URL strings
 */
function hookHttpIdentity(ctx: { transportContext?: unknown }): { method: string; url: string } {
  const transport = ctx.transportContext as HTTPTransportContext | undefined;
  const request = transport?.request;
  const adapter = request?.adapter;
  const method = request?.method || adapter?.getMethod() || "";
  const url = adapter?.getUrl() || request?.path || "";
  return { method, url };
}

/**
 * Reservation token stashed on the Express request by idempotency middleware.
 *
 * @param ctx - Hook context with optional transport
 * @param ctx.transportContext - SDK HTTP transport context
 * @returns Token from ExpressAdapter.req, if present
 */
function hookReservationToken(ctx: { transportContext?: unknown }): string | undefined {
  return reservationTokenFromTransportContext(ctx.transportContext);
}

/**
 * Request+credential fingerprint from hook HTTP identity and payload.
 *
 * @param ctx - Hook context with payment payload
 * @param ctx.paymentPayload - Payment payload from the SDK hook
 * @param ctx.transportContext - SDK HTTP transport context
 * @returns SHA-256 hex digest
 */
function hookFingerprint(ctx: { paymentPayload: unknown; transportContext?: unknown }): string {
  const { method, url } = hookHttpIdentity(ctx);
  return requestFingerprint({
    method,
    url,
    body: Buffer.alloc(0),
    payload: ctx.paymentPayload as PaymentTermsSource,
  });
}

/**
 * Cleans up expired cache and in-flight reservation entries.
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, value] of idempotencyCache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
  cleanupExpiredReservations(pendingReservations, now, RESERVATION_TTL_MS);
}

/**
 * Raw request body bytes used in the HTTP fingerprint.
 *
 * This example is GET-only and does not install Express body-parsing middleware,
 * so the fingerprint hashes empty bytes. It does not capture arbitrary POST bodies.
 *
 * @param req - Express request
 * @returns Raw body buffer
 */
function requestBodyBytes(req: express.Request): Buffer {
  const ext = req as express.Request & { rawBody?: Buffer };
  if (Buffer.isBuffer(ext.rawBody)) {
    return ext.rawBody;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }
  return Buffer.alloc(0);
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredEntries, 5 * 60 * 1000);

// Route configuration with payment-identifier extension advertised
const routes = {
  "GET /weather": {
    accepts: [
      {
        scheme: "exact",
        price: "$0.001",
        network: "eip155:84532",
        payTo: address,
      },
    ],
    description: "Weather data with idempotency support",
    mimeType: "application/json",
    // Advertise payment-identifier extension support (required: false means optional)
    extensions: {
      [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false),
    },
  },
};

/**
 * Release a pending reservation owned by this hook context.
 *
 * @param ctx - Verify/cancel hook context
 * @param ctx.paymentPayload - Payment payload from the SDK hook
 * @param ctx.transportContext - SDK HTTP transport context
 */
function releasePendingFromHook(ctx: {
  paymentPayload: unknown;
  transportContext?: unknown;
}): void {
  const paymentId = extractPaymentIdentifier(
    ctx.paymentPayload as Parameters<typeof extractPaymentIdentifier>[0],
  );
  if (!paymentId) {
    return;
  }
  releaseIfPending(
    pendingReservations,
    paymentId,
    hookFingerprint(ctx),
    Date.now(),
    RESERVATION_TTL_MS,
    hookReservationToken(ctx),
  );
}

// Create the resource server with payment scheme support
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .onBeforeSettle(async ctx => {
    const paymentId = extractPaymentIdentifier(ctx.paymentPayload);
    if (!paymentId) {
      return;
    }
    const started = markSettlementStarted(
      pendingReservations,
      paymentId,
      hookFingerprint(ctx),
      Date.now(),
      RESERVATION_TTL_MS,
      hookReservationToken(ctx),
    );
    if (!started) {
      return { abort: true, reason: "payment_identifier_reservation_lost" };
    }
  })
  // Hook after settlement to cache only this request's matching reservation.
  .onAfterSettle(async (ctx: SettleResultContext) => {
    if (!ctx.result.success) {
      const paymentId = extractPaymentIdentifier(ctx.paymentPayload);
      if (!paymentId) {
        return;
      }
      releaseReservation(
        pendingReservations,
        paymentId,
        hookFingerprint(ctx),
        Date.now(),
        RESERVATION_TTL_MS,
        hookReservationToken(ctx),
      );
      return;
    }
    const paymentId = extractPaymentIdentifier(ctx.paymentPayload);
    if (!paymentId) {
      return;
    }
    const fingerprint = consumeReservation(
      pendingReservations,
      paymentId,
      hookFingerprint(ctx),
      Date.now(),
      RESERVATION_TTL_MS,
      hookReservationToken(ctx),
    );
    if (!fingerprint) {
      return;
    }
    console.log(`[Idempotency] Caching response for payment ID: ${paymentId}`);
    idempotencyCache.set(paymentId, {
      timestamp: Date.now(),
      fingerprint,
      response: {
        report: {
          weather: "sunny",
          temperature: 70,
          cached: false,
        },
      },
    });
  })
  .onVerifyFailure(async (ctx: VerifyFailureContext) => {
    releasePendingFromHook(ctx);
  })
  .onAfterVerify(async (ctx: VerifyResultContext) => {
    if (!ctx.result.isValid) {
      releasePendingFromHook(ctx);
    }
  })
  .onSettleFailure(async (ctx: SettleFailureContext) => {
    const paymentId = extractPaymentIdentifier(ctx.paymentPayload);
    if (!paymentId) {
      return;
    }
    markOutcomeUnknown(
      pendingReservations,
      paymentId,
      hookFingerprint(ctx),
      Date.now(),
      RESERVATION_TTL_MS,
      hookReservationToken(ctx),
    );
  })
  .onVerifiedPaymentCanceled(async (ctx: VerifiedPaymentCanceledContext) => {
    releasePendingFromHook(ctx);
  });

const httpServer = new x402HTTPResourceServer(resourceServer, routes);

const app = express();

// Run before payment middleware so a fingerprint mismatch returns 409
// without grantAccess and without payment verification.
app.use((req, res, next) => {
  const failClosed = () => {
    res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    res.status(RETRYABLE_STATUS_CODE).json({
      error: "payment identifier storage unavailable",
      retryable: true,
    });
  };

  const paymentHeader = req.header("payment-signature") || req.header("x-payment");
  if (!paymentHeader) {
    next();
    return;
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  } catch {
    // Only malformed header decoding may continue to normal payment handling.
    next();
    return;
  }
  const paymentId = extractPaymentIdentifier(paymentPayload);
  if (!paymentId) {
    next();
    return;
  }
  if (!isProtectedRoute(req.method, req.path || req.url, routes)) {
    next();
    return;
  }

  let fingerprint: string;
  let decision: ReturnType<typeof bindPaymentId>;
  let cached: CachedResponse | undefined;
  let reserved: Reservation | undefined;
  try {
    cleanupExpiredEntries();
    console.log(`[Idempotency] Checking payment ID: ${paymentId}`);
    fingerprint = requestFingerprint({
      method: req.method,
      url: req.originalUrl || req.url,
      body: requestBodyBytes(req),
      payload: paymentPayload,
    });
    decision = bindPaymentId({
      cache: idempotencyCache,
      reservations: pendingReservations,
      paymentId,
      fingerprint,
      now: Date.now(),
      cacheTtlMs: CACHE_TTL_MS,
      reservationTtlMs: RESERVATION_TTL_MS,
    });
    if (decision.kind === "hit") {
      cached = idempotencyCache.get(paymentId);
      if (!cached) {
        throw new Error("cache hit disappeared");
      }
    } else if (decision.kind === "miss") {
      reserved = pendingReservations.get(paymentId);
      if (!reserved?.token) {
        throw new Error("reservation missing after bind");
      }
    }
  } catch {
    failClosed();
    return;
  }

  if (decision.kind === "conflict") {
    console.log(`[Idempotency] CONFLICT - same ID, different request`);
    res.status(409).json({
      error: CONFLICT_MESSAGE,
      paymentId,
    });
    return;
  }

  if (decision.kind === "in_flight") {
    console.log(`[Idempotency] IN FLIGHT - retryable, request already reserved`);
    res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    res.status(RETRYABLE_STATUS_CODE).json({
      error: IN_FLIGHT_MESSAGE,
      paymentId,
      retryable: true,
    });
    return;
  }

  if (decision.kind === "capacity") {
    console.log(`[Idempotency] CAPACITY - retryable, reservation map is full`);
    res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
    res.status(RETRYABLE_STATUS_CODE).json({
      error: CAPACITY_MESSAGE,
      paymentId,
      retryable: true,
    });
    return;
  }

  if (decision.kind === "hit" && cached) {
    const age = Date.now() - cached.timestamp;
    console.log(
      `[Idempotency] Cache HIT - returning cached response (age: ${Math.round(age / 1000)}s)`,
    );
    res.json({
      report: {
        ...cached.response.report,
        cached: true,
      },
    });
    return;
  }

  (req as ReservationRequest).x402ReservationToken = reserved?.token;
  const reservedToken = reserved?.token;
  res.once("finish", () => {
    if (!reservedToken) {
      return;
    }
    releaseIfPending(
      pendingReservations,
      paymentId,
      fingerprint,
      Date.now(),
      RESERVATION_TTL_MS,
      reservedToken,
    );
  });
  console.log(`[Idempotency] Cache MISS - reserved, proceeding with payment`);

  next();
});

app.use(paymentMiddlewareFromHTTPServer(httpServer));

app.get("/weather", (_req, res) => {
  res.json({
    report: {
      weather: "sunny",
      temperature: 70,
      cached: false,
    },
  });
});

app.listen(4022, () => {
  console.log(`\n🌤️  Payment-Identifier Example Server`);
  console.log(`   Listening at http://localhost:4022`);
  console.log(`\n📋 Idempotency Configuration:`);
  console.log(`   - Cache TTL: 1 hour`);
  console.log(
    `   - In-flight reservation TTL: ${RESERVATION_TTL_MS / 1000}s server-owned (not client maxTimeoutSeconds)`,
  );
  console.log(`   - Pending map bound: 1024 entries, fail closed at capacity`);
  console.log(`   - Payment ID: optional (required: false)`);
  console.log(`   - Scope: GET-only, single-process in-memory example`);
  console.log(`\n💡 How it works:`);
  console.log(`   1. Client sends payment with a unique payment ID`);
  console.log(`   2. Server caches the response bound to that ID, HTTP request, and credential`);
  console.log(`   3. Same ID and same request+credential fingerprint returns the cached response`);
  console.log(
    `   4. Same ID with a different method, path, query, body, extra, timeout, or credential returns 409`,
  );
  console.log(`   5. In-flight and capacity responses are HTTP 503 retryable, not 409 conflict`);
  console.log(`   6. Reservations are created only for GET /weather`);
  console.log(
    `   7. Pre-settlement rejection releases the matching reservation; thrown settle errors keep a tokenized tombstone until TTL`,
  );
  console.log(`   8. A settle failure is not immediately safe to retry`);
  console.log(`   9. Retry the exact encoded payment header; do not create a new signature`);
  console.log(`  10. No duplicate payment processing occurs on a cache hit\n`);
});
