/**
 * DID Resolution Utilities
 *
 * Extracts public keys from DID key identifiers. Supports did:key, did:jwk, did:web.
 * Uses @noble/curves and @scure/base for cryptographic operations.
 */

import * as jose from "jose";
import { base58 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p256 } from "@noble/curves/nist";

// Multicodec prefixes for supported key types
const MULTICODEC_ED25519_PUB = 0xed;
const MULTICODEC_SECP256K1_PUB = 0xe7;
const MULTICODEC_P256_PUB = 0x1200;

/**
 * Extract a public key from a DID key identifier (kid).
 * Supports did:key, did:jwk, did:web.
 *
 * @param kid - The key identifier (DID URL, e.g., did:key:z6Mk..., did:web:example.com#key-1)
 * @returns The extracted public key
 */
export async function extractPublicKeyFromKid(kid: string): Promise<jose.KeyLike> {
  const [didPart, fragment] = kid.split("#");
  const parts = didPart.split(":");

  if (parts.length < 3 || parts[0] !== "did") {
    throw new Error(`Invalid DID format: ${kid}`);
  }

  const method = parts[1];
  const identifier = parts.slice(2).join(":");

  switch (method) {
    case "key":
      return extractKeyFromDidKey(identifier);
    case "jwk":
      return extractKeyFromDidJwk(identifier);
    case "web":
      return resolveDidWeb(identifier, fragment);
    default:
      throw new Error(
        `Unsupported DID method "${method}". Supported: did:key, did:jwk, did:web. ` +
          `Provide the public key directly for other methods.`,
      );
  }
}

/**
 * Extract public key from did:key identifier (multibase-encoded)
 *
 * @param identifier - The did:key identifier (without the "did:key:" prefix)
 * @returns The extracted public key
 */
async function extractKeyFromDidKey(identifier: string): Promise<jose.KeyLike> {
  if (!identifier.startsWith("z")) {
    throw new Error(`Unsupported multibase encoding. Expected 'z' (base58-btc).`);
  }

  const decoded = base58.decode(identifier.slice(1));
  const { codec, keyBytes } = readMulticodec(decoded);

  switch (codec) {
    case MULTICODEC_ED25519_PUB:
      return importAsymmetricJWK({
        kty: "OKP",
        crv: "Ed25519",
        x: jose.base64url.encode(keyBytes),
      });

    case MULTICODEC_SECP256K1_PUB: {
      const point = secp256k1.Point.fromHex(keyBytes);
      const uncompressed = point.toBytes(false);
      return importAsymmetricJWK({
        kty: "EC",
        crv: "secp256k1",
        x: jose.base64url.encode(uncompressed.slice(1, 33)),
        y: jose.base64url.encode(uncompressed.slice(33, 65)),
      });
    }

    case MULTICODEC_P256_PUB: {
      const point = p256.Point.fromHex(keyBytes);
      const uncompressed = point.toBytes(false);
      return importAsymmetricJWK({
        kty: "EC",
        crv: "P-256",
        x: jose.base64url.encode(uncompressed.slice(1, 33)),
        y: jose.base64url.encode(uncompressed.slice(33, 65)),
      });
    }

    default:
      throw new Error(
        `Unsupported key type in did:key (multicodec: 0x${codec.toString(16)}). ` +
          `Supported: Ed25519, secp256k1, P-256.`,
      );
  }
}

/**
 * Extract public key from did:jwk identifier (base64url-encoded JWK)
 *
 * @param identifier - The did:jwk identifier (without the "did:jwk:" prefix)
 * @returns The extracted public key
 */
async function extractKeyFromDidJwk(identifier: string): Promise<jose.KeyLike> {
  const jwkJson = new TextDecoder().decode(jose.base64url.decode(identifier));
  const jwk = JSON.parse(jwkJson) as jose.JWK;
  return importAsymmetricJWK(jwk);
}

/**
 * Resolve did:web by fetching DID document from .well-known/did.json
 *
 * @param identifier - The did:web identifier (without the "did:web:" prefix)
 * @param fragment - Optional fragment to identify specific key
 * @returns The extracted public key
 */
async function resolveDidWeb(identifier: string, fragment?: string): Promise<jose.KeyLike> {
  const parts = identifier.split(":");
  const domain = decodeURIComponent(parts[0]);
  const path = parts.slice(1).map(decodeURIComponent).join("/");

  // did:web spec allows HTTP for localhost (https://w3c-ccg.github.io/did-method-web/#read-resolve)
  const host = domain.split(":")[0];
  const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";

  const url = path
    ? `${scheme}://${domain}/${path}/did.json`
    : `${scheme}://${domain}/.well-known/did.json`;

  let didDocument: DIDDocument;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/did+json, application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    didDocument = (await response.json()) as DIDDocument;
  } catch (error) {
    throw new Error(
      `Failed to resolve did:web:${identifier}: ${error instanceof Error ? error.message : error}`,
    );
  }

  const fullDid = `did:web:${identifier}`;
  const keyId = fragment ? `${fullDid}#${fragment}` : undefined;
  const method = findVerificationMethod(didDocument, keyId);

  if (!method) {
    throw new Error(`No verification method found for ${keyId || fullDid}`);
  }

  if (method.publicKeyJwk) {
    return importAsymmetricJWK(method.publicKeyJwk);
  }
  if (method.publicKeyMultibase) {
    return extractKeyFromDidKey(method.publicKeyMultibase);
  }

  throw new Error(`Verification method ${method.id} has no supported key format`);
}

/**
 * Read multicodec varint prefix from bytes
 *
 * @param bytes - The encoded bytes
 * @returns The codec identifier and remaining key bytes
 */
function readMulticodec(bytes: Uint8Array): { codec: number; keyBytes: Uint8Array } {
  let codec = 0;
  let shift = 0;
  let offset = 0;

  for (const byte of bytes) {
    codec |= (byte & 0x7f) << shift;
    offset++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { codec, keyBytes: bytes.slice(offset) };
}

/**
 * Import an asymmetric JWK as a KeyLike
 *
 * @param jwk - The JWK to import
 * @returns The imported key
 */
async function importAsymmetricJWK(jwk: jose.JWK): Promise<jose.KeyLike> {
  const key = await jose.importJWK(jwk);
  if (key instanceof Uint8Array) {
    throw new Error("Symmetric keys are not supported");
  }
  return key;
}

interface DIDDocument {
  id: string;
  verificationMethod?: VerificationMethod[];
  assertionMethod?: (string | VerificationMethod)[];
  authentication?: (string | VerificationMethod)[];
}

interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyJwk?: jose.JWK;
  publicKeyMultibase?: string;
}

/**
 * Find a verification method in a DID document
 *
 * @param doc - The DID document
 * @param keyId - Optional specific key ID to find
 * @returns The verification method or undefined
 */
function findVerificationMethod(doc: DIDDocument, keyId?: string): VerificationMethod | undefined {
  const methods = doc.verificationMethod || [];

  if (keyId) {
    return methods.find(m => m.id === keyId);
  }

  // Prefer assertionMethod, then authentication, then any
  for (const ref of doc.assertionMethod || []) {
    if (typeof ref === "string") {
      const m = methods.find(m => m.id === ref);
      if (m) return m;
    } else {
      return ref;
    }
  }

  for (const ref of doc.authentication || []) {
    if (typeof ref === "string") {
      const m = methods.find(m => m.id === ref);
      if (m) return m;
    } else {
      return ref;
    }
  }

  return methods[0];
}
