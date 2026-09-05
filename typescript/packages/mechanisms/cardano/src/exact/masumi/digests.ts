import { sha256 } from "@noble/hashes/sha2.js";
import type { PaymentRequirements } from "@x402/core/types";

import type { CardanoExtraMasumi, MasumiInputCommitment, MasumiTerms } from "../../types";
import { jcs } from "./jcs";

/**
 * Domain separator prefixing the canonical commitment manifest.
 */
const INPUT_HASH_DOMAIN = "masumi:x402:input:v1\n";

/**
 * Domain separator prefixing the canonical signed terms.
 */
const TERMS_DIGEST_DOMAIN = "masumi:x402:terms:v1\n";

const encoder = new TextEncoder();

/**
 * `SHA-256(UTF-8(domain) || UTF-8(JCS(value)))` as lowercase hex — the shape
 * both Masumi digests share.
 *
 * @param domain - The domain-separation prefix, including its trailing newline.
 * @param value - The JSON value to canonicalize.
 * @returns The lowercase hex digest.
 */
function domainDigest(domain: string, value: unknown): string {
  const body = encoder.encode(jcs(value));
  const prefix = encoder.encode(domain);
  const buffer = new Uint8Array(prefix.length + body.length);
  buffer.set(prefix, 0);
  buffer.set(body, prefix.length);
  return toHex(sha256(buffer));
}

/**
 * Lowercase hex of a byte array.
 *
 * @param bytes - The bytes to encode.
 * @returns The lowercase hex string.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decodes an unpadded base64url string into bytes.
 *
 * @param value - The unpadded base64url text.
 * @returns The decoded bytes.
 * @throws When the text is not valid base64url.
 */
function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("Commitment raw content is not unpadded base64url");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(base64, "base64");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Commitment raw content is not canonical unpadded base64url");
  }
  return Uint8Array.from(decoded);
}

/**
 * Serializes one commitment part to the bytes its `digest` covers:
 * `UTF-8(RFC8785-JCS(content))` for `jcs`, `base64url-decode(content)` for `raw`.
 *
 * @param part - The commitment part, which MUST carry `content`.
 * @param part.canonicalization - How `content` becomes bytes.
 * @param part.content - The content to serialize.
 * @returns The part bytes.
 * @throws When `content` is absent or malformed for the declared canonicalization.
 */
export function commitmentPartBytes(part: {
  canonicalization: "jcs" | "raw";
  content?: unknown;
}): Uint8Array {
  if (part.content === undefined) {
    throw new Error("Commitment part carries no content to digest");
  }
  if (part.canonicalization === "raw") {
    if (typeof part.content !== "string") {
      throw new Error("Commitment raw content must be an unpadded base64url string");
    }
    return base64UrlDecode(part.content);
  }
  return encoder.encode(jcs(part.content));
}

/**
 * Lowercase hex SHA-256 of a commitment part's bytes.
 *
 * @param part - The commitment part, which MUST carry `content`.
 * @param part.canonicalization - How `content` becomes bytes.
 * @param part.content - The content to serialize.
 * @returns The lowercase hex digest.
 */
export function commitmentPartDigest(part: {
  canonicalization: "jcs" | "raw";
  content?: unknown;
}): string {
  return toHex(sha256(commitmentPartBytes(part)));
}

/**
 * Recomputes `inputCommitment.digest` from the commitment's **manifest** — the
 * commitment with every part's `content` and the top-level `digest` omitted
 * (not nulled). Because the manifest excludes `content` by construction, a part
 * whose content the issuer left off the wire does not change the result.
 *
 * @param commitment - The declared input commitment.
 * @returns The lowercase hex `inputHash`.
 */
export function computeInputHash(commitment: MasumiInputCommitment): string {
  const manifest = {
    version: commitment.version,
    algorithm: commitment.algorithm,
    parts: commitment.parts.map(part => ({
      name: part.name,
      canonicalization: part.canonicalization,
      mediaType: part.mediaType,
      digest: part.digest,
    })),
  };
  return domainDigest(INPUT_HASH_DOMAIN, manifest);
}

/**
 * The seller-signed terms object: `terms` plus the seven fields projected from
 * the top-level `PaymentRequirements`.
 *
 * This member list is normative for this scheme version — `termsDigest` is only
 * reproducible when both sides agree on it exactly, so changing it is a
 * breaking change to the scheme rather than an implementation detail.
 */
export type MasumiSignedTerms = MasumiTerms & {
  scheme: string;
  assetTransferMethod: string;
  network: string;
  contractAddress: string;
  amount: string;
  asset: string;
  maxTimeoutSeconds: number;
};

/**
 * Reconstructs `signedTerms` from the terms and the requirements they were
 * issued against.
 *
 * `terms` is spread verbatim: an `agentIdentifier` that is absent, `null` or
 * empty selects the same identity mode but stays a different signed wire value,
 * so it must not be omitted, inserted or replaced here.
 *
 * @param extra - The masumi `extra` block.
 * @param requirements - The canonical payment requirements.
 * @returns The signed terms object.
 */
export function buildSignedTerms(
  extra: CardanoExtraMasumi,
  requirements: PaymentRequirements,
): MasumiSignedTerms {
  return {
    ...extra.terms,
    scheme: requirements.scheme,
    assetTransferMethod: extra.assetTransferMethod,
    network: requirements.network,
    contractAddress: requirements.payTo,
    amount: requirements.amount,
    asset: requirements.asset,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
  };
}

/**
 * Computes the `termsDigest` the seller authorizes with CIP-30 `signData`.
 *
 * @param signedTerms - The reconstructed signed terms.
 * @returns The lowercase hex digest.
 */
export function computeTermsDigest(signedTerms: MasumiSignedTerms): string {
  return domainDigest(TERMS_DIGEST_DOMAIN, signedTerms);
}
