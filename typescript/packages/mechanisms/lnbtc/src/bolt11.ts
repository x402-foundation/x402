import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { bech32, utils as scure } from "@scure/base";

/**
 * Strictly decoded BOLT11 invoice fields used by the lnbtc scheme.
 */
export interface DecodedInvoice {
  /** BOLT11 currency prefix (e.g. `bc`, `tb`). */
  currency: string;
  /** Invoice amount in millisatoshis. */
  amountMsat: bigint;
  /** Creation time, Unix seconds. */
  timestamp: number;
  /** Expiry in seconds (BOLT11 default 3600 when the `x` field is absent). */
  expirySeconds: number;
  /** Payment hash, 64 lowercase hex characters. */
  paymentHash: string;
  /** Every valid `h` (description hash) field, lowercase hex. */
  descriptionHashes: string[];
  /** Number of `d` (inline description) fields. */
  inlineDescriptionCount: number;
  /** Signing node public key (compressed, lowercase hex), from `n` or recovered. */
  payee: string;
  /** Whether the invoice carried an explicit `n` field. */
  hasPayeeField: boolean;
}

const SIGNATURE_WORDS = 104;
const TIMESTAMP_WORDS = 7;
const DEFAULT_EXPIRY_SECONDS = 3600;
const MSAT_PER_BTC = 100_000_000_000n;

// Multiplier → divisor of the BTC amount in msat.
const MULTIPLIERS: Record<string, bigint> = {
  m: 1_000n, // milli: 1e-3 BTC = 1e8 msat
  u: 1_000_000n,
  n: 1_000_000_000n,
  p: 1_000_000_000_000n,
};

const TAG = { p: 1, s: 16, d: 13, h: 23, x: 6, n: 19, c: 24, features: 5 } as const;

// BOLT11: a reader MUST fail when a fixed-length field has another length.
const FIXED_LENGTHS: ReadonlyMap<number, number> = new Map([
  [TAG.p, 52],
  [TAG.s, 52],
  [TAG.h, 52],
  [TAG.n, 53],
]);

// Fields that may appear at most once; BOLT11 asks for minimal integer encodings.
const SINGLETON_TAGS: ReadonlySet<number> = new Set([
  TAG.p,
  TAG.s,
  TAG.n,
  TAG.x,
  TAG.c,
  TAG.features,
]);
const MINIMAL_TAGS: ReadonlySet<number> = new Set([TAG.x, TAG.c, TAG.features]);

/**
 * Decodes a BOLT11 invoice and verifies its signature.
 *
 * Strict: rejects mixed case, a `lightning:` prefix, a missing or zero amount,
 * sub-millisatoshi amounts, amounts with leading zeros, fixed-length fields of
 * the wrong length or with non-zero padding, duplicated payment hash, payment
 * secret, payee, expiry, CLTV, or feature fields, non-minimal integer fields,
 * a missing payment secret, a high-S signature verified against an `n` field,
 * and an invalid signature.
 *
 * @param invoice - BOLT11 invoice text
 * @returns The decoded invoice
 * @throws Error when the invoice is malformed or its signature is invalid
 */
export function decodeInvoice(invoice: string): DecodedInvoice {
  if (typeof invoice !== "string" || invoice.length === 0) throw new Error("empty invoice");
  const { prefix, words } = bech32.decode(invoice as `${string}1${string}`, false);
  const { currency, amountMsat } = parseHrp(prefix);

  if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) throw new Error("invoice too short");
  const signed = words.slice(0, words.length - SIGNATURE_WORDS);
  const sigBytes = bech32.fromWords(words.slice(words.length - SIGNATURE_WORDS));
  const timestamp = wordsToNumber(signed.slice(0, TIMESTAMP_WORDS));

  const fields = parseTaggedFields(signed.slice(TIMESTAMP_WORDS));
  if (fields.paymentHash === undefined) throw new Error("invoice has no payment hash");
  if (!fields.hasPaymentSecret) throw new Error("invoice has no payment secret");

  const prefixBytes = new TextEncoder().encode(prefix);
  const dataBytes = Uint8Array.from(scure.convertRadix2(signed, 5, 8, true));
  const message = new Uint8Array(prefixBytes.length + dataBytes.length);
  message.set(prefixBytes);
  message.set(dataBytes, prefixBytes.length);

  return {
    currency,
    amountMsat,
    timestamp,
    expirySeconds: fields.expiry ?? DEFAULT_EXPIRY_SECONDS,
    paymentHash: fields.paymentHash,
    descriptionHashes: fields.descriptionHashes,
    inlineDescriptionCount: fields.inlineDescriptions,
    payee: verifySignature(sigBytes, sha256(message), fields.payee),
    hasPayeeField: fields.payee !== undefined,
  };
}

/**
 * Parses the human-readable part into currency and millisatoshi amount.
 *
 * @param prefix - The bech32 human-readable part
 * @returns Currency prefix and amount in millisatoshis
 */
function parseHrp(prefix: string): { currency: string; amountMsat: bigint } {
  const match = /^ln([a-z]+?)([0-9]+)?([munp])?$/.exec(prefix);
  if (!match) throw new Error("invalid invoice prefix");
  const [, currency, digits, multiplier] = match;
  if (!digits) throw new Error("invoice has no amount");
  if (digits.length > 1 && digits.startsWith("0")) throw new Error("amount has leading zeros");
  const value = BigInt(digits);
  if (value === 0n) throw new Error("invoice amount is zero");
  const scaled = value * MSAT_PER_BTC;
  if (!multiplier) return { currency, amountMsat: scaled };
  const divisor = MULTIPLIERS[multiplier];
  if (scaled % divisor !== 0n) throw new Error("amount is not an integral millisatoshi");
  return { currency, amountMsat: scaled / divisor };
}

interface TaggedFields {
  paymentHash?: string;
  hasPaymentSecret: boolean;
  descriptionHashes: string[];
  inlineDescriptions: number;
  payee?: string;
  expiry?: number;
}

/**
 * Reads BOLT11 tagged fields, skipping unknown fields.
 *
 * @param words - 5-bit words after the timestamp, before the signature
 * @returns The fields the scheme consumes
 */
function parseTaggedFields(words: number[]): TaggedFields {
  const out: TaggedFields = {
    hasPaymentSecret: false,
    descriptionHashes: [],
    inlineDescriptions: 0,
  };
  const seen = new Set<number>();
  let i = 0;
  while (i < words.length) {
    if (i + 3 > words.length) throw new Error("truncated tagged field");
    const tag = words[i];
    const length = words[i + 1] * 32 + words[i + 2];
    const data = words.slice(i + 3, i + 3 + length);
    if (data.length !== length) throw new Error("truncated tagged field");
    i += 3 + length;

    const fixedLength = FIXED_LENGTHS.get(tag);
    if (fixedLength !== undefined && length !== fixedLength) {
      throw new Error("tagged field has the wrong length");
    }
    if (SINGLETON_TAGS.has(tag)) {
      if (seen.has(tag)) throw new Error("duplicate tagged field");
      seen.add(tag);
    }
    if (MINIMAL_TAGS.has(tag) && data[0] === 0) throw new Error("non-minimal integer field");

    switch (tag) {
      case TAG.p:
        out.paymentHash = bytesToHex(bech32.fromWords(data));
        break;
      case TAG.s:
        bech32.fromWords(data); // rejects non-zero padding
        out.hasPaymentSecret = true;
        break;
      case TAG.h:
        out.descriptionHashes.push(bytesToHex(bech32.fromWords(data)));
        break;
      case TAG.d:
        out.inlineDescriptions += 1;
        break;
      case TAG.n:
        out.payee = bytesToHex(bech32.fromWords(data));
        break;
      case TAG.x:
        out.expiry = wordsToNumber(data);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Verifies the invoice signature against `n` when present (low-S required, as
 * BOLT11 demands), otherwise recovers the signing key (either S form accepted).
 *
 * @param sigBytes - 65 bytes: compact signature followed by the recovery id
 * @param digest - SHA-256 of the signed invoice bytes
 * @param payeeField - Public key from the `n` field, if present
 * @returns The signing public key, compressed lowercase hex
 */
function verifySignature(sigBytes: Uint8Array, digest: Uint8Array, payeeField?: string): string {
  const recovery = sigBytes[64];
  if (recovery > 3) throw new Error("invalid recovery id");
  const compact = sigBytes.subarray(0, 64);
  if (payeeField !== undefined) {
    const valid = secp256k1.verify(compact, digest, hexToBytes(payeeField), {
      lowS: true,
      format: "compact",
    });
    if (!valid) throw new Error("invalid invoice signature");
    return payeeField;
  }
  // Recovery yields the unique key for which this signature verifies.
  const signature = secp256k1.Signature.fromCompact(compact).addRecoveryBit(recovery);
  return signature.recoverPublicKey(digest).toHex(true);
}

/**
 * Interprets 5-bit words as a big-endian unsigned integer.
 *
 * @param words - 5-bit words
 * @returns The integer value
 */
function wordsToNumber(words: number[]): number {
  let value = 0;
  for (const word of words) {
    value = value * 32 + word;
    if (!Number.isSafeInteger(value)) throw new Error("integer field too large");
  }
  return value;
}
