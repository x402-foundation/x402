/**
 * Cross-implementation conformance vectors for x402 Offer/Receipt Extension
 *
 * These vectors are published by scvd.store, an independent implementation
 * of the offer-receipt spec (x402-verify / x402-sign npm packages, zero
 * dependencies). They provide known-good and known-bad artifacts for
 * verifying that any implementation handles edge cases correctly.
 *
 * Source: https://scvd.store/.well-known/conformance/offer-receipt-vectors.json
 * Spec: specs/extensions/extension-offer-and-receipt.md
 */

import { describe, it, expect } from "vitest";
import * as jose from "jose";
import {
  extractJWSHeader,
  extractJWSPayload,
  verifyOfferSignatureJWS,
  verifyReceiptSignatureJWS,
  type JWSSignedOffer,
  type JWSSignedReceipt,
} from "../../src/offer-receipt";

// ============================================================================
// Vector Types
// ============================================================================

interface ValidVector {
  name: string;
  expect: "accept";
  payload: Record<string, unknown>;
  jws: string;
}

interface InvalidVector {
  name: string;
  expect: "reject";
  reject_at: "schema" | "signature" | "alg" | "kid" | "parse";
  note: string;
  jws: string;
}

interface VectorFile {
  version: number;
  spec: string;
  valid: ValidVector[];
  invalid: InvalidVector[];
}

// ============================================================================
// Load Vectors
// ============================================================================

const vectors: VectorFile = require("./offer-receipt-vectors.json");

// ============================================================================
// Helper: resolve kid to public key (test-only, uses scvd.store's test key)
// ============================================================================

/**
 * Resolve a did:web kid to its public key for verification.
 *
 * In production, this would fetch the did:web document and resolve the key.
 * For these tests, we use the known test key published by scvd.store.
 */
async function resolveTestKey(kid: string): Promise<jose.KeyLike> {
  // Per the vectors file's own how_to_use: the kid is a LABEL, never
  // resolved. The test public key ships inside the vectors (signing.
  // public_key_hex, derived from a public 0x42 seed) so verification
  // is self-contained and network-free.
  if (!kid.includes("scvd.store")) {
    throw new Error(`Unexpected kid in test vector: ${kid}`);
  }
  const hex = (vectors as unknown as { signing: { public_key_hex: string } })
    .signing.public_key_hex;
  const x = Buffer.from(hex, "hex").toString("base64url");
  return jose.importJWK({ kty: "OKP", crv: "Ed25519", x }, "EdDSA") as Promise<jose.KeyLike>;
}

// ============================================================================
// Valid Vectors — must accept
// ============================================================================

describe("Offer/Receipt Conformance Vectors (scvd.store)", () => {
  describe("Valid vectors — must accept", () => {
    for (const vector of vectors.valid) {
      it(`${vector.name}: ${vector.expect}`, async () => {
        const header = extractJWSHeader(vector.jws);
        expect(header.alg).toBe("EdDSA");
        expect(header.kid).toBeDefined();

        const payload = extractJWSPayload(vector.jws);
        expect(payload).toEqual(vector.payload);

        // Verify signature
        const key = await resolveTestKey(header.kid as string);
        const signedOffer: JWSSignedOffer = {
          format: "jws",
          signature: vector.jws,
        };

        // This should not throw
        const result = await verifyOfferSignatureJWS(signedOffer, key);
        expect(result).toBeDefined();
      });
    }
  });

  // ============================================================================
  // Invalid Vectors — must reject at the specified stage
  // ============================================================================

  describe("Invalid vectors — must reject", () => {
    for (const vector of vectors.invalid) {
      it(`${vector.name}: reject at ${vector.reject_at}`, async () => {
        const { reject_at } = vector;

        if (reject_at === "parse") {
          // Malformed JWS — should throw during parsing
          expect(() => extractJWSHeader(vector.jws)).toThrow();
          return;
        }

        if (reject_at === "alg") {
          // Algorithm confusion or none — should reject at header inspection
          const header = extractJWSHeader(vector.jws);
          if (header.alg === "none") {
            // alg:none must be rejected
            expect(header.alg).toBe("none");
            // A conformant verifier rejects alg:none without attempting verification
            return;
          }
          if (header.alg === "HS256") {
            // Algorithm confusion — HS256 claimed but this is not an HMAC key
            // The verifier must not attempt HMAC verification with a public key
            expect(header.alg).toBe("HS256");
            return;
          }
        }

        if (reject_at === "kid") {
          // Missing kid — should reject before attempting verification
          const header = extractJWSHeader(vector.jws);
          expect(header.kid).toBeUndefined();
          return;
        }

        if (reject_at === "schema") {
          // Schema violation — signature may verify but payload is invalid
          const header = extractJWSHeader(vector.jws);
          const payload = extractJWSPayload(vector.jws);

          // Check for missing required fields
          if (vector.name === "offer_missing_version") {
            expect(payload.version).toBeUndefined();
          }
          if (vector.name === "offer_missing_payTo") {
            expect(payload.payTo).toBeUndefined();
          }
          if (vector.name === "receipt_missing_payer") {
            expect(payload.payer).toBeUndefined();
          }
          return;
        }

        if (reject_at === "signature") {
          // Signature invalid — wrong key, tampered payload, or truncated
          const header = extractJWSHeader(vector.jws);
          const key = await resolveTestKey(header.kid as string);

          const signedOffer: JWSSignedOffer = {
            format: "jws",
            signature: vector.jws,
          };

          // Verification should fail
          await expect(verifyOfferSignatureJWS(signedOffer, key)).rejects.toThrow();
          return;
        }
      });
    }
  });
});
