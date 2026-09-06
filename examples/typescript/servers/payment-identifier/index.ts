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
import { createHash } from "crypto";
import type { PaymentPayload } from "@x402/core/types";
config();

/**
 * Computes a deterministic hash of the full PaymentPayload. A proper retry
 * resends the exact same signed payload, so the hash — including the
 * cryptographic signature — will match. A genuinely different request
 * (different signer, amount, etc.) produces a different hash → 409 Conflict.
 *
 * @param payload - the payment payload to fingerprint
 * @returns SHA-256 hex digest of the canonicalized payload
 */
function payloadFingerprint(payload: PaymentPayload): string {
  const canonical = JSON.stringify(payload, (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

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
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Cleans up expired entries from the cache.
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, value] of idempotencyCache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
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
  // Hook after settlement to cache the response with its fingerprint
  .onAfterSettle(async ({ paymentPayload }) => {
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (paymentId) {
      const fp = payloadFingerprint(paymentPayload);
      console.log(`[Idempotency] Caching response for payment ID: ${paymentId}`);
      idempotencyCache.set(paymentId, {
        timestamp: Date.now(),
        fingerprint: fp,
        response: {
          report: {
            weather: "sunny",
            temperature: 70,
            cached: false,
          },
        },
      });
    }
  });

// Create HTTP server with the onProtectedRequest hook for idempotency
const httpServer = new x402HTTPResourceServer(resourceServer, routes).onProtectedRequest(
  async context => {
    // Only check idempotency if there's a payment header (retry scenario)
    if (!context.paymentHeader) {
      return; // Continue to normal payment flow
    }

    // Try to decode the payment header to get the payment ID
    // The payment header is base64-encoded JSON
    try {
      const paymentPayload = JSON.parse(
        Buffer.from(context.paymentHeader, "base64").toString("utf-8"),
      );
      const paymentId = extractPaymentIdentifier(paymentPayload);

      if (paymentId) {
        console.log(`[Idempotency] Checking payment ID: ${paymentId}`);

        const cached = idempotencyCache.get(paymentId);
        if (cached) {
          const age = Date.now() - cached.timestamp;
          if (age < CACHE_TTL_MS) {
            // Compare fingerprints to detect payload mismatch
            const fp = payloadFingerprint(paymentPayload);

            // Access Express request through adapter's private req property
            const adapter = context.adapter as unknown as {
              req: express.Request & { paymentId?: string; paymentIdConflict?: boolean };
            };

            if (fp !== cached.fingerprint) {
              console.log(`[Idempotency] CONFLICT - same ID, different payload`);
              adapter.req.paymentIdConflict = true;
              adapter.req.paymentId = paymentId;
              return { grantAccess: true };
            }

            console.log(
              `[Idempotency] Cache HIT - granting access (age: ${Math.round(age / 1000)}s)`,
            );
            adapter.req.paymentId = paymentId;
            // Grant access without payment processing - the cached response will be served
            return { grantAccess: true };
          } else {
            console.log(`[Idempotency] Cache EXPIRED - proceeding with payment`);
            idempotencyCache.delete(paymentId);
          }
        } else {
          console.log(`[Idempotency] Cache MISS - proceeding with payment`);
        }
      }
    } catch {
      // Invalid payment header format, continue to normal flow
    }

    return; // Continue to normal payment verification
  },
);

const app = express();

app.use(paymentMiddlewareFromHTTPServer(httpServer));

app.get("/weather", (req, res) => {
  const reqExt = req as express.Request & { paymentId?: string; paymentIdConflict?: boolean };

  // Same ID but different payload → 409 Conflict
  if (reqExt.paymentIdConflict) {
    res.status(409).json({
      error: "payment identifier already used with different payload",
      paymentId: reqExt.paymentId,
    });
    return;
  }

  // Same ID, same payload → return cached response
  if (reqExt.paymentId) {
    const cached = idempotencyCache.get(reqExt.paymentId);
    if (cached) {
      res.json({
        report: {
          ...cached.response.report,
          cached: true,
        },
      });
      return;
    }
  }

  // New request → normal response
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
  console.log(`   - Payment ID: optional (required: false)`);
  console.log(`\n💡 How it works:`);
  console.log(`   1. Client sends payment with a unique payment ID`);
  console.log(`   2. Server caches the response keyed by payment ID`);
  console.log(`   3. If same payment ID is seen within 1 hour, access is granted without payment`);
  console.log(`   4. No duplicate payment processing occurs\n`);
});
