import type { TypedData } from "viem";

export interface AuthorizerSigner {
  address: `0x${string}`;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: TypedData;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export type ChannelState = {
  balance: bigint;
  totalClaimed: bigint;
  withdrawRequestedAt: number;
  refundNonce: bigint;
};

export type ChannelConfig = {
  payer: `0x${string}`;
  payerAuthorizer: `0x${string}`;
  receiver: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
  token: `0x${string}`;
  withdrawDelay: number;
  salt: `0x${string}`;
};

export type BatchSettlementErc3009Authorization = {
  validAfter: string;
  validBefore: string;
  salt: `0x${string}`;
  signature: `0x${string}`;
};

export type BatchSettlementPermit2Authorization = {
  from: `0x${string}`;
  permitted: {
    token: `0x${string}`;
    amount: string;
  };
  spender: `0x${string}`;
  nonce: string;
  deadline: string;
  witness: {
    channelId: `0x${string}`;
  };
  signature: `0x${string}`;
};

export type BatchSettlementAssetTransferMethod = "eip3009" | "permit2";

export type BatchSettlementDepositAuthorization =
  | {
      erc3009Authorization: BatchSettlementErc3009Authorization;
      permit2Authorization?: never;
    }
  | {
      erc3009Authorization?: never;
      permit2Authorization: BatchSettlementPermit2Authorization;
    };

export type BatchSettlementDepositPayload = {
  type: "deposit";
  channelConfig: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
  deposit: {
    amount: string;
    authorization: BatchSettlementDepositAuthorization;
  };
};

export type BatchSettlementVoucherPayload = {
  type: "voucher";
  channelConfig: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
};

export type BatchSettlementRefundPayload = {
  type: "refund";
  channelConfig: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
  amount?: string;
};

export type BatchSettlementVoucherFields = {
  channelId: `0x${string}`;
  maxClaimableAmount: string;
  signature: `0x${string}`;
};

export type BatchSettlementVoucherClaim = {
  voucher: {
    channel: ChannelConfig;
    maxClaimableAmount: string;
  };
  signature: `0x${string}`;
  totalClaimed: string;
};

export type BatchSettlementChannelStateExtra = {
  channelId: `0x${string}`;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  refundNonce: string;
  chargedCumulativeAmount?: string;
};

export type BatchSettlementVoucherStateExtra = {
  signedMaxClaimable?: string;
  signature?: `0x${string}`;
};

export type BatchSettlementPaymentRequirementsExtra = {
  receiverAuthorizer: `0x${string}`;
  withdrawDelay: number;
  name: string;
  version: string;
  assetTransferMethod?: BatchSettlementAssetTransferMethod;
  channelState?: BatchSettlementChannelStateExtra;
  voucherState?: BatchSettlementVoucherStateExtra;
};

export type FileChannelStorageOptions = {
  /** Root directory; channels are stored under `{directory}/{client|server}/{channelId}.json`. */
  directory: string;
};

export type BatchSettlementPaymentResponseExtra = {
  chargedAmount?: string;
  channelState?: BatchSettlementChannelStateExtra;
  voucherState?: BatchSettlementVoucherStateExtra;
};

export type BatchSettlementClaimPayload = {
  type: "claim";
  claims: BatchSettlementVoucherClaim[];
  claimAuthorizerSignature?: `0x${string}`;
};

export type BatchSettlementSettlePayload = {
  type: "settle";
  receiver: `0x${string}`;
  token: `0x${string}`;
};

export type BatchSettlementEnrichedRefundPayload = BatchSettlementRefundPayload & {
  amount: string;
  refundNonce: string;
  claims: BatchSettlementVoucherClaim[];
  refundAuthorizerSignature?: `0x${string}`;
  claimAuthorizerSignature?: `0x${string}`;
};

export type BatchSettlementPayload =
  | BatchSettlementDepositPayload
  | BatchSettlementVoucherPayload
  | BatchSettlementRefundPayload;

export type BatchSettlementFacilitatorSettlePayload =
  | BatchSettlementDepositPayload
  | BatchSettlementClaimPayload
  | BatchSettlementSettlePayload
  | BatchSettlementEnrichedRefundPayload;

/**
 * Returns true when the value is a non-null object (a usable record).
 *
 * @param payload - Value of unknown shape.
 * @returns True if `payload` is an object that can be indexed by string keys.
 */
function isObject(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null;
}

/**
 * Type guard for internal voucher field shape (channel, amount, signature).
 *
 * @param payload - Unknown value to check.
 * @returns True if `payload` is an object with `channelId`, `maxClaimableAmount`, and `signature`.
 */
function isVoucherFields(payload: unknown): payload is BatchSettlementVoucherFields {
  return (
    isObject(payload) &&
    "channelId" in payload &&
    "maxClaimableAmount" in payload &&
    "signature" in payload
  );
}

/**
 * Type guard for {@link BatchSettlementDepositPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a deposit payload (carries `deposit` and `voucher`).
 */
export function isBatchSettlementDepositPayload(
  payload: unknown,
): payload is BatchSettlementDepositPayload {
  return (
    isObject(payload) &&
    payload.type === "deposit" &&
    "channelConfig" in payload &&
    isVoucherFields(payload.voucher) &&
    isObject(payload.deposit) &&
    typeof payload.deposit.amount === "string" &&
    isObject(payload.deposit.authorization)
  );
}

/**
 * Type guard for {@link BatchSettlementVoucherPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a voucher payload with channel and signature fields.
 */
export function isBatchSettlementVoucherPayload(
  payload: unknown,
): payload is BatchSettlementVoucherPayload {
  return (
    isObject(payload) &&
    payload.type === "voucher" &&
    "channelConfig" in payload &&
    isVoucherFields(payload.voucher)
  );
}

/**
 * Type guard for {@link BatchSettlementRefundPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a refund payload with channel config and voucher fields.
 */
export function isBatchSettlementRefundPayload(
  payload: unknown,
): payload is BatchSettlementRefundPayload {
  return (
    isObject(payload) &&
    payload.type === "refund" &&
    "channelConfig" in payload &&
    isVoucherFields(payload.voucher)
  );
}

/**
 * Type guard for {@link BatchSettlementClaimPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `claimWithSignature` payload.
 */
export function isBatchSettlementClaimPayload(
  payload: unknown,
): payload is BatchSettlementClaimPayload {
  return isObject(payload) && payload.type === "claim" && "claims" in payload;
}

/**
 * Type guard for {@link BatchSettlementSettlePayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `settle` payload.
 */
export function isBatchSettlementSettlePayload(
  payload: unknown,
): payload is BatchSettlementSettlePayload {
  return (
    isObject(payload) && payload.type === "settle" && "receiver" in payload && "token" in payload
  );
}

/**
 * Type guard for {@link BatchSettlementEnrichedRefundPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `refundWithSignature` payload.
 */
export function isBatchSettlementEnrichedRefundPayload(
  payload: unknown,
): payload is BatchSettlementEnrichedRefundPayload {
  return (
    isBatchSettlementRefundPayload(payload) &&
    "amount" in payload &&
    "refundNonce" in payload &&
    "claims" in payload
  );
}
