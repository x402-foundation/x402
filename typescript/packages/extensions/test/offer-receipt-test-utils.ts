/**
 * Test utilities for x402 Offer/Receipt Extension
 *
 * These are convenience functions for testing only.
 * Production implementations should use HSM, TPM, or secure key management.
 */

import * as jose from "jose";
import { secp256k1 } from "@noble/curves/secp256k1";
import type { JWSSigner } from "../src/offer-receipt/types";

// ============================================================================
// P-256 (ES256) Utilities - Clean Web Crypto implementation
// ============================================================================

/**
 * Create an ES256 (P-256) JWS signer from a CryptoKey (FOR TESTING ONLY)
 *
 * The signer's sign() function returns ONLY the raw base64url-encoded signature.
 * The library's createJWS function is responsible for assembling the
 * full JWS compact serialization (header.payload.signature).
 *
 * @param privateKey - The CryptoKey private key (P-256)
 * @param kid - The key identifier
 * @returns A JWS signer
 */
export function createES256Signer(privateKey: CryptoKey, kid: string): JWSSigner {
  return {
    kid,
    algorithm: "ES256",
    format: "jws",
    sign: async (signingInput: Uint8Array): Promise<string> => {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        signingInput,
      );
      return jose.base64url.encode(new Uint8Array(signature));
    },
  };
}

/**
 * Generate a P-256 (ES256) key pair for testing
 *
 * Returns both the CryptoKey (for signing) and JWK (for verification).
 *
 * @returns Promise resolving to privateKey CryptoKey and publicKey JWK
 */
export async function generateES256KeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKeyJWK: jose.JWK;
}> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);

  const publicKeyJWK = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  return {
    privateKey: keyPair.privateKey,
    publicKeyJWK,
  };
}

// ============================================================================
// secp256k1 (ES256K) Utilities - For EVM-compatible testing
// ============================================================================

/**
 * SHA-256 hash using Web Crypto API
 *
 * @param data - The data to hash
 * @returns The SHA-256 hash as Uint8Array
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

/**
 * Create an ES256K (secp256k1) JWS signer from a JWK (FOR TESTING ONLY)
 *
 * @param jwk - The JWK private key
 * @param kid - The key identifier
 * @returns A JWS signer
 */
export async function createES256KSigner(jwk: jose.JWK, kid: string): Promise<JWSSigner> {
  if (jwk.crv !== "secp256k1") {
    throw new Error(`Unsupported curve: ${jwk.crv}. Use createJWSSigner for P-256.`);
  }
  if (!jwk.d) {
    throw new Error("JWK must contain private key (d parameter)");
  }

  const privateKeyBytes = jose.base64url.decode(jwk.d);

  return {
    kid,
    algorithm: "ES256K",
    format: "jws",
    sign: async (signingInput: Uint8Array): Promise<string> => {
      const hash = await sha256(signingInput);
      const signature = secp256k1.sign(hash, privateKeyBytes);

      // JWS uses concatenated r || s format (not DER)
      const r = signature.r.toString(16).padStart(64, "0");
      const s = signature.s.toString(16).padStart(64, "0");
      const sigBytes = new Uint8Array(64);
      for (let i = 0; i < 32; i++) {
        sigBytes[i] = parseInt(r.slice(i * 2, i * 2 + 2), 16);
        sigBytes[i + 32] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
      }

      return jose.base64url.encode(sigBytes);
    },
  };
}

/**
 * Generate an ES256K (secp256k1) key pair (FOR TESTING ONLY)
 *
 * @returns Promise resolving to an object with privateKey and publicKey JWKs
 */
export async function generateES256KKeyPair(): Promise<{
  privateKey: jose.JWK;
  publicKey: jose.JWK;
}> {
  const { privateKey, publicKey } = await jose.generateKeyPair("ES256K");
  return {
    privateKey: await jose.exportJWK(privateKey),
    publicKey: await jose.exportJWK(publicKey),
  };
}
