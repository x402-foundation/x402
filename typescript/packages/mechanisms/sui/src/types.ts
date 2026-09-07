import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";

/**
 * Exact Sui payload: a fully signed, ready-to-broadcast transaction.
 */
export type ExactSuiPayload = {
  /**
   * Base64-encoded BCS transaction bytes.
   */
  transaction: string;
  /**
   * Base64-encoded serialized signature(s) over the transaction bytes. A single
   * string is the sole sender signature; an array carries multiple required
   * signers (e.g. a sponsored transaction whose sponsor is a distinct signer).
   */
  signature: string | string[];
};

/**
 * The result of a {@link SuiExecutor}: the submitted transaction, an on-chain
 * failure, or a policy rejection. Balance changes need not be included — the
 * facilitator reads them from `waitForTransaction`.
 */
export type SuiExecutorResult =
  | { $kind: "Transaction"; Transaction: SuiClientTypes.Transaction }
  | { $kind: "FailedTransaction"; FailedTransaction: SuiClientTypes.Transaction }
  | { $kind: "Rejected"; reason?: string; issues?: ReadonlyArray<{ message?: string }> };

/**
 * A pluggable executor settlement is delegated to. It receives the signed bytes
 * and the user signatures, submits (or delegates submission — a gas sponsor, for
 * example, co-signs under its own policy), and returns the submitted transaction,
 * an on-chain failure, or a rejection. When no executor is configured, the
 * facilitator broadcasts directly via the network client. The facilitator then
 * waits for finality and reads balance changes from the finalized transaction.
 */
export type SuiExecutor = (input: {
  transaction: Uint8Array;
  signatures: string[];
}) => Promise<SuiExecutorResult>;

/**
 * The identity of a settlement for deduplication: the transaction digest, plus
 * the declared server nonce when present (which a shared guard MAY use for
 * invoice or challenge reconciliation).
 */
export type SettlementKey = {
  digest: string;
  nonce?: string;
};

/**
 * A dedup guard consulted at the top of settle. The default in-process
 * implementation covers a single process; a scaled facilitator SHOULD supply a
 * shared implementation (e.g. Redis) for cross-instance serving.
 */
export interface SettlementGuard {
  /**
   * Atomically record the settlement as in-progress. Returns `true` when it was
   * already present (a duplicate the caller MUST reject), `false` otherwise. May
   * be async so a shared store (e.g. Redis) can back it.
   *
   * @param payment - The settlement identity (digest, and nonce when declared)
   * @returns Whether it was already present
   */
  isDuplicate(payment: SettlementKey): boolean | Promise<boolean>;
}

/**
 * Options shared by the client and facilitator schemes: per-network Sui client
 * overrides. Any client implementing the core API works (gRPC, GraphQL, ...);
 * networks without an override fall back to a gRPC client for the default
 * public fullnode.
 */
export type SuiClientOptions = {
  /**
   * Sui clients keyed by CAIP-2 network id (e.g. "sui:mainnet").
   */
  clients?: Record<string, ClientWithCoreApi>;
};

/**
 * Facilitator options: client overrides, an optional custom executor and
 * advertised fee-payer address, and a settlement dedup guard.
 */
export type FacilitatorSuiOptions = SuiClientOptions & {
  /**
   * Optional executor settlement is delegated to (e.g. a gas sponsor). When
   * absent, the facilitator broadcasts directly via the network client.
   */
  executeTransaction?: SuiExecutor;
  /**
   * Optional gas-sponsor address advertised as `extra.feePayer`, so clients build
   * sponsored transactions with it as the gas owner. Independent of
   * `executeTransaction`.
   */
  feePayer?: string;
  /**
   * Settlement dedup guard. Defaults to an in-process, digest-keyed cache.
   */
  settlementGuard?: SettlementGuard;
};
