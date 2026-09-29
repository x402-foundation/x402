import type { Network, SettleResponse } from "@x402/core/types";

import type { FacilitatorSigningCapabilities } from "../../signer";
import type {
  BatchClaimPayload,
  BatchDepositPayload,
  BatchProof,
  BatchSettlePayload,
} from "../types";
import type { BatchReceiverAuthorizerStore } from "./receiverAuthorizerStore";

/** Terms resolved from a channel config and the facilitator's fee payer. */
export type BatchTerms = {
  feePayer: string;
  feePayerSigner: FacilitatorSigningCapabilities;
  receiverAuthorizer: string;
  tokenProgram: string;
  withdrawDelay: number;
  memo?: string | undefined;
  voucherSigner: "client" | "server";
};

/** A deposit payload whose terms, channel, and amounts have been checked. */
export type ValidatedDeposit = {
  payload: BatchDepositPayload;
  terms: BatchTerms;
  channelId: string;
  deposit: bigint;
  expectedDeposit: bigint;
  isTopUp: boolean;
  proof: BatchProof;
  /** Client: signed cumulative. Server: metered charge (`requirements.amount`). */
  proofAmount: bigint;
};

/** Outcome of a durable broadcast: landed bytes, or a terminal settle response. */
export type DurableBroadcastResult =
  | { ok: true; replayed: boolean; signature: string }
  | { ok: false; response: SettleResponse };

/** One claim whose channel, voucher, and fee payer are ready to redeem. */
export type PreparedClaim = {
  claim: BatchClaimPayload["claims"][number];
  channelId: string;
  feePayer: string;
  cumulative: bigint;
  expiresAt: number;
  payTo: string;
  tokenProgram: string;
  terms: BatchTerms;
};

/** One channel whose settled amount is ready to distribute. */
export type PreparedDistribution = {
  channelConfig: BatchSettlePayload["channels"][number]["channelConfig"];
  channelId: string;
  feePayer: string;
  terms: BatchTerms;
};

/** Verify requires the proof to equal the advertised amount; settle allows a lower metered charge. */
export type ProofAmountBound = "exact" | "ceiling";

/**
 * Client payments must match the requirements. Redemption reads the mode from
 * the payload, because one worker requirements object covers both modes.
 */
export type VoucherModeBinding = "requirements" | "payload";

/** The two places a facilitator may read a channel's receiver-authorizer binding. */
export type BindingSourceConfig = {
  receiverAuthorizerStore?: BatchReceiverAuthorizerStore | undefined;
  receiverBindingHistoryReader?: BatchReceiverBindingHistoryReader | undefined;
};

/** One signature touching a channel account, newest-first as returned by RPC. */
export interface BatchReceiverBindingHistorySignature {
  signature: string;
  /** RPC error for a failed transaction, or null when it succeeded. */
  err: unknown;
}

/**
 * Reconstructs a channel's receiver-authorizer binding from its open transaction.
 * A pruned history fails closed: `getTransaction` returns null.
 */
export interface BatchReceiverBindingHistoryReader {
  getSignaturesForAddress(
    network: Network,
    address: string,
    options?: { before?: string; limit?: number },
  ): Promise<BatchReceiverBindingHistorySignature[]>;
  /** Confirmed transaction bytes, or null when the signature is unknown. */
  getTransaction(network: Network, signature: string): Promise<string | null>;
}
