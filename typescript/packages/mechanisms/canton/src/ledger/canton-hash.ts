/**
 * canton-hash — the OFFICIAL Canton prepared-transaction hash recompute, wired so
 * a payer's Ed25519 signature is cryptographically bound to the bytes it verified,
 * and so the facilitator recomputes the SAME hash from the submitted bytes.
 *
 * The recompute delegates to the published, Apache-2.0
 * `@canton-network/core-tx-visualizer` — the same code the rest of the Canton
 * wallet ecosystem signs with — so the bytes-exact V2 hashing algorithm is the
 * library's concern, not a hand-reimplementation's. We deliberately do NOT use
 * the SDK's `sign()`: it signs a caller-supplied hash directly with no
 * recompute/compare, which would reproduce a blind-sign bug. We use the library
 * only for HASHING and keep compare-then-sign (client) / recompute-then-verify
 * (facilitator) in this package.
 */
import { hashPreparedTransaction } from "@canton-network/core-tx-visualizer";

/**
 * Recompute the prepared-transaction signing hash (Canton
 * HASHING_SCHEME_VERSION_V2) from the base64 `preparedTransaction` the
 * participant returns from `/v2/interactive-submission/prepare`, returned base64.
 *
 * This is the Merkle hash over the Daml transaction node tree, returned as the
 * raw 32 bytes (NOT multihash-framed), base64-encoded — exactly what the
 * participant returns as `preparedTransactionHash`. Compare base64-to-base64 and
 * sign the RECOMPUTED value.
 *
 * @param preparedTransactionB64 - The base64 prepared transaction.
 * @returns The recomputed hash, base64-encoded.
 */
export function recomputeHash(preparedTransactionB64: string): Promise<string> {
  return hashPreparedTransaction(preparedTransactionB64, "base64");
}
