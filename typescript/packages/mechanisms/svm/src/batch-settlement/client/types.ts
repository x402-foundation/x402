import type { SchemeClientHooks } from "@x402/core/types";

import type { BatchPayload } from "../types";
import type { BatchChannelTracker } from "./channel";
import type { ResolvedServerSignedTrust } from "./trust";

/** A confirmed client allocation for one channel. */
export interface OpenChannel {
  tracker: BatchChannelTracker;
  deposit: bigint;
}

/** A payment the client has built and not yet heard back about. */
export type PendingPayment = {
  payload: Extract<BatchPayload, { type: "authorization" | "deposit" | "voucher" }>;
  x402Version: number;
};

/** An in-flight payment plus the confirmed allocation to restore if it is rejected. */
export type PendingChannel = OpenChannel & {
  /** Confirmed allocation to restore if this pending request is rejected. */
  confirmed?: OpenChannel | undefined;
  key: string;
  operationKey: string;
  amount: string;
  cumulative: bigint;
  payment: PendingPayment;
};

/** Arguments core passes to the client's payment-response hook. */
export type PaymentResponseContext = Parameters<
  NonNullable<SchemeClientHooks["onPaymentResponse"]>
>[0];

/** Channel terms the client resolved from a 402 before it builds a payment. */
export type ResolvedTerms = {
  feePayer: string;
  receiverAuthorizer: string;
  tokenProgram: string;
  withdrawDelay: number;
  memo?: string | undefined;
  voucherSigner: "client" | "server";
  operator?: string | undefined;
  /** Grant under which server mode was allowed; absent in client mode. */
  trust?: ResolvedServerSignedTrust | undefined;
};
