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
import type {
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
    return signBatchVoucher(this.signer, {
      channelId: this.channelId,
      expiresAt: 0,
      maxClaimableAmount: this.chargedCumulativeAmount + charge,
    });
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
}

export interface BuildDepositArgs {
  payer: BatchClientSigner;
  receiver: string;
  receiverAuthorizer?: string | undefined;
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
  const open = await buildOpenPaymentChannelTransaction({
    authorizedSigner: args.payer.address,
    blockhash: args.blockhash,
    deposit: args.depositAmount,
    feePayer: args.feePayer,
    gracePeriod: args.withdrawDelay,
    memo: args.memo,
    mint: args.mint,
    openSlot: args.openSlot,
    payee: args.feePayer,
    payer: args.payer,
    recipients: [{ bps: 10_000, recipient: args.receiver }],
    ...(args.salt !== undefined ? { salt: args.salt } : {}),
    tokenProgram: args.tokenProgram,
  });
  const channelConfig: BatchChannelConfig = {
    openSlot: Number(open.openSlot),
    payer: args.payer.address,
    payerAuthorizer: args.payer.address,
    receiver: args.receiver,
    ...(args.receiverAuthorizer ? { receiverAuthorizer: args.receiverAuthorizer } : {}),
    salt: open.salt.toString(),
    token: args.mint,
    withdrawDelay: args.withdrawDelay,
  };
  const tracker = new BatchChannelTracker(open.channelId, channelConfig, args.payer);
  // A payment payload is only an authorization.  Do not advance local state
  // until the resource server confirms it in PAYMENT-RESPONSE.
  const voucher = await tracker.previewVoucher(args.firstCharge);
  return {
    channelId: open.channelId,
    payload: {
      channelConfig,
      deposit: { amount: args.depositAmount.toString(), transaction: open.transaction },
      type: "deposit",
      voucher,
    },
    tracker,
  };
}

export async function buildRefundPayload(args: {
  payer: BatchClientSigner;
  feePayer: string;
  channelId: string;
  channelConfig: BatchChannelConfig;
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  memo?: string | undefined;
}): Promise<BatchRefundPayload> {
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
  };
}
