import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

import type { MasumiCommitmentPart, MasumiInputCommitment } from "../../types";
import { commitmentPartDigest, computeInputHash } from "../masumi/digests";

/** Extension key carried in `PaymentRequired.extensions` and `PaymentPayload.extensions`. */
export const CARDANO_REQUEST_COMMITMENT = "cardano-request-commitment";

/** CIP-10 transaction metadata label carrying the commitment. */
export const REQUEST_COMMITMENT_METADATA_LABEL = 402n;

/** Request binding profiles. Only `http:1` is implemented; `mcp:1` is reserved. */
export const REQUEST_COMMITMENT_PROFILES = ["http:1"] as const;
export type RequestCommitmentProfile = (typeof REQUEST_COMMITMENT_PROFILES)[number];

/** Name of the mandatory commitment part that carries the request binding. */
export const REQUEST_PART_NAME = "request";

/** Name of the commitment part that carries the client's salt. */
export const SALT_PART_NAME = "salt";

/**
 * Domain member of the binding object. Same structure and rules as the `http:1`
 * binding of `scheme_exact_lnbtc.md`, with a Cardano-specific domain so a
 * binding can never be replayed across rails.
 */
export const HTTP_BINDING_DOMAIN = "x402:exact:cardano:request-commitment:http:1";

/** The `http:1` binding object: exactly these members. */
export interface HttpRequestBinding {
  domain: string;
  method: string;
  url: string;
  bodyHash: string;
  headers: Array<{ name: string; valueHash: string }>;
}

/** A request as seen by whichever side computes the binding. */
export interface HttpRequestDescription {
  /** HTTP method, case preserved. */
  method: string;
  /** Absolute http(s) target URI, query included, no fragment or user information. */
  url: string;
  /** Content bytes after transfer decoding. Absent or empty means no body. */
  body?: Uint8Array;
  /** Header values by lowercase name. Only bound headers are read. */
  headers: Record<string, string | undefined>;
}

const encoder = new TextEncoder();
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const HEX_32 = /^[0-9a-f]{64}$/;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Validates a configured bound-header list: lowercase field-name tokens, strictly
 * ascending ASCII order (which also excludes duplicates), never `payment-signature`.
 *
 * @param headers - Configured header names.
 * @returns The same list.
 * @throws When the list breaks any rule.
 */
export function validateBoundHeaders(headers: readonly string[]): string[] {
  for (let i = 0; i < headers.length; i++) {
    const name = headers[i];
    if (typeof name !== "string" || !HEADER_NAME.test(name)) {
      throw new Error(`Bound header ${JSON.stringify(name)} is not a lowercase field-name token`);
    }
    if (name === "payment-signature") {
      throw new Error("payment-signature must not be a bound header");
    }
    if (i > 0 && !(headers[i - 1] < name)) {
      throw new Error("Bound headers must be in strictly ascending ASCII order");
    }
  }
  return [...headers];
}

/**
 * Validates an `http:1` target URI: absolute http(s), ASCII only, no fragment,
 * no user information. The string is used exactly as given (no normalization).
 *
 * @param url - Candidate target URI.
 * @returns The same string.
 * @throws When the URI breaks any rule.
 */
export function validateTargetUri(url: string): string {
  if (!/^[\x21-\x7e]+$/.test(url)) throw new Error("Target URI must be printable ASCII");
  if (url.includes("#")) throw new Error("Target URI must not carry a fragment");
  const match = /^(https?):\/\/([^/?]*)/i.exec(url);
  if (!match) throw new Error("Target URI must be an absolute http or https URL");
  if (match[2].length === 0) throw new Error("Target URI must carry an authority");
  if (match[2].includes("@")) throw new Error("Target URI must not carry user information");
  return url;
}

/**
 * Header value per RFC 9421 §2.1 for a single-valued field: leading and trailing
 * whitespace removed, ASCII only.
 *
 * @param value - Raw header value.
 * @returns The component value.
 * @throws When the value contains non-ASCII or control characters.
 */
function headerComponentValue(value: string): string {
  const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!/^[\x20-\x7e\t]*$/.test(trimmed)) {
    throw new Error("Bound header values must be ASCII without control characters");
  }
  return trimmed;
}

/**
 * Builds the `http:1` binding object for a request.
 *
 * `bodyHash` is SHA-256 of the content bytes; `valueHash` is SHA-256 of
 * `0x01 || ASCII(value)` for a present header and of `0x00` for an absent one.
 *
 * @param request - The request.
 * @param boundHeaders - Header names to bind, from the server's configuration.
 * @returns The binding object.
 */
export function buildHttpBinding(
  request: HttpRequestDescription,
  boundHeaders: readonly string[],
): HttpRequestBinding {
  if (
    typeof request.method !== "string" ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(request.method)
  ) {
    throw new Error("HTTP method must be a token");
  }
  const headers = validateBoundHeaders(boundHeaders).map(name => {
    const raw = request.headers[name];
    const valueHash =
      raw === undefined
        ? hex(sha256(Uint8Array.of(0x00)))
        : hex(sha256(new Uint8Array([0x01, ...encoder.encode(headerComponentValue(raw))])));
    return { name, valueHash };
  });
  return {
    domain: HTTP_BINDING_DOMAIN,
    method: request.method,
    url: validateTargetUri(request.url),
    bodyHash: hex(sha256(request.body ?? new Uint8Array())),
    headers,
  };
}

/**
 * The `request` commitment part for a binding. `content` is omitted: both sides
 * derive it from the request itself, and the manifest excludes content anyway.
 *
 * @param binding - The binding object.
 * @returns The commitment part.
 */
export function requestPart(binding: HttpRequestBinding): MasumiCommitmentPart {
  return {
    name: REQUEST_PART_NAME,
    canonicalization: "jcs",
    digest: commitmentPartDigest({ canonicalization: "jcs", content: binding }),
  };
}

/**
 * Checks a salt: exactly 32 bytes as 64 lowercase hex characters.
 *
 * @param salt - Candidate salt.
 * @returns The same salt.
 * @throws When the salt is not 64 lowercase hex characters.
 */
export function validateSalt(salt: unknown): string {
  if (typeof salt !== "string" || !HEX_32.test(salt)) {
    throw new Error("Request commitment salt must be 32 bytes of lowercase hex");
  }
  return salt;
}

/**
 * Fresh 32-byte salt from a cryptographically secure source.
 *
 * @returns 64 lowercase hex characters.
 */
export function randomSalt(): string {
  return hex(randomBytes(32));
}

/**
 * The `salt` commitment part. Its content is the salt as a JSON string, so its
 * digest is SHA-256 of `UTF8(JCS(salt))`, the same rule as any other `jcs` part.
 * Like the request part, it carries no `content`: the server learns the salt
 * from the payment payload, never from the chain.
 *
 * @param salt - 64 lowercase hex characters.
 * @returns The commitment part.
 */
export function saltPart(salt: string): MasumiCommitmentPart {
  return {
    name: SALT_PART_NAME,
    canonicalization: "jcs",
    digest: hex(sha256(encoder.encode(JSON.stringify(validateSalt(salt))))),
  };
}

/**
 * Builds the full commitment (Masumi `inputCommitment` construction) whose
 * first part is the request binding.
 *
 * Without a salt this is the commitment the server publishes in the 402: one
 * `request` part. With a salt it is the commitment the buyer signs into the
 * transaction: the `request` part followed by a `salt` part.
 *
 * @param binding - The request binding.
 * @param salt - The buyer's salt, for the on-chain commitment.
 * @returns The commitment with its digest.
 */
export function buildRequestCommitment(
  binding: HttpRequestBinding,
  salt?: string,
): MasumiInputCommitment {
  const commitment: MasumiInputCommitment = {
    version: "1",
    algorithm: "sha256",
    parts: salt === undefined ? [requestPart(binding)] : [requestPart(binding), saltPart(salt)],
    digest: "",
  };
  commitment.digest = computeInputHash(commitment);
  return commitment;
}

/**
 * Checks that a declared commitment is exactly the one the caller derives from
 * its own view of the request, part for part, and that its digest recomputes.
 *
 * @param declared - The commitment received from the counterparty.
 * @param binding - The binding derived locally.
 * @returns Why it does not match, or undefined when it matches.
 */
export function commitmentMismatch(
  declared: MasumiInputCommitment,
  binding: HttpRequestBinding,
): string | undefined {
  const expected = buildRequestCommitment(binding);
  if (declared.version !== "1" || declared.algorithm !== "sha256") {
    return "unsupported commitment version or algorithm";
  }
  if (!Array.isArray(declared.parts) || declared.parts.length !== expected.parts.length) {
    return "commitment parts differ from the request binding";
  }
  const part = declared.parts[0];
  if (
    part.name !== REQUEST_PART_NAME ||
    part.canonicalization !== "jcs" ||
    part.mediaType !== undefined ||
    part.digest !== expected.parts[0].digest
  ) {
    return "request part does not match this request";
  }
  if (!HEX_32.test(declared.digest) || computeInputHash(declared) !== declared.digest) {
    return "commitment digest does not recompute";
  }
  if (declared.digest !== expected.digest) return "commitment digest does not match this request";
  return undefined;
}
