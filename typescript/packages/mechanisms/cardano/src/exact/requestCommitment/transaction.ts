import {
  AuxiliaryData,
  AuxiliaryDataHash,
  CBOR,
  Transaction,
  TransactionMetadatum,
} from "@evolution-sdk/evolution";
import { blake2b } from "@noble/hashes/blake2.js";

import { decodeCardanoTransactionBytes } from "../../utils";
import { REQUEST_COMMITMENT_METADATA_LABEL, REQUEST_COMMITMENT_PROFILES } from "./binding";

/** The `402` metadatum: `{ "p": profile, "h": 32-byte digest }`. */
export interface RequestCommitmentMetadatum {
  profile: string;
  /** Lowercase hex of the 32-byte digest. */
  hash: string;
}

/**
 * Builds the `402` metadatum value.
 *
 * @param profile - Request binding profile.
 * @param hash - 64-character lowercase hex digest.
 * @returns The transaction metadatum (a map with text keys `p` and `h`).
 */
export function encodeRequestCommitmentMetadatum(
  profile: string,
  hash: string,
): TransactionMetadatum.TransactionMetadatum {
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new Error("Commitment hash must be 32-byte lowercase hex");
  return TransactionMetadatum.map(
    new Map<TransactionMetadatum.TransactionMetadatum, TransactionMetadatum.TransactionMetadatum>([
      ["p", profile],
      ["h", Uint8Array.from(Buffer.from(hash, "hex"))],
    ]),
  );
}

/**
 * Raw on-wire bytes of a transaction's auxiliary data, or undefined when the
 * fourth element of the transaction array is `null`.
 *
 * The bytes are sliced, never re-encoded: `auxiliary_data_hash` is computed by
 * the ledger over exactly these bytes.
 *
 * @param txBytes - Full transaction CBOR.
 * @returns The auxiliary data bytes, if present.
 */
export function extractAuxiliaryDataBytes(txBytes: Uint8Array): Uint8Array | undefined {
  if (txBytes[0] !== 0x84) {
    throw new Error("Transaction must be a definite-length CBOR array of four elements");
  }
  let offset = 1;
  for (let i = 0; i < 3; i++) {
    offset = CBOR.decodeItemWithOffset(txBytes, offset).newOffset;
  }
  const { newOffset } = CBOR.decodeItemWithOffset(txBytes, offset);
  if (newOffset !== txBytes.length) throw new Error("Trailing bytes after the transaction");
  const aux = txBytes.subarray(offset, newOffset);
  return aux.length === 1 && aux[0] === 0xf6 ? undefined : aux;
}

/** Outcome of reading the commitment out of a signed transaction. */
export type CommitmentReadResult =
  | { status: "absent" }
  | { status: "unsigned"; detail: string }
  | { status: "malformed"; detail: string }
  | { status: "present"; metadatum: RequestCommitmentMetadatum };

/**
 * Reads the `402` commitment from a signed transaction.
 *
 * The metadata counts only if the body's `auxiliary_data_hash` equals
 * Blake2b-256 of the auxiliary data bytes: that hash is the only thing the
 * buyer's signature covers. Metadata that is present but not committed by the
 * body is reported as `unsigned`, never as `present`.
 *
 * @param transactionBase64 - Canonical base64 transaction CBOR.
 * @returns What was found.
 */
export function readRequestCommitment(transactionBase64: string): CommitmentReadResult {
  const txBytes = decodeCardanoTransactionBytes(transactionBase64);
  const auxBytes = extractAuxiliaryDataBytes(txBytes);
  const tx = Transaction.fromCBORBytes(txBytes);
  const bodyHash = tx.body.auxiliaryDataHash;

  if (!auxBytes) {
    return bodyHash
      ? {
          status: "unsigned",
          detail: "body commits to auxiliary data the transaction does not carry",
        }
      : { status: "absent" };
  }
  if (!bodyHash) {
    return {
      status: "unsigned",
      detail: "auxiliary data is present but the body does not commit to it",
    };
  }
  const actual = Buffer.from(blake2b(auxBytes, { dkLen: 32 })).toString("hex");
  const committed = Buffer.from(AuxiliaryDataHash.toBytes(bodyHash)).toString("hex");
  if (actual !== committed) {
    return { status: "unsigned", detail: "auxiliary_data_hash does not match the auxiliary data" };
  }

  let metadata: Map<bigint, TransactionMetadatum.TransactionMetadatum> | undefined;
  try {
    metadata = (AuxiliaryData.fromCBORBytes(auxBytes) as { metadata?: typeof metadata }).metadata;
  } catch (e) {
    return {
      status: "malformed",
      detail: `auxiliary data does not decode: ${(e as Error).message}`,
    };
  }
  const value = metadata?.get(REQUEST_COMMITMENT_METADATA_LABEL);
  if (value === undefined) return { status: "absent" };

  if (!(value instanceof Map) || value.size !== 2) {
    return { status: "malformed", detail: "label 402 must be a map with exactly the keys p and h" };
  }
  const p = value.get("p");
  const h = value.get("h");
  if (typeof p !== "string" || !(REQUEST_COMMITMENT_PROFILES as readonly string[]).includes(p)) {
    return { status: "malformed", detail: `unsupported profile ${JSON.stringify(p)}` };
  }
  if (!(h instanceof Uint8Array) || h.length !== 32) {
    return { status: "malformed", detail: "h must be exactly 32 bytes" };
  }
  return { status: "present", metadatum: { profile: p, hash: Buffer.from(h).toString("hex") } };
}
