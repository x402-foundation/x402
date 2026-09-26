/* ════════════════════════════════════════════════════════════════════════
 * PAYER PROOF — verify a payer's inline TransferFactory_Transfer signature.
 *
 *   A. HASH BINDING — recompute the Canton hash from the decoded prepared bytes
 *      and compare it to the hash the payload claims. Uses the same conformant
 *      recompute the payer signs with (canton-hash.ts → core-tx-visualizer). A
 *      recompute that fails proves nothing and never falls back to the claim.
 *
 *   B. SIGNATURE — verify the payer's Ed25519 signature over that recomputed
 *      hash. The key comes from a synchronizer topology read (does NOT require
 *      our participant to host the party). Absence of the key source FAILS
 *      CLOSED — an inline payment does not settle rather than settling
 *      half-checked. Hash binding alone (A) removes the case where a claimed hash
 *      describes a different transaction from the one shipped, but only B proves
 *      authorship, which is why B is not optional.
 *
 * Ported from the production facilitator's payer-proof, adapted to this
 * package's local canton-hash.
 * ════════════════════════════════════════════════════════════════════════ */
import { createPublicKey, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import { recomputeHash } from "./canton-hash.js";

/**
 * Reads an external party's Ed25519 signing keys (DER SubjectPublicKeyInfo) from
 * synchronizer topology. An empty array means we learned nothing — unknown party,
 * or a participant too old to serve the route — and callers must treat it as
 * "cannot verify".
 */
export type PayerSigningKeyLookup = (party: string) => Promise<Buffer[]>;

/** What a verification proved, so the caller never re-derives it. */
export interface PayerProofResult {
  verified: boolean;
  /** The hash this module recomputed from the bytes and matched (canonical). */
  preparedTxHashHex?: string;
  /** How many usable protocol signing keys topology published for this payer. */
  publishedProtocolKeys?: number;
}

/** Options for {@link createPayerProofVerifier}. */
export interface PayerProofOptions {
  fetchPayerSigningKey?: PayerSigningKeyLookup;
}

/** Input to a payer-proof verification. */
export interface PayerProofInput {
  preparedTransactionBytes: Buffer;
  claimedPreparedTxHash: string;
  signatureB64: string;
  payer: string;
  hashingSchemeVersion: string;
}

/**
 * Reduce a Canton hash to ONE spelling: the bare 64-char lower-case digest. A
 * prepared-transaction hash comes back as 32 raw bytes, while topology hashes
 * carry the `1220` multihash prefix; a client may send either spelling of the
 * same hash, so both reduce before comparison. Disambiguate by LENGTH, not by
 * prefix — a bare digest whose first two bytes are 0x12 0x20 also "starts with
 * 1220", and stripping four chars would refuse a valid signature.
 *
 * @param hex - The claimed hash, hex-encoded, possibly `1220`-framed.
 * @returns The bare 64-char digest, or null when not a valid hash.
 */
export function canonicalTxHashHex(hex: string): string | null {
  const lower = hex.trim().toLowerCase();
  const body = lower.length === 68 && lower.startsWith("1220") ? lower.slice(4) : lower;
  if (!/^[0-9a-f]{64}$/.test(body)) return null;
  return body;
}

/**
 * Decode a claimed hash to its 32 digest bytes, or null when not a valid hash.
 *
 * @param hex - The claimed hash, hex-encoded.
 * @returns The 32 digest bytes, or null.
 */
export function digestBytes(hex: string): Buffer | null {
  const body = canonicalTxHashHex(hex);
  return body === null ? null : Buffer.from(body, "hex");
}

/** DER SPKI header for an Ed25519 public key; the raw 32 bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Wrap a raw 32-byte Ed25519 public key as DER SubjectPublicKeyInfo, the form
 * {@link createPayerProofVerifier} verifies against. A key that is not 32 bytes
 * is returned unchanged (already DER, or unusable — the verifier filters it).
 *
 * @param key - A raw 32-byte Ed25519 point, or an already-DER key.
 * @returns The DER SPKI encoding (or the input unchanged if not 32 bytes).
 */
export function rawEd25519ToDerSpki(key: Buffer): Buffer {
  if (key.length !== 32) return key;
  return Buffer.concat([ED25519_SPKI_PREFIX, key]);
}

/**
 * Build the verifier the inline arm calls. Returns `{verified:false}` — never
 * throws for a bad proof — so the caller's single "did it verify" question has a
 * single answer.
 *
 * @param opts - The payer signing-key lookup.
 * @returns A verifier from {@link PayerProofInput} to {@link PayerProofResult}.
 */
export function createPayerProofVerifier(
  opts: PayerProofOptions = {},
): (input: PayerProofInput) => Promise<PayerProofResult> {
  const NO: PayerProofResult = { verified: false };
  return async input => {
    // Only V2 is produced by the participants we relay for; an unknown scheme is
    // refused rather than assumed (a wrong guess yields a non-matching hash).
    if (input.hashingSchemeVersion !== "HASHING_SCHEME_VERSION_V2") return NO;

    const claimed = digestBytes(input.claimedPreparedTxHash);
    if (!claimed) return NO;

    // ── A. hash binding ────────────────────────────────────────────────────
    let recomputed: Buffer;
    try {
      recomputed = Buffer.from(
        await recomputeHash(input.preparedTransactionBytes.toString("base64")),
        "base64",
      );
    } catch {
      return NO;
    }
    if (recomputed.length !== claimed.length) return NO;
    if (!timingSafeEqual(recomputed, claimed)) return NO;

    // ── B. signature over that hash ────────────────────────────────────────
    if (!opts.fetchPayerSigningKey) return NO;

    let published: Buffer[];
    try {
      published = await opts.fetchPayerSigningKey(input.payer);
    } catch {
      // A lookup that failed is "cannot verify", never "no keys, so accept".
      return NO;
    }
    // Canton publishes an X.509 SubjectPublicKeyInfo. Pin the exact Ed25519 SPKI
    // header rather than trusting a type claim: a different-algorithm key
    // reaching an Ed25519 verify is a category error, and the 44-byte length
    // falls out of the same check.
    const usable = published.filter(
      der =>
        der.length === ED25519_SPKI_PREFIX.length + 32 &&
        der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX),
    );
    if (usable.length === 0) return NO;

    let signature: Buffer;
    try {
      signature = Buffer.from(input.signatureB64, "base64");
    } catch {
      return NO;
    }
    if (signature.length !== 64) return NO;

    const keyCount = usable.length;
    for (const der of usable) {
      try {
        const key = createPublicKey({ key: der, format: "der", type: "spki" });
        // Ed25519 signs the message directly, so the algorithm argument is null
        // and the "message" is the recomputed digest the payer signed.
        if (cryptoVerify(null, recomputed, key, signature)) {
          return {
            verified: true,
            preparedTxHashHex: recomputed.toString("hex"),
            publishedProtocolKeys: keyCount,
          };
        }
      } catch {
        /* try the next key */
      }
    }
    return NO;
  };
}
