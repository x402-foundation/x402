/**
 * Signing utilities for x402 Offer/Receipt Extension
 *
 * This module provides:
 * - JCS (JSON Canonicalization Scheme) per RFC 8785
 * - JWS (JSON Web Signature) signing and extraction
 * - EIP-712 typed data signing
 * - Offer/Receipt creation utilities
 * - Signature verification utilities
 *
 * Based on: x402/specs/extensions/extension-offer-and-receipt.md (v1.0) §3
 */

import * as jose from "jose";
import { hashTypedData, recoverTypedDataAddress, type Hex, type TypedDataDomain } from "viem";
import type {
  JWSSigner,
  OfferPayload,
  ReceiptPayload,
  SignedOffer,
  SignedReceipt,
  OfferInput,
  ReceiptInput,
} from "./types";
import {
  isJWSSignedOffer,
  isEIP712SignedOffer,
  isJWSSignedReceipt,
  isEIP712SignedReceipt,
  type JWSSignedOffer,
  type EIP712SignedOffer,
  type JWSSignedReceipt,
  type EIP712SignedReceipt,
} from "./types";
import { extractPublicKeyFromKid } from "./did";

// ============================================================================
// JCS Canonicalization (RFC 8785)
// ============================================================================

/**
 * Canonicalize a JSON object using JCS (RFC 8785)
 *
 * Rules:
 * 1. Object keys are sorted lexicographically by UTF-16 code units
 * 2. No whitespace between tokens
 * 3. Numbers use shortest representation (no trailing zeros)
 * 4. Strings use minimal escaping
 * 5. null, true, false are lowercase literals
 *
 * @param value - The object to canonicalize
 * @returns The canonicalized JSON string
 */
export function canonicalize(value: unknown): string {
  return serializeValue(value);
}

/**
 * Serialize a value to canonical JSON
 *
 * @param value - The value to serialize
 * @returns The serialized string
 */
function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";

  const type = typeof value;
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return serializeNumber(value as number);
  if (type === "string") return serializeString(value as string);
  if (Array.isArray(value)) return serializeArray(value);
  if (type === "object") return serializeObject(value as Record<string, unknown>);

  throw new Error(`Cannot canonicalize value of type ${type}`);
}

/**
 * Serialize a number to canonical JSON
 *
 * @param num - The number to serialize
 * @returns The serialized string
 */
function serializeNumber(num: number): string {
  if (!Number.isFinite(num)) throw new Error("Cannot canonicalize Infinity or NaN");
  if (Object.is(num, -0)) return "0";
  return String(num);
}

/**
 * Serialize a string to canonical JSON
 *
 * @param str - The string to serialize
 * @returns The serialized string with proper escaping
 */
function serializeString(str: string): string {
  let result = '"';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const code = str.charCodeAt(i);
    if (code < 0x20) {
      result += "\\u" + code.toString(16).padStart(4, "0");
    } else if (char === '"') {
      result += '\\"';
    } else if (char === "\\") {
      result += "\\\\";
    } else {
      result += char;
    }
  }
  return result + '"';
}

/**
 * Serialize an array to canonical JSON
 *
 * @param arr - The array to serialize
 * @returns The serialized string
 */
function serializeArray(arr: unknown[]): string {
  return "[" + arr.map(serializeValue).join(",") + "]";
}

/**
 * Serialize an object to canonical JSON with sorted keys
 *
 * @param obj - The object to serialize
 * @returns The serialized string with sorted keys
 */
function serializeObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pairs: string[] = [];
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined) {
      pairs.push(serializeString(key) + ":" + serializeValue(value));
    }
  }
  return "{" + pairs.join(",") + "}";
}

/**
 * Hash a canonicalized object using SHA-256
 *
 * @param obj - The object to hash
 * @returns The SHA-256 hash as Uint8Array
 */
export async function hashCanonical(obj: unknown): Promise<Uint8Array> {
  const canonical = canonicalize(obj);
  const data = new TextEncoder().encode(canonical);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

/**
 * Get canonical bytes of an object (UTF-8 encoded)
 *
 * @param obj - The object to encode
 * @returns The UTF-8 encoded canonical JSON
 */
export function getCanonicalBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(obj));
}

// ============================================================================
// JWS Signing (§3.3)
// ============================================================================

/**
 * Create a JWS Compact Serialization from a payload
 *
 * Assembles the full JWS structure (header.payload.signature) using the
 * signer's algorithm and kid. The signer only needs to sign bytes and
 * return the base64url-encoded signature.
 *
 * @param payload - The payload object to sign
 * @param signer - The JWS signer
 * @returns The JWS compact serialization string
 */
export async function createJWS<T extends object>(payload: T, signer: JWSSigner): Promise<string> {
  const headerObj = { alg: signer.algorithm, kid: signer.kid };
  const headerB64 = jose.base64url.encode(new TextEncoder().encode(JSON.stringify(headerObj)));
  const canonical = canonicalize(payload);
  const payloadB64 = jose.base64url.encode(new TextEncoder().encode(canonical));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureB64 = await signer.sign(signingInput);
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Extract JWS header without verification
 *
 * @param jws - The JWS compact serialization string
 * @returns The decoded header object
 */
export function extractJWSHeader(jws: string): { alg: string; kid?: string } {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWS format");
  const headerJson = jose.base64url.decode(parts[0]);
  return JSON.parse(new TextDecoder().decode(headerJson));
}

/**
 * Extract JWS payload
 *
 * Note: This extracts the payload without verifying the signature or
 * checking signer authorization. Signature verification requires resolving
 * key bindings (did:web documents, attestations, etc.) which is outside
 * the scope of x402 client utilities.
 *
 * @param jws - The JWS compact serialization string
 * @returns The decoded payload
 */
export function extractJWSPayload<T>(jws: string): T {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWS format");
  const payloadJson = jose.base64url.decode(parts[1]);
  return JSON.parse(new TextDecoder().decode(payloadJson));
}

// ============================================================================
// EIP-712 Domain Configuration (§3.2)
// ============================================================================

/**
 * Create EIP-712 domain for offer signing
 *
 * @returns The EIP-712 domain object
 */
export function createOfferDomain(): TypedDataDomain {
  return { name: "x402 offer", version: "1", chainId: 1 };
}

/**
 * Create EIP-712 domain for receipt signing
 *
 * @returns The EIP-712 domain object
 */
export function createReceiptDomain(): TypedDataDomain {
  return { name: "x402 receipt", version: "1", chainId: 1 };
}

/**
 * EIP-712 types for Offer (§4.3)
 */
export const OFFER_TYPES = {
  Offer: [
    { name: "version", type: "uint256" },
    { name: "resourceUrl", type: "string" },
    { name: "scheme", type: "string" },
    { name: "network", type: "string" },
    { name: "asset", type: "string" },
    { name: "payTo", type: "string" },
    { name: "amount", type: "string" },
    { name: "validUntil", type: "uint256" },
  ],
};

/**
 * EIP-712 types for Receipt (§5.3)
 */
export const RECEIPT_TYPES = {
  Receipt: [
    { name: "version", type: "uint256" },
    { name: "network", type: "string" },
    { name: "resourceUrl", type: "string" },
    { name: "payer", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "transaction", type: "string" },
  ],
};

// ============================================================================
// EIP-712 Payload Preparation
// ============================================================================

/**
 * Prepare offer payload for EIP-712 signing
 *
 * @param payload - The offer payload
 * @returns The prepared message object for EIP-712
 */
export function prepareOfferForEIP712(payload: OfferPayload): {
  version: bigint;
  resourceUrl: string;
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  validUntil: bigint;
} {
  return {
    version: BigInt(payload.version),
    resourceUrl: payload.resourceUrl,
    scheme: payload.scheme,
    network: payload.network,
    asset: payload.asset,
    payTo: payload.payTo,
    amount: payload.amount,
    validUntil: BigInt(payload.validUntil),
  };
}

/**
 * Prepare receipt payload for EIP-712 signing
 *
 * @param payload - The receipt payload
 * @returns The prepared message object for EIP-712
 */
export function prepareReceiptForEIP712(payload: ReceiptPayload): {
  version: bigint;
  network: string;
  resourceUrl: string;
  payer: string;
  issuedAt: bigint;
  transaction: string;
} {
  return {
    version: BigInt(payload.version),
    network: payload.network,
    resourceUrl: payload.resourceUrl,
    payer: payload.payer,
    issuedAt: BigInt(payload.issuedAt),
    transaction: payload.transaction,
  };
}

// ============================================================================
// EIP-712 Hashing
// ============================================================================

/**
 * Hash offer typed data for EIP-712
 *
 * @param payload - The offer payload
 * @returns The EIP-712 hash
 */
export function hashOfferTypedData(payload: OfferPayload): Hex {
  return hashTypedData({
    domain: createOfferDomain(),
    types: OFFER_TYPES,
    primaryType: "Offer",
    message: prepareOfferForEIP712(payload),
  });
}

/**
 * Hash receipt typed data for EIP-712
 *
 * @param payload - The receipt payload
 * @returns The EIP-712 hash
 */
export function hashReceiptTypedData(payload: ReceiptPayload): Hex {
  return hashTypedData({
    domain: createReceiptDomain(),
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: prepareReceiptForEIP712(payload),
  });
}

// ============================================================================
// EIP-712 Signing
// ============================================================================

/**
 * Function type for signing EIP-712 typed data
 */
export type SignTypedDataFn = (params: {
  domain: TypedDataDomain;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<Hex>;

/**
 * Sign an offer using EIP-712
 *
 * @param payload - The offer payload
 * @param signTypedData - The signing function
 * @returns The signature hex string
 */
export async function signOfferEIP712(
  payload: OfferPayload,
  signTypedData: SignTypedDataFn,
): Promise<Hex> {
  return signTypedData({
    domain: createOfferDomain(),
    types: OFFER_TYPES,
    primaryType: "Offer",
    message: prepareOfferForEIP712(payload) as unknown as Record<string, unknown>,
  });
}

/**
 * Sign a receipt using EIP-712
 *
 * @param payload - The receipt payload
 * @param signTypedData - The signing function
 * @returns The signature hex string
 */
export async function signReceiptEIP712(
  payload: ReceiptPayload,
  signTypedData: SignTypedDataFn,
): Promise<Hex> {
  return signTypedData({
    domain: createReceiptDomain(),
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: prepareReceiptForEIP712(payload) as unknown as Record<string, unknown>,
  });
}

// ============================================================================
// Network Utilities
// ============================================================================

/**
 * Extract chain ID from an EIP-155 network string (strict format)
 *
 * @param network - The network string in "eip155:<chainId>" format
 * @returns The chain ID number
 * @throws Error if network is not in "eip155:<chainId>" format
 */
export function extractEIP155ChainId(network: string): number {
  const match = network.match(/^eip155:(\d+)$/);
  if (!match) {
    throw new Error(`Invalid network format: ${network}. Expected "eip155:<chainId>"`);
  }
  return parseInt(match[1], 10);
}

/**
 * V1 EVM network name to chain ID mapping
 * Based on x402 v1 protocol network identifiers
 */
const V1_EVM_NETWORK_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  sepolia: 11155111,
  abstract: 2741,
  "abstract-testnet": 11124,
  "base-sepolia": 84532,
  base: 8453,
  "avalanche-fuji": 43113,
  avalanche: 43114,
  iotex: 4689,
  sei: 1329,
  "sei-testnet": 1328,
  polygon: 137,
  "polygon-amoy": 80002,
  peaq: 3338,
  story: 1514,
  educhain: 41923,
  "skale-base-sepolia": 324705682,
};

/**
 * V1 Solana network name to CAIP-2 mapping
 */
const V1_SOLANA_NETWORKS: Record<string, string> = {
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "solana-testnet": "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

/**
 * Convert a network string to CAIP-2 format
 *
 * Handles both CAIP-2 format and legacy x402 v1 network strings:
 * - CAIP-2: "eip155:8453" → "eip155:8453" (passed through)
 * - V1 EVM: "base" → "eip155:8453", "base-sepolia" → "eip155:84532"
 * - V1 Solana: "solana" → "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
 *
 * @param network - The network string to convert
 * @returns The CAIP-2 formatted network string
 * @throws Error if network is not a recognized v1 identifier or CAIP-2 format
 */
export function convertNetworkStringToCAIP2(network: string): string {
  // Already CAIP-2 format
  if (network.includes(":")) return network;

  // Check V1 EVM networks
  const chainId = V1_EVM_NETWORK_CHAIN_IDS[network.toLowerCase()];
  if (chainId !== undefined) {
    return `eip155:${chainId}`;
  }

  // Check V1 Solana networks
  const solanaNetwork = V1_SOLANA_NETWORKS[network.toLowerCase()];
  if (solanaNetwork) {
    return solanaNetwork;
  }

  throw new Error(
    `Unknown network identifier: "${network}". Expected CAIP-2 format (e.g., "eip155:8453") or v1 name (e.g., "base", "solana").`,
  );
}

/**
 * Extract chain ID from a CAIP-2 network string (EVM only)
 *
 * @param network - The CAIP-2 network string
 * @returns Chain ID number, or undefined for non-EVM networks
 */
export function extractChainIdFromCAIP2(network: string): number | undefined {
  const [namespace, reference] = network.split(":");
  if (namespace === "eip155" && reference) {
    const chainId = parseInt(reference, 10);
    return isNaN(chainId) ? undefined : chainId;
  }
  return undefined;
}

// ============================================================================
// Offer Creation (§4)
// ============================================================================

/** Default offer validity in seconds (matches x402ResourceServer.ts) */
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/** Current extension version */
const EXTENSION_VERSION = 1;

/**
 * Create an offer payload from input
 *
 * @param resourceUrl - The resource URL being paid for
 * @param input - The offer input parameters
 * @returns The offer payload
 */
function createOfferPayload(resourceUrl: string, input: OfferInput): OfferPayload {
  const now = Math.floor(Date.now() / 1000);
  const offerValiditySeconds = input.offerValiditySeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;

  return {
    version: EXTENSION_VERSION,
    resourceUrl,
    scheme: input.scheme,
    network: input.network,
    asset: input.asset,
    payTo: input.payTo,
    amount: input.amount,
    validUntil: now + offerValiditySeconds,
  };
}

/**
 * Create a signed offer using JWS
 *
 * @param resourceUrl - The resource URL being paid for
 * @param input - The offer input parameters
 * @param signer - The JWS signer
 * @returns The signed offer with JWS format
 */
export async function createOfferJWS(
  resourceUrl: string,
  input: OfferInput,
  signer: JWSSigner,
): Promise<JWSSignedOffer> {
  const payload = createOfferPayload(resourceUrl, input);
  const jws = await createJWS(payload, signer);
  return {
    format: "jws",
    acceptIndex: input.acceptIndex,
    signature: jws,
  };
}

/**
 * Create a signed offer using EIP-712
 *
 * @param resourceUrl - The resource URL being paid for
 * @param input - The offer input parameters
 * @param signTypedData - The signing function
 * @returns The signed offer with EIP-712 format
 */
export async function createOfferEIP712(
  resourceUrl: string,
  input: OfferInput,
  signTypedData: SignTypedDataFn,
): Promise<EIP712SignedOffer> {
  const payload = createOfferPayload(resourceUrl, input);
  const signature = await signOfferEIP712(payload, signTypedData);
  return {
    format: "eip712",
    acceptIndex: input.acceptIndex,
    payload,
    signature,
  };
}

/**
 * Extract offer payload
 *
 * Note: This extracts the payload without verifying the signature or
 * checking signer authorization. Signer authorization requires resolving
 * key bindings (did:web documents, attestations, etc.) which is outside
 * the scope of x402 client utilities. See spec §4.5.1.
 *
 * @param offer - The signed offer
 * @returns The offer payload
 */
export function extractOfferPayload(offer: SignedOffer): OfferPayload {
  if (isJWSSignedOffer(offer)) {
    return extractJWSPayload<OfferPayload>(offer.signature);
  } else if (isEIP712SignedOffer(offer)) {
    return offer.payload;
  }
  throw new Error(`Unknown offer format: ${(offer as SignedOffer).format}`);
}

// ============================================================================
// Receipt Creation (§5)
// ============================================================================

/**
 * Create a receipt payload for EIP-712 (requires all fields per spec §5.3)
 *
 * Per spec: "implementations MUST set unused fields to empty string"
 * for EIP-712 signing where fixed schemas require all fields.
 *
 * @param input - The receipt input parameters
 * @returns The receipt payload with all fields
 */
function createReceiptPayloadForEIP712(input: ReceiptInput): ReceiptPayload {
  return {
    version: EXTENSION_VERSION,
    network: input.network,
    resourceUrl: input.resourceUrl,
    payer: input.payer,
    issuedAt: Math.floor(Date.now() / 1000),
    transaction: input.transaction ?? "",
  };
}

/**
 * Create a receipt payload for JWS (omits optional fields when not provided)
 *
 * Per spec §5.2: transaction is optional and should be omitted in JWS
 * when not provided (privacy-minimal by default).
 *
 * @param input - The receipt input parameters
 * @returns The receipt payload with optional fields omitted if not provided
 */
function createReceiptPayloadForJWS(
  input: ReceiptInput,
): Omit<ReceiptPayload, "transaction"> & { transaction?: string } {
  const payload: Omit<ReceiptPayload, "transaction"> & { transaction?: string } = {
    version: EXTENSION_VERSION,
    network: input.network,
    resourceUrl: input.resourceUrl,
    payer: input.payer,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  if (input.transaction) {
    payload.transaction = input.transaction;
  }
  return payload;
}

/**
 * Create a signed receipt using JWS
 *
 * @param input - The receipt input parameters
 * @param signer - The JWS signer
 * @returns The signed receipt with JWS format
 */
export async function createReceiptJWS(
  input: ReceiptInput,
  signer: JWSSigner,
): Promise<JWSSignedReceipt> {
  const payload = createReceiptPayloadForJWS(input);
  const jws = await createJWS(payload, signer);
  return { format: "jws", signature: jws };
}

/**
 * Create a signed receipt using EIP-712
 *
 * @param input - The receipt input parameters
 * @param signTypedData - The signing function
 * @returns The signed receipt with EIP-712 format
 */
export async function createReceiptEIP712(
  input: ReceiptInput,
  signTypedData: SignTypedDataFn,
): Promise<EIP712SignedReceipt> {
  const payload = createReceiptPayloadForEIP712(input);
  const signature = await signReceiptEIP712(payload, signTypedData);
  return { format: "eip712", payload, signature };
}

/**
 * Extract receipt payload
 *
 * Note: This extracts the payload without verifying the signature or
 * checking signer authorization. Signer authorization requires resolving
 * key bindings (did:web documents, attestations, etc.) which is outside
 * the scope of x402 client utilities. See spec §5.5.
 *
 * @param receipt - The signed receipt
 * @returns The receipt payload
 */
export function extractReceiptPayload(receipt: SignedReceipt): ReceiptPayload {
  if (isJWSSignedReceipt(receipt)) {
    return extractJWSPayload<ReceiptPayload>(receipt.signature);
  } else if (isEIP712SignedReceipt(receipt)) {
    return receipt.payload;
  }
  throw new Error(`Unknown receipt format: ${(receipt as SignedReceipt).format}`);
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Result of EIP-712 signature verification
 */
export interface EIP712VerificationResult<T> {
  signer: Hex;
  payload: T;
}

/**
 * Verify an EIP-712 signed offer and recover the signer address.
 * Does NOT verify signer authorization for the resourceUrl - see spec §4.5.1.
 *
 * @param offer - The EIP-712 signed offer
 * @returns The recovered signer address and payload
 */
export async function verifyOfferSignatureEIP712(
  offer: EIP712SignedOffer,
): Promise<EIP712VerificationResult<OfferPayload>> {
  if (offer.format !== "eip712") {
    throw new Error(`Expected eip712 format, got ${offer.format}`);
  }
  if (!offer.payload || !("scheme" in offer.payload)) {
    throw new Error("Invalid offer: missing or malformed payload");
  }

  const signer = await recoverTypedDataAddress({
    domain: createOfferDomain(),
    types: OFFER_TYPES,
    primaryType: "Offer",
    message: prepareOfferForEIP712(offer.payload),
    signature: offer.signature as Hex,
  });

  return { signer, payload: offer.payload };
}

/**
 * Verify an EIP-712 signed receipt and recover the signer address.
 * Does NOT verify signer authorization for the resourceUrl - see spec §4.5.1.
 *
 * @param receipt - The EIP-712 signed receipt
 * @returns The recovered signer address and payload
 */
export async function verifyReceiptSignatureEIP712(
  receipt: EIP712SignedReceipt,
): Promise<EIP712VerificationResult<ReceiptPayload>> {
  if (receipt.format !== "eip712") {
    throw new Error(`Expected eip712 format, got ${receipt.format}`);
  }
  if (!receipt.payload || !("payer" in receipt.payload)) {
    throw new Error("Invalid receipt: missing or malformed payload");
  }

  const signer = await recoverTypedDataAddress({
    domain: createReceiptDomain(),
    types: RECEIPT_TYPES,
    primaryType: "Receipt",
    message: prepareReceiptForEIP712(receipt.payload),
    signature: receipt.signature as Hex,
  });

  return { signer, payload: receipt.payload };
}

/**
 * Verify a JWS signed offer.
 * Does NOT verify signer authorization for the resourceUrl - see spec §4.5.1.
 * If no publicKey provided, extracts from kid (supports did:key, did:jwk, did:web).
 *
 * @param offer - The JWS signed offer
 * @param publicKey - Optional public key (JWK or KeyLike). If not provided, extracted from kid.
 * @returns The verified payload
 */
export async function verifyOfferSignatureJWS(
  offer: JWSSignedOffer,
  publicKey?: jose.KeyLike | jose.JWK,
): Promise<OfferPayload> {
  if (offer.format !== "jws") {
    throw new Error(`Expected jws format, got ${offer.format}`);
  }
  const key = await resolveVerificationKey(offer.signature, publicKey);
  const { payload } = await jose.compactVerify(offer.signature, key);
  return JSON.parse(new TextDecoder().decode(payload)) as OfferPayload;
}

/**
 * Verify a JWS signed receipt.
 * Does NOT verify signer authorization for the resourceUrl - see spec §4.5.1.
 * If no publicKey provided, extracts from kid (supports did:key, did:jwk, did:web).
 *
 * @param receipt - The JWS signed receipt
 * @param publicKey - Optional public key (JWK or KeyLike). If not provided, extracted from kid.
 * @returns The verified payload
 */
export async function verifyReceiptSignatureJWS(
  receipt: JWSSignedReceipt,
  publicKey?: jose.KeyLike | jose.JWK,
): Promise<ReceiptPayload> {
  if (receipt.format !== "jws") {
    throw new Error(`Expected jws format, got ${receipt.format}`);
  }
  const key = await resolveVerificationKey(receipt.signature, publicKey);
  const { payload } = await jose.compactVerify(receipt.signature, key);
  return JSON.parse(new TextDecoder().decode(payload)) as ReceiptPayload;
}

/**
 * Resolve the verification key for JWS verification
 *
 * @param jws - The JWS compact serialization string
 * @param providedKey - Optional explicit public key
 * @returns The resolved public key
 */
async function resolveVerificationKey(
  jws: string,
  providedKey?: jose.KeyLike | jose.JWK,
): Promise<jose.KeyLike> {
  if (providedKey) {
    if ("kty" in providedKey) {
      const key = await jose.importJWK(providedKey);
      if (key instanceof Uint8Array) {
        throw new Error("Symmetric keys are not supported for JWS verification");
      }
      return key;
    }
    return providedKey;
  }

  const header = extractJWSHeader(jws);
  if (!header.kid) {
    throw new Error("No public key provided and JWS header missing kid");
  }

  return extractPublicKeyFromKid(header.kid);
}
