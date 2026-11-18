import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";

/**
 * Exact Sui payload: the client-signed transaction. On a facilitator-sponsored
 * payment the sponsor's signature is added at settlement.
 */
export type ExactSuiPayload = {
  /**
   * Base64-encoded BCS transaction bytes.
   */
  transaction: string;
  /**
   * Base64-encoded serialized signature(s) over the transaction bytes. An array
   * is needed when a second signer the client controls, such as its own gas
   * sponsor, must sign. A single string is equivalent to a one-element array.
   */
  signature: string | string[];
};

/**
 * The result of a {@link SuiExecutor}: the submitted transaction, an on-chain
 * failure, or a policy rejection. Balance changes need not be included; the
 * facilitator reads them from `waitForTransaction`.
 */
export type SuiExecutorResult =
  | { $kind: "Transaction"; Transaction: SuiClientTypes.Transaction }
  | { $kind: "FailedTransaction"; FailedTransaction: SuiClientTypes.Transaction }
  | { $kind: "Rejected"; reason?: string; issues?: ReadonlyArray<{ message?: string }> };

/**
 * Submits facilitator-sponsored transactions, for example a gas sponsor that
 * adds its signature. Required when `feePayer` is set.
 */
export type SuiExecutor = (input: {
  transaction: Uint8Array;
  signatures: string[];
}) => Promise<SuiExecutorResult>;

/**
 * The identity of a settlement. `maxEpoch` is the transaction's last valid
 * epoch: a claim must be kept until that epoch has ended.
 */
export type SettlementKey = {
  network: string;
  digest: string;
  maxEpoch: string;
};

/**
 * Records which transactions have been settled so the facilitator reports
 * success at most once per digest. The facilitator claims a key before
 * submitting and releases it when settlement does not succeed. Keep a
 * successful claim until the network is two epochs past `maxEpoch`: one epoch
 * for the window to end, and one of margin for a lagging fullnode.
 *
 * Claims MUST be shared, with atomic claims, by every process serving
 * `/settle`. They SHOULD survive restarts for as long as they are kept. The
 * default in-memory {@link SettlementCache} loses them on every restart: until
 * the transaction's window ends (up to two epochs), a payment that already
 * settled can be settled again and reported as a second success. Facilitators
 * running several processes, or that may restart, SHOULD supply a shared,
 * durable store.
 *
 * A claim held by a process that dies mid-settlement, or one whose release
 * fails, blocks that digest until the store expires it. Settle returns
 * `duplicate_settlement` meanwhile, and since the expiry outlasts the
 * transaction's window, the caller should reconcile such a payment by digest.
 */
export interface SettlementGuard {
  /**
   * Atomically claim a key.
   *
   * @param key - The settlement identity
   * @returns `true` if the key was claimed, `false` if it is already held
   */
  claim(key: SettlementKey): boolean | Promise<boolean>;

  /**
   * Release a claimed key after a settlement that did not succeed.
   *
   * @param key - The settlement identity
   */
  release(key: SettlementKey): void | Promise<void>;

  /**
   * Optional. Receives each epoch the facilitator reads from a network, so the
   * store can drop claims more than one epoch past their `maxEpoch`.
   *
   * @param network - The CAIP-2 network id
   * @param epoch - The network's current epoch
   */
  observeEpoch?(network: string, epoch: bigint): void | Promise<void>;
}

/**
 * Per-network Sui client overrides. Any client implementing the core API works
 * (gRPC, GraphQL). Networks without an override use a gRPC client for the
 * public fullnode.
 */
export type SuiClientOptions = {
  /**
   * Sui clients keyed by CAIP-2 network id (e.g. "sui:mainnet").
   */
  clients?: Record<string, ClientWithCoreApi>;
};

/**
 * Facilitator options.
 */
export type FacilitatorSuiOptions = SuiClientOptions & {
  /**
   * Submits facilitator-sponsored transactions. Required when `feePayer` is set.
   */
  executeTransaction?: SuiExecutor;
  /**
   * Gas sponsor address advertised as `extra.feePayer`. Clients set it as the
   * gas owner, and `executeTransaction` must add its signature.
   */
  feePayer?: string;
  /**
   * Largest gas budget, in MIST, accepted on a sponsored payment. Defaults to
   * {@link DEFAULT_MAX_SPONSORED_GAS_BUDGET}.
   */
  maxSponsoredGasBudget?: bigint;
  /**
   * Settlement dedup store. Defaults to an in-memory {@link SettlementCache},
   * which is lost on restart and not shared across processes: see
   * {@link SettlementGuard}.
   */
  settlementGuard?: SettlementGuard;
  /**
   * Remembers this facilitator's submissions that returned
   * `settlement_pending`, so a retry of one is recognized as its own rather
   * than rejected as already executed. Defaults to core's in-memory store;
   * share one across processes alongside `settlementGuard`.
   */
  pendingSettlementStore?: PendingSettlementStore;
};
