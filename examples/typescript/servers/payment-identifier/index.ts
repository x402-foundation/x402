import { config } from "dotenv";
import express from "express";
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";
import {
  CONFLICT_MESSAGE,
  IN_FLIGHT_MESSAGE,
  RESERVATION_TTL_MS,
  bindPaymentId,
  cleanupExpiredReservations,
  consumeReservation,
  requestFingerprint,
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

// Create the resource server with payment scheme support
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  // Hook after settlement to cache the response with its HTTP request fingerprint
  .onAfterSettle(async ({ paymentPayload }) => {
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (!paymentId) {
      return;
    }
    const fingerprint = consumeReservation(
      pendingReservations,
      paymentId,
      Date.now(),
      RESERVATION_TTL_MS,
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
  });

const httpServer = new x402HTTPResourceServer(resourceServer, routes);

const app = express();

// Run before payment middleware so a fingerprint mismatch returns 409
// without grantAccess and without payment verification.
app.use((req, res, next) => {
  cleanupExpiredEntries();

  const paymentHeader = req.header("payment-signature") || req.header("x-payment");
  if (!paymentHeader) {
    next();
    return;
  }

  try {
    const paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (!paymentId) {
      next();
      return;
    }

    console.log(`[Idempotency] Checking payment ID: ${paymentId}`);
    const fingerprint = requestFingerprint({
      method: req.method,
      url: req.originalUrl || req.url,
      body: requestBodyBytes(req),
      payload: paymentPayload,
    });
    const decision = bindPaymentId({
      cache: idempotencyCache,
      reservations: pendingReservations,
      paymentId,
      fingerprint,
      now: Date.now(),
      cacheTtlMs: CACHE_TTL_MS,
      reservationTtlMs: RESERVATION_TTL_MS,
    });

    if (decision.kind === "conflict") {
      console.log(`[Idempotency] CONFLICT - same ID, different request`);
      res.status(409).json({
        error: CONFLICT_MESSAGE,
        paymentId,
      });
      return;
    }

    if (decision.kind === "in_flight") {
      console.log(`[Idempotency] IN FLIGHT - same ID, request already reserved`);
      res.status(409).json({
        error: IN_FLIGHT_MESSAGE,
        paymentId,
      });
      return;
    }

    if (decision.kind === "hit") {
      const cached = idempotencyCache.get(paymentId);
      if (cached) {
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
    }

    console.log(`[Idempotency] Cache MISS - reserved, proceeding with payment`);
  } catch {
    // Invalid payment header format, continue to normal flow
  }

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
  console.log(`   - In-flight reservation TTL: 30 seconds`);
  console.log(`   - Payment ID: optional (required: false)`);
  console.log(`\n💡 How it works:`);
  console.log(`   1. Client sends payment with a unique payment ID`);
  console.log(`   2. Server caches the response bound to that ID and the HTTP request`);
  console.log(`   3. Same ID and same request fingerprint returns the cached response`);
  console.log(`   4. Same ID with a different method, path, query, or body returns 409`);
  console.log(`   5. A live in-flight reservation is never overwritten`);
  console.log(`   6. No duplicate payment processing occurs on a cache hit\n`);
});
