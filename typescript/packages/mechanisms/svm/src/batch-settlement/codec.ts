/** Canonical byte encodings and derivations of the SVM `batch-settlement` scheme. */

import { findPaymentChannelPda, parseU64 } from "../payment-channels/open";
import { encodeVoucherMessageBytes } from "../payment-channels/voucher";
import type { BatchChannelConfig, BatchVoucher } from "./types";

/**
 * Encode the 50-byte message a batch-settlement voucher signs: the payment-
 * channels voucher magic, the channel id, `maxClaimableAmount` as u64 LE and
 * `expiresAt` as i64 LE.
 *
 * @param voucher - The voucher fields; `maxClaimableAmount` is a decimal u64 string
 * @param voucher.channelId - Channel PDA (base58)
 * @param voucher.maxClaimableAmount - Cumulative claimable amount (decimal string)
 * @param voucher.expiresAt - Expiry in the signed message (Unix seconds)
 * @returns The voucher message bytes
 * @throws Error when a field is malformed (a non-decimal amount, a channel id that is not 32 bytes)
 */
export function encodeBatchVoucherMessage(
  voucher: Pick<BatchVoucher, "channelId" | "maxClaimableAmount" | "expiresAt">,
): Uint8Array {
  if (!Number.isSafeInteger(voucher.expiresAt)) {
    throw new Error("expiresAt must be a safe integer");
  }
  return encodeVoucherMessageBytes({
    channelId: voucher.channelId,
    cumulativeAmount: parseU64(voucher.maxClaimableAmount, "maxClaimableAmount"),
    expiresAt: BigInt(voucher.expiresAt),
  });
}

/**
 * Derive a batch-settlement channel id: the payment-channels PDA over
 * `("channel", payer, feePayer, token, payerAuthorizer, salt u64 LE,
 * openSlot u64 LE)`. `receiver` and `receiverAuthorizer` are not seeds.
 *
 * @param config - The channel configuration; `salt` is a decimal u64 string
 * @param feePayer - The route's `extra.feePayer`, the program payee seed
 * @param programId - Optional payment-channels program id override
 * @returns The channel PDA (base58)
 * @throws Error when `salt` or `openSlot` is not an unsigned 64-bit integer
 */
export async function deriveBatchChannelId(
  config: Pick<BatchChannelConfig, "payer" | "payerAuthorizer" | "token" | "salt" | "openSlot">,
  feePayer: string,
  programId?: string,
): Promise<string> {
  return findPaymentChannelPda({
    authorizedSigner: config.payerAuthorizer,
    mint: config.token,
    openSlot: parseU64(config.openSlot, "channelConfig.openSlot"),
    payee: feePayer,
    payer: config.payer,
    programId,
    salt: parseU64(config.salt, "channelConfig.salt"),
  });
}
