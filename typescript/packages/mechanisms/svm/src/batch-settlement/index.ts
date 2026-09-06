/**
 * SVM `batch-settlement` scheme: high-throughput channel payments. The client
 * deposits once into a long-lived payment channel and signs cumulative Ed25519
 * vouchers verified off-chain; the operator redeems them on-chain in batches.
 *
 * The top-level export is the client scheme (mirroring `upto`); the server and
 * facilitator implementations are reached via the `./batch-settlement/server`
 * and `./batch-settlement/facilitator` subpaths.
 */

export { BatchSvmScheme } from "./client/scheme";
export * from "./types";
export { BatchError } from "./errors";
export type { BatchErrorReason } from "./errors";
