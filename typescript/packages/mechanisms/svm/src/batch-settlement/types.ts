/* eslint-disable jsdoc/require-jsdoc */
/** Wire types for the SVM `batch-settlement` scheme. */

import { BATCH_SETTLEMENT_SCHEME } from "./constants";
import { BatchError } from "./errors";
import { V1_MAX_CLAIM_CHANNELS, V1_MAX_SETTLE_CHANNELS } from "./facilitator/constants";

export { BATCH_SETTLEMENT_SCHEME } from "./constants";

export type BatchExtra = {
  paymentFlow?: "authorization" | undefined;
  minDeposit?: string | undefined;
  feePayer: string;
  receiverAuthorizer: string;
  withdrawDelay: number;
  tokenProgram: string;
  memo?: string | undefined;
  recentBlockhash?: string | undefined;
  recentSlot?: number | undefined;
  channelState?: BatchChannelState | undefined;
  voucherState?: BatchVoucherState | undefined;
  voucherSigner?: BatchVoucherSigner | undefined;
  operator?: string | undefined;
  /**
   * Facilitator idle window in seconds, copied from `/supported`. After this
   * long with no facilitator-visible lifecycle activity an `Open` channel may
   * be abandon-closed at its onchain settled watermark. Absent means the
   * facilitator does not idle-close.
   */
  maxIdleSecs?: number | undefined;
  /**
   * Transaction message versions the facilitator accepts, copied from
   * `/supported`: the JSON integers `0` and/or `1`. Absent means `[0]`.
   */
  transactionVersions?: (0 | 1)[] | undefined;
  /** Channels one `claim` may carry, copied from `/supported`. */
  maxClaimChannels?: number | undefined;
  /** Channels one `settle` may carry, copied from `/supported`. */
  maxSettleChannels?: number | undefined;
};

export type BatchVoucherSigner = "client" | "server";

export type BatchAuthorization = {
  type: "proof";
  channelId: string;
  payer: string;
  requestId: string;
  authorizedAmount: string;
  expiresAt: number;
  signature: string;
};

/**
 * The signed voucher proof a corrective 402 carries, so the client can adopt a
 * new cumulative base without taking the server's word for it.
 *
 * This is not a {@link BatchVoucher}: it names only the cumulative amount the
 * server holds a signature for, and the client rederives the channel id it
 * verifies against. See the scheme spec section 4.6.
 */
export type BatchVoucherState = {
  /** Cumulative amount the server holds a client signature for. */
  signedMaxClaimable: string;
  /** Expiry in the signed message; always `0` in this scheme. */
  expiresAt: number;
  /** Base58 Ed25519 signature over the 50-byte voucher message. */
  signature: string;
};

export type BatchChannelConfig = {
  payer: string;
  payerAuthorizer: string;
  receiver: string;
  receiverAuthorizer: string;
  token: string;
  withdrawDelay: number;
  salt: string;
  openSlot: number;
  voucherSigner?: BatchVoucherSigner | undefined;
};

export type BatchVoucher = {
  channelId: string;
  maxClaimableAmount: string;
  expiresAt: number;
  signature: string;
};

export type CloseAuthorization = {
  validBefore: number;
  signature: string;
};

export type BatchDepositPayload = {
  type: "deposit";
  channelConfig: BatchChannelConfig;
  voucher?: BatchVoucher | undefined;
  authorization?: BatchAuthorization | undefined;
  deposit: {
    amount: string;
    transaction: string;
  };
};

export type BatchVoucherPayload = {
  type: "voucher";
  channelConfig: BatchChannelConfig;
  voucher: BatchVoucher;
};

export type BatchAuthorizationPayload = {
  type: "authorization";
  channelConfig: BatchChannelConfig;
  authorization: BatchAuthorization;
};

/** Client-signed voucher or server-mode payer authorization. */
export type BatchProof =
  | { signer: "client"; voucher: BatchVoucher }
  | { signer: "server"; authorization: BatchAuthorization };

export function proofOf(
  payload: BatchDepositPayload | BatchVoucherPayload | BatchAuthorizationPayload,
): BatchProof {
  switch (payload.type) {
    case "voucher":
      return { signer: "client", voucher: payload.voucher };
    case "authorization":
      return { signer: "server", authorization: payload.authorization };
    case "deposit":
      if (payload.voucher !== undefined) return { signer: "client", voucher: payload.voucher };
      if (payload.authorization !== undefined) {
        return { signer: "server", authorization: payload.authorization };
      }
      throw new Error(BatchError.VOUCHER_SIGNATURE);
    default: {
      const unexpected: never = payload;
      throw new Error(String(unexpected));
    }
  }
}

/**
 * Client mode: payer-signed `voucher` at the accepted cumulative. Server mode:
 * payer `authorization` with `authorizedAmount` `"0"`; the server injects the
 * operator voucher and `closeAuthorization` before settle.
 */
export type BatchRefundPayload = {
  type: "refund";
  channelConfig: BatchChannelConfig;
  voucher?: BatchVoucher | undefined;
  authorization?: BatchAuthorization | undefined;
  transaction?: string | undefined;
  closeAuthorization?: CloseAuthorization | undefined;
};

export type BatchPayload =
  | BatchDepositPayload
  | BatchVoucherPayload
  | BatchAuthorizationPayload
  | BatchRefundPayload;

/**
 * One channel in a server-authored `claim`: the same `channelId` +
 * `channelConfig` entry shape as `settle` and `seal`, carrying the latest
 * accepted voucher as a standard {@link BatchVoucher}.
 */
export type BatchVoucherClaim = {
  channelId: string;
  channelConfig: BatchChannelConfig;
  voucher: BatchVoucher;
};

export type BatchClaimPayload = {
  type: "claim";
  claims: BatchVoucherClaim[];
};

export type BatchSettlePayload = {
  type: "settle";
  channels: { channelId: string; channelConfig: BatchChannelConfig }[];
};

/**
 * Server-authored cooperative close of a `Closing` channel: apply the server's
 * latest accepted voucher with `settle_and_seal` and pay out with a sealed
 * `distribute` before the payer's grace period ends (spec 4.5).
 */
export type BatchSealPayload = {
  type: "seal";
  channelId: string;
  channelConfig: BatchChannelConfig;
  /** Latest accepted voucher; its cumulative becomes the final settled watermark. */
  voucher: BatchVoucher;
  /**
   * Required when the channel's receiver authorizer is a server key. Omitted
   * when the facilitator is that authorizer and authenticates the caller.
   */
  closeAuthorization?: CloseAuthorization | undefined;
};

export type BatchFacilitatorPayload =
  | BatchPayload
  | BatchClaimPayload
  | BatchSettlePayload
  | BatchSealPayload;

export type BatchChannelState = {
  channelId: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  chargedCumulativeAmount?: string | undefined;
};

export function isBatchVoucher(value: unknown): value is BatchVoucher {
  if (!isRecord(value)) return false;
  return (
    typeof value.channelId === "string" &&
    typeof value.maxClaimableAmount === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.signature === "string"
  );
}

export function isBatchChannelConfig(value: unknown): value is BatchChannelConfig {
  if (!isRecord(value)) return false;
  return (
    typeof value.payer === "string" &&
    typeof value.payerAuthorizer === "string" &&
    typeof value.receiver === "string" &&
    typeof value.receiverAuthorizer === "string" &&
    typeof value.token === "string" &&
    typeof value.withdrawDelay === "number" &&
    typeof value.salt === "string" &&
    typeof value.openSlot === "number" &&
    (value.voucherSigner === undefined ||
      value.voucherSigner === "client" ||
      value.voucherSigner === "server")
  );
}

export function isBatchPayload(value: unknown): value is BatchPayload {
  if (!isRecord(value) || !isBatchChannelConfig(value.channelConfig)) return false;
  switch (value.type) {
    case "deposit":
      if (!isRecord(value.deposit)) return false;
      if (
        typeof value.deposit.amount !== "string" ||
        typeof value.deposit.transaction !== "string"
      ) {
        return false;
      }
      return value.channelConfig.voucherSigner === "server"
        ? value.voucher === undefined &&
            isBatchAuthorization(value.authorization) &&
            value.requestId === undefined &&
            value.maxClaimableAmount === undefined
        : isBatchVoucher(value.voucher) &&
            value.authorization === undefined &&
            value.requestId === undefined &&
            value.maxClaimableAmount === undefined;
    case "voucher":
      return value.channelConfig.voucherSigner !== "server" && isBatchVoucher(value.voucher);
    case "authorization":
      return (
        value.channelConfig.voucherSigner === "server" &&
        isBatchAuthorization(value.authorization) &&
        value.requestId === undefined &&
        value.maxClaimableAmount === undefined
      );
    case "refund": {
      const txOk = value.transaction === undefined || typeof value.transaction === "string";
      const closeOk =
        value.closeAuthorization === undefined || isCloseAuthorization(value.closeAuthorization);
      const signer = value.channelConfig.voucherSigner ?? "client";
      if (signer === "server") {
        const authOk =
          value.authorization === undefined ||
          (isBatchAuthorization(value.authorization) &&
            value.authorization.authorizedAmount === "0");
        if (isBatchVoucher(value.voucher)) {
          return authOk && txOk && closeOk;
        }
        return (
          value.voucher === undefined &&
          isBatchAuthorization(value.authorization) &&
          value.authorization.authorizedAmount === "0" &&
          txOk &&
          closeOk
        );
      }
      return isBatchVoucher(value.voucher) && value.authorization === undefined && txOk && closeOk;
    }
    default:
      return false;
  }
}

function isBatchAuthorization(value: unknown): value is BatchAuthorization {
  return (
    isRecord(value) &&
    value.type === "proof" &&
    typeof value.channelId === "string" &&
    typeof value.payer === "string" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.authorizedAmount === "string" &&
    /^\d+$/.test(value.authorizedAmount) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > 0 &&
    typeof value.signature === "string"
  );
}

export function isBatchFacilitatorPayload(value: unknown): value is BatchFacilitatorPayload {
  if (isBatchPayload(value)) return true;
  if (!isRecord(value)) return false;
  if (value.type === "claim") {
    return (
      Array.isArray(value.claims) &&
      value.claims.length > 0 &&
      // The protocol maximum; the facilitator checks its advertised capacity.
      value.claims.length <= V1_MAX_CLAIM_CHANNELS &&
      value.claims.every(isBatchVoucherClaim)
    );
  }
  if (value.type === "seal") {
    return (
      typeof value.channelId === "string" &&
      isBatchChannelConfig(value.channelConfig) &&
      isBatchVoucher(value.voucher) &&
      (value.closeAuthorization === undefined || isCloseAuthorization(value.closeAuthorization))
    );
  }
  return (
    value.type === "settle" &&
    Array.isArray(value.channels) &&
    value.channels.length > 0 &&
    value.channels.length <= V1_MAX_SETTLE_CHANNELS &&
    value.channels.every(
      item =>
        isRecord(item) &&
        typeof item.channelId === "string" &&
        isBatchChannelConfig(item.channelConfig),
    )
  );
}

function isBatchVoucherClaim(value: unknown): value is BatchVoucherClaim {
  return (
    isRecord(value) &&
    typeof value.channelId === "string" &&
    isBatchChannelConfig(value.channelConfig) &&
    isBatchVoucher(value.voucher)
  );
}

function isCloseAuthorization(value: unknown): value is CloseAuthorization {
  return (
    isRecord(value) &&
    typeof value.validBefore === "number" &&
    Number.isSafeInteger(value.validBefore) &&
    value.validBefore > 0 &&
    typeof value.signature === "string"
  );
}

/** Batch-settlement `PaymentRequirements`: the route's accept, `extra` typed. */
export type BatchRequirements = {
  scheme: typeof BATCH_SETTLEMENT_SCHEME;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: BatchExtra;
};

/** The `PAYMENT-SIGNATURE` envelope of a batch-settlement payment. */
export type BatchPaymentPayloadEnvelope = {
  x402Version: 2;
  accepted: BatchRequirements;
  payload: BatchPayload;
  resource?: Record<string, unknown> | undefined;
  extensions?: Record<string, unknown> | undefined;
};

/** The `PAYMENT-RESPONSE` of a batch-settlement operation. */
export type BatchSettlementResponse = {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string | undefined;
  amount?: string | undefined;
  errorReason?: string | undefined;
  errorMessage?: string | undefined;
  extra?:
    | {
        [key: string]: unknown;
        channelState?: BatchChannelState | undefined;
        chargedAmount?: string | undefined;
        commitmentId?: string | undefined;
      }
    | undefined;
};

/** A batch-settlement `PAYMENT-REQUIRED` (including the corrective 402). */
export type BatchPaymentRequired = {
  x402Version: 2;
  error?: string | undefined;
  accepts: Record<string, unknown>[];
  resource?: Record<string, unknown> | undefined;
  extensions?: Record<string, unknown> | undefined;
};

const isDecimal = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

const isSafeUint = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isOptional = (value: unknown, guard: (value: unknown) => boolean): boolean =>
  value === undefined || guard(value);

const isString = (value: unknown): value is string => typeof value === "string";

export function isBatchChannelState(value: unknown): value is BatchChannelState {
  return (
    isRecord(value) &&
    isString(value.channelId) &&
    isDecimal(value.balance) &&
    isDecimal(value.totalClaimed) &&
    isSafeUint(value.withdrawRequestedAt) &&
    isOptional(value.chargedCumulativeAmount, isDecimal)
  );
}

export function isBatchVoucherState(value: unknown): value is BatchVoucherState {
  return (
    isRecord(value) &&
    isDecimal(value.signedMaxClaimable) &&
    Number.isSafeInteger(value.expiresAt) &&
    isString(value.signature)
  );
}

/**
 * Whether `value` is a valid `extra.transactionVersions`: a list of the JSON
 * integers `0` and `1`. Any other entry (`"legacy"`, `"1"`, `2`, `null`)
 * invalidates the whole field.
 *
 * @param value - The field value
 * @returns Whether it is a valid version list
 */
export function isTransactionVersionList(value: unknown): value is (0 | 1)[] {
  return Array.isArray(value) && value.every(version => version === 0 || version === 1);
}

export function isBatchExtra(value: unknown): value is BatchExtra {
  if (!isRecord(value)) return false;
  const positive = (field: unknown) => Number.isSafeInteger(field) && (field as number) > 0;
  return (
    isString(value.feePayer) &&
    isString(value.receiverAuthorizer) &&
    isSafeUint(value.withdrawDelay) &&
    isString(value.tokenProgram) &&
    isOptional(value.paymentFlow, field => field === "authorization") &&
    isOptional(value.minDeposit, isDecimal) &&
    isOptional(value.memo, isString) &&
    isOptional(value.recentBlockhash, isString) &&
    isOptional(value.recentSlot, isSafeUint) &&
    isOptional(value.channelState, isBatchChannelState) &&
    isOptional(value.voucherState, isBatchVoucherState) &&
    isOptional(value.voucherSigner, field => field === "client" || field === "server") &&
    isOptional(value.operator, isString) &&
    isOptional(value.maxIdleSecs, isSafeUint) &&
    isOptional(value.transactionVersions, isTransactionVersionList) &&
    isOptional(value.maxClaimChannels, positive) &&
    isOptional(value.maxSettleChannels, positive)
  );
}

export function isBatchRequirements(value: unknown): value is BatchRequirements {
  return (
    isRecord(value) &&
    value.scheme === BATCH_SETTLEMENT_SCHEME &&
    isString(value.network) &&
    value.network.startsWith("solana:") &&
    isDecimal(value.amount) &&
    isString(value.asset) &&
    isString(value.payTo) &&
    Number.isSafeInteger(value.maxTimeoutSeconds) &&
    (value.maxTimeoutSeconds as number) > 0 &&
    isBatchExtra(value.extra)
  );
}

export function isBatchPaymentPayloadEnvelope(
  value: unknown,
): value is BatchPaymentPayloadEnvelope {
  return (
    isRecord(value) &&
    value.x402Version === 2 &&
    isBatchRequirements(value.accepted) &&
    isBatchPayload(value.payload) &&
    isOptional(value.resource, isRecord) &&
    isOptional(value.extensions, isRecord)
  );
}

export function isBatchSettlementResponse(value: unknown): value is BatchSettlementResponse {
  if (!isRecord(value)) return false;
  const extra = value.extra;
  return (
    typeof value.success === "boolean" &&
    isString(value.transaction) &&
    isString(value.network) &&
    isOptional(value.payer, isString) &&
    isOptional(value.amount, field => field === "" || isDecimal(field)) &&
    isOptional(value.errorReason, isString) &&
    isOptional(value.errorMessage, isString) &&
    (extra === undefined ||
      (isRecord(extra) &&
        isOptional(extra.channelState, isBatchChannelState) &&
        isOptional(extra.chargedAmount, isDecimal) &&
        isOptional(extra.commitmentId, field => isString(field) && field.length > 0)))
  );
}

export function isBatchPaymentRequired(value: unknown): value is BatchPaymentRequired {
  return (
    isRecord(value) &&
    value.x402Version === 2 &&
    isOptional(value.error, isString) &&
    Array.isArray(value.accepts) &&
    value.accepts.length > 0 &&
    // Accepts of other schemes ride along untouched; batch ones must be valid.
    value.accepts.every(
      accept =>
        isRecord(accept) &&
        (accept.scheme !== BATCH_SETTLEMENT_SCHEME || isBatchRequirements(accept)),
    ) &&
    isOptional(value.resource, isRecord) &&
    isOptional(value.extensions, isRecord)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
