/* eslint-disable jsdoc/require-jsdoc */
/** Wire types for the SVM `batch-settlement` scheme. */

export const BATCH_SETTLEMENT_SCHEME = "batch-settlement";

export type BatchExtra = {
  paymentFlow?: "authorization" | undefined;
  minDeposit?: string | undefined;
  feePayer: string;
  receiverAuthorizer?: string | undefined;
  withdrawDelay: number;
  tokenProgram: string;
  memo?: string | undefined;
  recentBlockhash?: string | undefined;
  recentSlot?: number | undefined;
  channelState?: BatchChannelState | undefined;
  voucherState?: BatchVoucherState | undefined;
  voucherSigner?: BatchVoucherSigner | undefined;
  operator?: string | undefined;
};

export type BatchVoucherSigner = "client" | "server";

export type BatchAuthorization = {
  type: "proof";
  channelId: string;
  payer: string;
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
  receiverAuthorizer?: string | undefined;
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

/** Operator-signed itemization for one completed server-mode request. */
export type BatchSettlementReceipt = {
  type: "receipt";
  channelId: string;
  idempotencyKey: string;
  authorizedAmount: string;
  chargedAmount: string;
  priorCumulativeAmount: string;
  cumulativeAmount: string;
  voucher: BatchVoucher;
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
  idempotencyKey?: string | undefined;
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
  idempotencyKey: string;
};

export type BatchRefundPayload = {
  type: "refund";
  channelConfig: BatchChannelConfig;
  transaction: string;
  voucher?: BatchVoucher | undefined;
  closeAuthorization?: CloseAuthorization | undefined;
};

export type BatchPayload =
  | BatchDepositPayload
  | BatchVoucherPayload
  | BatchAuthorizationPayload
  | BatchRefundPayload;

export type BatchVoucherClaim = {
  voucher: {
    channelConfig: BatchChannelConfig;
    channelId: string;
    maxClaimableAmount: string;
    expiresAt: number;
  };
  signature: string;
};

export type BatchClaimPayload = {
  type: "claim";
  claims: BatchVoucherClaim[];
};

export type BatchSettlePayload = {
  type: "settle";
  channels: { channelId: string; channelConfig: BatchChannelConfig }[];
};

export type BatchFacilitatorPayload = BatchPayload | BatchClaimPayload | BatchSettlePayload;

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

export function isBatchSettlementReceipt(value: unknown): value is BatchSettlementReceipt {
  if (!isRecord(value)) return false;
  return (
    value.type === "receipt" &&
    typeof value.channelId === "string" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.authorizedAmount === "string" &&
    typeof value.chargedAmount === "string" &&
    typeof value.priorCumulativeAmount === "string" &&
    typeof value.cumulativeAmount === "string" &&
    isBatchVoucher(value.voucher) &&
    typeof value.signature === "string"
  );
}

export function isBatchChannelConfig(value: unknown): value is BatchChannelConfig {
  if (!isRecord(value)) return false;
  return (
    typeof value.payer === "string" &&
    typeof value.payerAuthorizer === "string" &&
    typeof value.receiver === "string" &&
    (value.receiverAuthorizer === undefined || typeof value.receiverAuthorizer === "string") &&
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
            typeof value.idempotencyKey === "string" &&
            value.idempotencyKey.length > 0 &&
            value.maxClaimableAmount === undefined
        : isBatchVoucher(value.voucher) &&
            value.authorization === undefined &&
            value.idempotencyKey === undefined &&
            value.maxClaimableAmount === undefined;
    case "voucher":
      return value.channelConfig.voucherSigner !== "server" && isBatchVoucher(value.voucher);
    case "authorization":
      return (
        value.channelConfig.voucherSigner === "server" &&
        isBatchAuthorization(value.authorization) &&
        typeof value.idempotencyKey === "string" &&
        value.idempotencyKey.length > 0 &&
        value.maxClaimableAmount === undefined
      );
    case "refund":
      return (
        typeof value.transaction === "string" &&
        (value.voucher === undefined || isBatchVoucher(value.voucher)) &&
        (value.closeAuthorization === undefined || isCloseAuthorization(value.closeAuthorization))
      );
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
      value.claims.length <= 4 &&
      value.claims.every(isBatchVoucherClaim)
    );
  }
  return (
    value.type === "settle" &&
    Array.isArray(value.channels) &&
    value.channels.length > 0 &&
    value.channels.every(
      item =>
        isRecord(item) &&
        typeof item.channelId === "string" &&
        isBatchChannelConfig(item.channelConfig),
    )
  );
}

function isBatchVoucherClaim(value: unknown): value is BatchVoucherClaim {
  if (!isRecord(value) || typeof value.signature !== "string" || !isRecord(value.voucher)) {
    return false;
  }
  return (
    isBatchChannelConfig(value.voucher.channelConfig) &&
    typeof value.voucher.channelId === "string" &&
    typeof value.voucher.maxClaimableAmount === "string" &&
    typeof value.voucher.expiresAt === "number"
  );
}

function isCloseAuthorization(value: unknown): value is CloseAuthorization {
  return (
    isRecord(value) && typeof value.validBefore === "number" && typeof value.signature === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
