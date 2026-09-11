/* eslint-disable jsdoc/require-param-description */
/** Signed itemized receipts for server-metered batch-settlement requests. */

import {
  createSignableMessage,
  getBase58Decoder,
  getBase58Encoder,
  type MessagePartialSigner,
} from "@solana/kit";

import { verifyEd25519Signature } from "../payment-channels/voucher";
import type { BatchSettlementReceipt, BatchVoucher } from "./types";

const RECEIPT_DOMAIN = new TextEncoder().encode("x402-batch-receipt-v1");
const MAX_IDEMPOTENCY_KEY_BYTES = 256;

/**
 * Encode the complete server-metering result covered by the operator signature.
 *
 * @param receipt
 * @param receipt.channelId
 * @param receipt.idempotencyKey
 * @param receipt.authorizedAmount
 * @param receipt.chargedAmount
 * @param receipt.priorCumulativeAmount
 * @param receipt.cumulativeAmount
 * @returns Canonical receipt message bytes
 */
export function encodeBatchSettlementReceiptMessage(receipt: {
  channelId: string;
  idempotencyKey: string;
  authorizedAmount: bigint;
  chargedAmount: bigint;
  priorCumulativeAmount: bigint;
  cumulativeAmount: bigint;
}): Uint8Array {
  const channel = getBase58Encoder().encode(receipt.channelId);
  if (channel.byteLength !== 32) throw new Error("batch receipt channelId must decode to 32 bytes");
  const key = new TextEncoder().encode(receipt.idempotencyKey);
  if (key.byteLength === 0 || key.byteLength > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new Error("batch receipt idempotencyKey must encode to 1 through 256 bytes");
  }
  const message = new Uint8Array(RECEIPT_DOMAIN.byteLength + 32 + 2 + key.byteLength + 32);
  let offset = 0;
  message.set(RECEIPT_DOMAIN, offset);
  offset += RECEIPT_DOMAIN.byteLength;
  message.set(channel, offset);
  offset += 32;
  new DataView(message.buffer).setUint16(offset, key.byteLength, true);
  offset += 2;
  message.set(key, offset);
  offset += key.byteLength;
  const view = new DataView(message.buffer);
  for (const amount of [
    receipt.authorizedAmount,
    receipt.chargedAmount,
    receipt.priorCumulativeAmount,
    receipt.cumulativeAmount,
  ]) {
    view.setBigUint64(offset, amount, true);
    offset += 8;
  }
  return message;
}

/**
 * Sign an itemized server-metering receipt.
 *
 * @param operator
 * @param fields
 * @param fields.channelId
 * @param fields.idempotencyKey
 * @param fields.authorizedAmount
 * @param fields.chargedAmount
 * @param fields.priorCumulativeAmount
 * @param fields.cumulativeAmount
 * @param fields.voucher
 * @returns The signed wire receipt
 */
export async function signBatchSettlementReceipt(
  operator: MessagePartialSigner,
  fields: {
    channelId: string;
    idempotencyKey: string;
    authorizedAmount: bigint;
    chargedAmount: bigint;
    priorCumulativeAmount: bigint;
    cumulativeAmount: bigint;
    voucher: BatchVoucher;
  },
): Promise<BatchSettlementReceipt> {
  const message = encodeBatchSettlementReceiptMessage(fields);
  const [signatures] = await operator.signMessages([createSignableMessage(message)]);
  const signature = signatures[operator.address];
  if (!signature) throw new Error("operator did not return a batch receipt signature");
  return {
    type: "receipt",
    channelId: fields.channelId,
    idempotencyKey: fields.idempotencyKey,
    authorizedAmount: fields.authorizedAmount.toString(),
    chargedAmount: fields.chargedAmount.toString(),
    priorCumulativeAmount: fields.priorCumulativeAmount.toString(),
    cumulativeAmount: fields.cumulativeAmount.toString(),
    voucher: fields.voucher,
    signature: getBase58Decoder().decode(signature as Uint8Array),
  };
}

/**
 * Verify an itemized receipt against the channel's delegated operator.
 *
 * @param receipt
 * @param operator
 * @returns Whether the receipt signature and encoding are valid
 */
export async function verifyBatchSettlementReceipt(
  receipt: BatchSettlementReceipt,
  operator: string,
): Promise<boolean> {
  try {
    const base58 = getBase58Encoder();
    return await verifyEd25519Signature({
      message: encodeBatchSettlementReceiptMessage({
        channelId: receipt.channelId,
        idempotencyKey: receipt.idempotencyKey,
        authorizedAmount: BigInt(receipt.authorizedAmount),
        chargedAmount: BigInt(receipt.chargedAmount),
        priorCumulativeAmount: BigInt(receipt.priorCumulativeAmount),
        cumulativeAmount: BigInt(receipt.cumulativeAmount),
      }),
      publicKey: base58.encode(operator) as Uint8Array,
      signature: base58.encode(receipt.signature) as Uint8Array,
    });
  } catch {
    return false;
  }
}
