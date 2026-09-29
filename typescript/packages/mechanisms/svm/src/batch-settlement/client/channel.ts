/* eslint-disable jsdoc/require-jsdoc */
/** Client-side payment-channel construction for SVM `batch-settlement`. */

import {
  createSignableMessage,
  getBase58Decoder,
  type MessagePartialSigner,
  type TransactionSigner,
} from "@solana/kit";

import { buildRequestCloseTransaction } from "../../payment-channels/close";
import { buildOpenPaymentChannelTransaction } from "../../payment-channels/open";
import { encodeVoucherMessageBytes } from "../../payment-channels/voucher";
import { signBatchAuthorization } from "../authorization";
import { CLIENT_VOUCHER_EXPIRES_AT, FULL_SPLIT_BPS } from "../constants";
import { encodeReceiverBindingMemo } from "../receiverBinding";
import type {
  BatchAuthorization,
  BatchChannelConfig,
  BatchDepositPayload,
  BatchRefundPayload,
  BatchVoucher,
} from "../types";

export type BatchClientSigner = TransactionSigner & MessagePartialSigner;

export async function signBatchVoucher(
  signer: BatchClientSigner,
  voucher: { channelId: string; maxClaimableAmount: bigint; expiresAt: number },
): Promise<BatchVoucher> {
  const message = encodeVoucherMessageBytes({
    channelId: voucher.channelId,
    cumulativeAmount: voucher.maxClaimableAmount,
    expiresAt: BigInt(voucher.expiresAt),
  });
  const [signatures] = await signer.signMessages([createSignableMessage(message)]);
  const signature = signatures[signer.address];
  if (!signature) throw new Error("payer authorizer did not return a voucher signature");
  return {
    channelId: voucher.channelId,
    expiresAt: voucher.expiresAt,
    maxClaimableAmount: voucher.maxClaimableAmount.toString(),
    signature: getBase58Decoder().decode(signature as Uint8Array),
  };
}

export class BatchChannelTracker {
  private chargedCumulativeAmount: bigint;

  constructor(
    readonly channelId: string,
    readonly channelConfig: BatchChannelConfig,
    private readonly signer: BatchClientSigner,
    initialCumulative = 0n,
  ) {
    this.chargedCumulativeAmount = initialCumulative;
  }

  get cumulative(): bigint {
    return this.chargedCumulativeAmount;
  }

  /**
   * Create, but do not commit, the next voucher.
   *
   * @param charge - The amount to add to the confirmed cumulative allocation.
   * @returns A signed voucher for the proposed cumulative allocation.
   */
  async previewVoucher(charge: bigint): Promise<BatchVoucher> {
    if (charge <= 0n) throw new Error("charge must be positive");
    if (this.channelConfig.voucherSigner === "server") {
      throw new Error("server-signed channels do not use client vouchers");
    }
    return signBatchVoucher(this.signer, {
      channelId: this.channelId,
      expiresAt: CLIENT_VOUCHER_EXPIRES_AT,
      maxClaimableAmount: this.chargedCumulativeAmount + charge,
    });
  }

  /**
   * Create an expiring payer proof for a server-signed channel.
   *
   * @param requestId - Single-use request identifier
   * @param authorizedAmount - Maximum charge in atomic units
   * @param expiresAt - Unix timestamp after which the proof is invalid
   * @returns Expiring bearer proof
   */
  async authorization(
    requestId: string,
    authorizedAmount: bigint,
    expiresAt: number,
  ): Promise<BatchAuthorization> {
    if (this.channelConfig.voucherSigner !== "server") {
      throw new Error("client-signed channels do not use server authorization");
    }
    return signBatchAuthorization(
      this.signer,
      this.channelId,
      this.channelConfig.payerAuthorizer,
      requestId,
      authorizedAmount,
      expiresAt,
    );
  }

  /**
   * Commit a cumulative amount confirmed by the resource server.
   *
   * @param cumulative - The confirmed cumulative allocation.
   */
  commit(cumulative: bigint): void {
    if (cumulative < this.chargedCumulativeAmount) {
      throw new Error("confirmed cumulative amount cannot move backwards");
    }
    this.chargedCumulativeAmount = cumulative;
  }

  async voucher(charge: bigint): Promise<BatchVoucher> {
    const voucher = await this.previewVoucher(charge);
    this.commit(this.chargedCumulativeAmount + charge);
    return voucher;
  }

  /**
   * Client-mode refund voucher at the confirmed cumulative allocation.
   *
   * @returns A voucher signed for the charged cumulative amount
   */
  async refundVoucher(): Promise<BatchVoucher> {
    if (this.channelConfig.voucherSigner === "server") {
      throw new Error("server-signed channels refund with payer authorization");
    }
    return signBatchVoucher(this.signer, {
      channelId: this.channelId,
      expiresAt: CLIENT_VOUCHER_EXPIRES_AT,
      maxClaimableAmount: this.chargedCumulativeAmount,
    });
  }
}

// Client voucher, or the payer authorization a server-signed charge needs.
export async function credentialFor(
  mode: "client",
  tracker: BatchChannelTracker,
  charge: bigint,
  authorization?: undefined,
  refund?: boolean,
): Promise<{ voucher: BatchVoucher }>;
export async function credentialFor(
  mode: "server",
  tracker: BatchChannelTracker,
  charge: bigint,
  authorization: { requestId: string; expiresAt: number },
  refund?: boolean,
): Promise<{ authorization: BatchAuthorization }>;
export async function credentialFor(
  mode: "client" | "server",
  tracker: BatchChannelTracker,
  charge: bigint,
  authorization?: { requestId: string; expiresAt: number },
  refund = false,
): Promise<{ voucher: BatchVoucher } | { authorization: BatchAuthorization }> {
  switch (mode) {
    case "client":
      return {
        voucher: refund ? await tracker.refundVoucher() : await tracker.previewVoucher(charge),
      };
    case "server": {
      if (!authorization) {
        throw new Error("authorizationExpiresAt is required for operator voucher signing");
      }
      return {
        authorization: await tracker.authorization(
          authorization.requestId,
          charge,
          authorization.expiresAt,
        ),
      };
    }
    default: {
      const unexpected: never = mode;
      throw new Error(String(unexpected));
    }
  }
}

export interface BuildDepositArgs {
  payer: BatchClientSigner;
  receiver: string;
  receiverAuthorizer: string;
  mint: string;
  feePayer: string;
  tokenProgram: string;
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  openSlot: bigint;
  depositAmount: bigint;
  firstCharge: bigint;
  withdrawDelay: number;
  memo?: string | undefined;
  /** Channel-derivation salt; random when omitted. */
  salt?: bigint | undefined;
  voucherSigner?: "client" | "server" | undefined;
  operator?: string | undefined;
  authorizationExpiresAt?: number | undefined;
}

export interface BuiltDeposit {
  channelId: string;
  payload: BatchDepositPayload;
  tracker: BatchChannelTracker;
}

export async function buildDepositPayload(args: BuildDepositArgs): Promise<BuiltDeposit> {
  if (args.firstCharge <= 0n || args.firstCharge > args.depositAmount) {
    throw new Error("first charge must be positive and no greater than the deposit");
  }
  if (args.openSlot > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("openSlot must fit in a JavaScript safe integer");
  }
  const voucherSigner = args.voucherSigner ?? "client";
  const authorizedSigner = voucherSigner === "server" ? args.operator : args.payer.address;
  if (!authorizedSigner) throw new Error("operator is required for operator voucher signing");
  const authorizationExpiresAt = args.authorizationExpiresAt;
  let pendingAuthorization: { requestId: string; expiresAt: number } | undefined;
  if (voucherSigner === "server") {
    if (
      authorizationExpiresAt === undefined ||
      !Number.isSafeInteger(authorizationExpiresAt) ||
      authorizationExpiresAt <= 0
    ) {
      throw new Error("authorizationExpiresAt is required for operator voucher signing");
    }
    pendingAuthorization = { requestId: crypto.randomUUID(), expiresAt: authorizationExpiresAt };
  }
  const open = await buildOpenPaymentChannelTransaction({
    authorizedSigner,
    bindingMemo: encodeReceiverBindingMemo(args.receiverAuthorizer),
    blockhash: args.blockhash,
    deposit: args.depositAmount,
    feePayer: args.feePayer,
    gracePeriod: args.withdrawDelay,
    memo: args.memo,
    mint: args.mint,
    openSlot: args.openSlot,
    payee: args.feePayer,
    payer: args.payer,
    recipients: [{ bps: FULL_SPLIT_BPS, recipient: args.receiver }],
    ...(args.salt !== undefined ? { salt: args.salt } : {}),
    tokenProgram: args.tokenProgram,
  });
  const channelConfig: BatchChannelConfig = {
    openSlot: Number(open.openSlot),
    payer: args.payer.address,
    payerAuthorizer: authorizedSigner,
    receiver: args.receiver,
    receiverAuthorizer: args.receiverAuthorizer,
    salt: open.salt.toString(),
    token: args.mint,
    withdrawDelay: args.withdrawDelay,
    ...(voucherSigner === "server" ? { voucherSigner } : {}),
  };
  const tracker = new BatchChannelTracker(open.channelId, channelConfig, args.payer);
  // A payment payload is only an authorization.  Do not advance local state
  // until the resource server confirms it in PAYMENT-RESPONSE.
  const credential = pendingAuthorization
    ? await credentialFor("server", tracker, args.firstCharge, pendingAuthorization)
    : await credentialFor("client", tracker, args.firstCharge);
  return {
    channelId: open.channelId,
    payload: {
      channelConfig,
      deposit: { amount: args.depositAmount.toString(), transaction: open.transaction },
      type: "deposit",
      ...credential,
    },
    tracker,
  };
}

// `blockhash` adds a payer-signed request_close for a facilitator that cannot
// close cooperatively.
export async function buildRefundPayload(args: {
  payer: BatchClientSigner;
  feePayer: string;
  channelId: string;
  channelConfig: BatchChannelConfig;
  voucher?: BatchVoucher | undefined;
  authorization?: BatchAuthorization | undefined;
  blockhash?: { blockhash: string; lastValidBlockHeight: bigint } | undefined;
  memo?: string | undefined;
}): Promise<BatchRefundPayload> {
  const serverMode = args.channelConfig.voucherSigner === "server";
  const credential = serverMode
    ? { authorization: serverRefundAuthorization(args) }
    : { voucher: clientRefundVoucher(args) };
  if (args.blockhash === undefined) {
    return { channelConfig: args.channelConfig, type: "refund", ...credential };
  }
  return {
    channelConfig: args.channelConfig,
    transaction: await buildRequestCloseTransaction({
      blockhash: args.blockhash,
      channelId: args.channelId,
      feePayer: args.feePayer,
      memo: args.memo,
      payer: args.payer,
    }),
    type: "refund",
    ...credential,
  };
}

function serverRefundAuthorization(args: {
  authorization?: BatchAuthorization | undefined;
  voucher?: BatchVoucher | undefined;
}): BatchAuthorization {
  if (!args.authorization || args.voucher !== undefined) {
    throw new Error("server-signed refund requires payer authorization only");
  }
  return args.authorization;
}

function clientRefundVoucher(args: {
  authorization?: BatchAuthorization | undefined;
  voucher?: BatchVoucher | undefined;
}): BatchVoucher {
  if (!args.voucher || args.authorization !== undefined) {
    throw new Error("client-signed refund requires a voucher");
  }
  return args.voucher;
}
