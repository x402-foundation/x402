/**
 * External-party signing helpers for Canton's JSON Ledger API v2 interactive
 * submission.
 *
 * The external party signs the prepared-transaction HASH BYTES locally with its
 * own Ed25519 key; the participant never sees the key. On `/execute` the
 * signature travels inside a `partySignatures` envelope. This module provides the
 * wire-constant strings and the signing helper; the client signer recomputes the
 * hash from the prepared bytes (see canton-hash.ts) and signs THAT.
 */
import { sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * Constant strings the participant requires for an Ed25519 external party in
 * `Signature.signingAlgorithmSpec` / `Signature.format`. Verified live against
 * Splice and cross-checked against the JSON Ledger API v2 OpenAPI enum.
 */
export const ED25519_WIRE_CONSTANTS = {
  /** For `Signature.signingAlgorithmSpec` when signing with Ed25519. */
  signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
  /**
   * For `Signature.format`. Ed25519 sigs are the concatenated R||S 64-byte form
   * that `node:crypto.sign(null, msg, ed25519Key)` produces by default.
   */
  signatureFormat: "SIGNATURE_FORMAT_CONCAT",
} as const;

/** One signature entry inside `partySignatures[].signatures[]`. */
export interface PartySignatureEntry {
  format: "SIGNATURE_FORMAT_CONCAT";
  /** Base64-encoded raw signature bytes. */
  signature: string;
  /** Algorithm identifier, forwarded verbatim to the participant. */
  signingAlgorithmSpec: string;
  /** Public-key fingerprint identifying which key produced the signature. */
  signedBy: string;
}

/**
 * Sign a base64 prepared-transaction hash with an Ed25519 key, returning the
 * `PartySignatureEntry` shape the JSON Ledger API expects.
 *
 * @param hashBase64 - The prepared-transaction hash to sign, base64-encoded.
 * @param privateKey - The payer's Ed25519 private key.
 * @param fingerprint - The payer's topology fingerprint (the `signedBy` value).
 * @returns The signature entry, with the signature base64-encoded.
 */
export function signPreparedTransactionHash(
  hashBase64: string,
  privateKey: KeyObject,
  fingerprint: string,
): PartySignatureEntry {
  const hashBytes = Buffer.from(hashBase64, "base64");
  // Ed25519 in Node: pass `null` as the digest — Ed25519 hashes internally per
  // RFC 8032.
  const sigBytes = cryptoSign(null, hashBytes, privateKey);
  return {
    format: ED25519_WIRE_CONSTANTS.signatureFormat,
    signature: sigBytes.toString("base64"),
    signingAlgorithmSpec: ED25519_WIRE_CONSTANTS.signingAlgorithmSpec,
    signedBy: fingerprint,
  };
}
