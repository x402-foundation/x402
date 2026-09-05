/* ════════════════════════════════════════════════════════════════════════
 * INLINE PAYMENT PAYLOAD — the `exact` scheme's wire form for Canton.
 *
 * The scheme carries the payer-signed transaction itself in the payload:
 *
 *   { assetTransferMethod: "transfer-factory",
 *     preparedTransaction: base64(gzip(prepared TransferFactory_Transfer)),
 *     preparedTxHash:      hex hash of the prepared tx the payer signed,
 *     signature:           base64 ed25519 over preparedTxHash,
 *     hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" | "..._V2" }
 *
 * This replaces `submissionRef`, an opaque pointer into ONE facilitator's
 * stash. A pointer forces the payer and the merchant onto the same
 * facilitator, which the protocol does not allow: the merchant picks the
 * facilitator and the payer never learns which one. Inline is self-contained,
 * so any facilitator can relay it.
 *
 * WHAT THIS MODULE DOES AND DELIBERATELY DOES NOT DO. It performs every check
 * that needs no Canton cryptography: presence, canonical encoding, size bounds,
 * and gzip framing. It does NOT verify the signature and does NOT confirm that
 * `preparedTxHash` is really the hash of the bytes — both need the Canton
 * hasher and the payer's key. Until a caller does that, the hash is an
 * unverified claim by whoever sent the payload, which is why it is returned
 * under the name `claimedPreparedTxHash`: mistaking it for a checked value is
 * the single easiest way to make this whole path meaningless, so the type makes
 * that mistake visible at the call site.
 *
 * WHY CANONICAL ENCODING IS ENFORCED, not just decodability. Buffer.from(s,
 * "base64") silently ignores characters outside the base64 alphabet, so
 * "AAAA", "AA!AA" and "AAAA\n" all decode to the same bytes. That would let one
 * payment be expressed as unlimited distinct wire strings — and any dedupe,
 * idempotency or rate-limit key derived from the string form would see each as
 * new while the ledger sees one. So both encoded fields must round-trip back to
 * exactly the bytes they came in as.
 * ════════════════════════════════════════════════════════════════════════ */
import {
  decodeInlinePayload,
  encodeInlinePayload,
  InlineCodecError,
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  type InlineDecodeOptions,
} from "./inline-codec.js";

/** The Canton hashing schemes the scheme admits. V2 is the default. */
export const HASHING_SCHEME_VERSIONS = [
  "HASHING_SCHEME_VERSION_V1",
  "HASHING_SCHEME_VERSION_V2",
] as const;
export type HashingSchemeVersion = (typeof HASHING_SCHEME_VERSIONS)[number];
export const DEFAULT_HASHING_SCHEME_VERSION: HashingSchemeVersion = "HASHING_SCHEME_VERSION_V2";

/** The two scheme error codes this module can produce. Kept as a literal union
 *  so a caller cannot answer with a code the scheme does not define. */
export type InlinePayloadErrorCode =
  | "invalid_exact_canton_missing_proof"
  | "invalid_exact_canton_malformed_payload";

/**
 *
 */
export class InlinePayloadError extends Error {
  readonly code: InlinePayloadErrorCode;
  /**
   *
   * @param code
   * @param reason
   */
  constructor(code: InlinePayloadErrorCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "InlinePayloadError";
    this.code = code;
  }
}

/**
 * An Ed25519 signature is 64 raw bytes → 88 base64 chars. The cap leaves room
 * for other signing algorithms without leaving the field unbounded: before
 * this, `signature` was constrained only by the 8 MiB request body limit, so a
 * single field could carry megabytes of attacker data into every downstream
 * log line and key.
 */
export const MAX_SIGNATURE_B64_CHARS = 256;
/** multihash-sha2-256 is 34 bytes → 68 hex chars. */
export const MAX_PREPARED_TX_HASH_CHARS = 128;

export interface InlinePayloadDecodeOptions extends InlineDecodeOptions {
  /** Cap on the base64 text itself. Defaults to the exact base64 expansion of
   *  `maxCompressedBytes`, so the string is refused before it is decoded —
   *  bounding memory a step earlier than the gzip cap would. */
  maxPreparedTransactionB64Chars?: number;
}

/** What a caller gets back: bytes it may decode, plus two values it must still
 *  verify itself. */
export interface DecodedInlinePayload {
  /** The prepared transaction, decompressed. Bounded by the codec's caps. */
  preparedTransactionBytes: Buffer;
  /** UNVERIFIED. The sender's claim about the hash it signed. A caller MUST
   *  recompute the hash from `preparedTransactionBytes` and compare, then
   *  verify `signatureB64` against the proven payer over it. */
  claimedPreparedTxHash: string;
  /** Base64 Ed25519 signature over the prepared-tx hash. The facilitator wraps
   *  this into the ledger's nested `partySignatures` for the proven payer:
   *  `signedBy` is the payer party's own namespace fingerprint, which is why
   *  flattening to a single string loses nothing. */
  signatureB64: string;
  hashingSchemeVersion: HashingSchemeVersion;
}

const HEX_RE = /^[0-9a-f]+$/;

/**
 *
 * @param bytes
 */
function base64Expansion(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 *
 * @param value
 * @param field
 * @param code
 */
function requireString(value: unknown, field: string, code: InlinePayloadErrorCode): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InlinePayloadError(code, `${field} is missing or not a string`);
  }
  return value;
}

/**
 * Decode base64 and prove the input was the canonical encoding of the result.
 *
 * @param value
 * @param field
 */
function decodeCanonicalBase64(value: string, field: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    // This ONE comparison is the whole check. Re-encoding only ever emits
    // canonical base64, so equality proves the input was canonical too: a
    // foreign alphabet (base64url), embedded whitespace, wrong padding, and
    // trailing bits set in the final character all fail it. An additional
    // alphabet regex was removed after mutation testing showed it could be
    // deleted with every test still passing — a guard nothing can prove is a
    // guard that hides the failure of the one doing the work.
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      `${field} is not canonical base64`,
    );
  }
  return bytes;
}

/**
 * Structurally decode an inline payload. Throws `InlinePayloadError` carrying
 * the scheme error code the caller should answer with.
 *
 * Order matters and is deliberate: presence (so a payload with no proof at all
 * is reported as missing, not malformed), then cheap string bounds, then the
 * expensive decompression last.
 *
 * @param payload
 * @param opts
 */
export function decodeInlinePaymentPayload(
  payload: unknown,
  opts: InlinePayloadDecodeOptions = {},
): DecodedInlinePayload {
  if (typeof payload !== "object" || payload === null) {
    throw new InlinePayloadError("invalid_exact_canton_missing_proof", "payload is not an object");
  }
  const p = payload as Record<string, unknown>;

  // Rule 2: all three of preparedTransaction / preparedTxHash / signature MUST
  // be present, else missing_proof.
  const preparedTransaction = requireString(
    p["preparedTransaction"],
    "preparedTransaction",
    "invalid_exact_canton_missing_proof",
  );
  const preparedTxHash = requireString(
    p["preparedTxHash"],
    "preparedTxHash",
    "invalid_exact_canton_missing_proof",
  );
  const signature = requireString(
    p["signature"],
    "signature",
    "invalid_exact_canton_missing_proof",
  );

  const maxCompressed = opts.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES;
  const maxB64 = opts.maxPreparedTransactionB64Chars ?? base64Expansion(maxCompressed);
  if (preparedTransaction.length > maxB64) {
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      `preparedTransaction is ${preparedTransaction.length} chars, over the ${maxB64}-char cap`,
    );
  }
  if (signature.length > MAX_SIGNATURE_B64_CHARS) {
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      `signature is ${signature.length} chars, over the ${MAX_SIGNATURE_B64_CHARS}-char cap`,
    );
  }
  if (preparedTxHash.length > MAX_PREPARED_TX_HASH_CHARS) {
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      `preparedTxHash is ${preparedTxHash.length} chars, over the ${MAX_PREPARED_TX_HASH_CHARS}-char cap`,
    );
  }

  // Lower-case hex only. Accepting mixed case would make the same hash two
  // distinct strings, and anything keyed on it would double-count.
  const normalizedHash = preparedTxHash.toLowerCase();
  if (normalizedHash !== preparedTxHash || !HEX_RE.test(normalizedHash)) {
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      "preparedTxHash is not lower-case hex",
    );
  }
  if (normalizedHash.length % 2 !== 0) {
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      "preparedTxHash has an odd number of hex digits",
    );
  }

  // Validated for canonical form; the bytes themselves are checked by whoever
  // verifies the signature.
  decodeCanonicalBase64(signature, "signature");

  const rawHashingScheme = p["hashingSchemeVersion"];
  let hashingSchemeVersion: HashingSchemeVersion;
  if (rawHashingScheme === undefined) {
    hashingSchemeVersion = DEFAULT_HASHING_SCHEME_VERSION;
  } else if (rawHashingScheme === "HASHING_SCHEME_VERSION_V2") {
    hashingSchemeVersion = rawHashingScheme;
  } else if (rawHashingScheme === "HASHING_SCHEME_VERSION_V1") {
    // The scheme admits V1, and we cannot verify it: the conformant recompute
    // we have implements V2 only. Refusing HERE, at decode, is the honest
    // answer — accepting the field and then failing at the signature gate would
    // report a hash-scheme we never supported as a bad signature, sending an
    // integrator to debug their key.
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      "HASHING_SCHEME_VERSION_V1 is not supported by this facilitator",
    );
  } else {
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      "hashingSchemeVersion is not a known Canton hashing scheme",
    );
  }

  const gz = decodeCanonicalBase64(preparedTransaction, "preparedTransaction");
  let preparedTransactionBytes: Buffer;
  try {
    preparedTransactionBytes = decodeInlinePayload(gz, {
      maxCompressedBytes: maxCompressed,
      maxDecompressedBytes: opts.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES,
    });
  } catch (err) {
    if (err instanceof InlineCodecError) {
      throw new InlinePayloadError("invalid_exact_canton_malformed_payload", err.message);
    }
    throw err;
  }
  if (preparedTransactionBytes.length === 0) {
    throw new InlinePayloadError(
      "invalid_exact_canton_malformed_payload",
      "preparedTransaction decodes to no bytes",
    );
  }

  return {
    preparedTransactionBytes,
    claimedPreparedTxHash: normalizedHash,
    signatureB64: signature,
    hashingSchemeVersion,
  };
}

export interface EncodeInlinePaymentPayloadInput {
  preparedTransactionBytes: Uint8Array;
  preparedTxHash: string;
  signatureB64: string;
  hashingSchemeVersion?: HashingSchemeVersion;
}

/** Wire form of the payload, as the scheme defines it. */
export interface InlinePaymentPayloadWire {
  assetTransferMethod: "transfer-factory";
  preparedTransaction: string;
  preparedTxHash: string;
  signature: string;
  hashingSchemeVersion: HashingSchemeVersion;
}

/**
 * Build the wire payload. Emits the hash lower-cased so that what we send is
 * already in the canonical form our own decoder demands — a producer and a
 * verifier that disagree on canonicalisation is a self-inflicted outage.
 *
 * @param input
 */
export function encodeInlinePaymentPayload(
  input: EncodeInlinePaymentPayloadInput,
): InlinePaymentPayloadWire {
  // The wire form is HEX, and Canton hands its callers BASE64 — that mismatch
  // silently produced payloads no facilitator could decode, because the encoder
  // only lower-cased whatever it was given. Refusing here turns a wire-format
  // error into a loud failure at the PRODUCER, where the fix is, instead of an
  // opaque `malformed_payload` at somebody else's facilitator.
  const hex = input.preparedTxHash.toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(
      `preparedTxHash must be hex; got ${JSON.stringify(input.preparedTxHash)}. ` +
        `Canton returns this value BASE64 — convert with ` +
        `Buffer.from(hash, "base64").toString("hex").`,
    );
  }
  return {
    assetTransferMethod: "transfer-factory",
    preparedTransaction: encodeInlinePayload(input.preparedTransactionBytes).toString("base64"),
    preparedTxHash: hex,
    signature: input.signatureB64,
    hashingSchemeVersion: input.hashingSchemeVersion ?? DEFAULT_HASHING_SCHEME_VERSION,
  };
}
