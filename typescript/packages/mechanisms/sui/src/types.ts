import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import type { ApproveSplits } from "./splits";

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
 * When several processes serve `/settle`, they MUST share one claim store with
 * atomic claims. A single process MAY keep claims in memory, as the default
 * {@link SettlementCache} does.
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
 * Client options.
 */
export type ClientSuiOptions = SuiClientOptions & {
  /**
   * Consent hook for multi-payee splits. Called before signing whenever the
   * requirements carry a non-empty `extra.splits`, with the splits and the
   * remainder reaching `payTo`. Return `true` only when every recipient, amount
   * and memo matches the terms the payer agreed to.
   *
   * When unset, requirements with splits are refused: a server could otherwise
   * add recipients and divert part of the payment.
   */
  approveSplits?: ApproveSplits;
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
   * Most `extra.splits` entries accepted, 0 to {@link MAX_SPLITS}. Advertised
   * as `maxSplits` in `/supported` when above 0. Defaults to 0: splits are not
   * accepted or advertised.
   */
  maxSplits?: number;
  /**
   * Settlement dedup guard. Defaults to an in-process {@link SettlementCache}.
   */
  settlementGuard?: SettlementGuard;
};
