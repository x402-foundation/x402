/** Client-side check of a corrective 402's channel snapshot (spec section 4.6). */

import type { PaymentRequirements } from "@x402/core/types";

import { parseU64 } from "../../payment-channels/open";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { CLIENT_VOUCHER_EXPIRES_AT } from "../constants";
import { BatchError } from "../errors";
import {
  isBatchChannelState,
  isBatchVoucherState,
  type BatchChannelConfig,
  type BatchChannelState,
} from "../types";

/** What a client may adopt from a proven corrective snapshot. */
export interface AdoptableCorrectiveState {
  /** The cumulative base the client continues from. */
  chargedCumulativeAmount: bigint;
  /** The snapshot itself. */
  channelState: BatchChannelState;
}

/**
 * Check a corrective 402 accept before adopting its channel snapshot.
 *
 * The snapshot is only the server's word for what it has charged, so it is
 * adopted only against `voucherState`: a non-expiring voucher signature over
 * the client's own channel id (rederived, never read from the snapshot) by
 * `channelConfig.payerAuthorizer`, at a `signedMaxClaimable` the charged
 * amount does not exceed. A snapshot without that proof proves nothing; the
 * client resynchronizes from onchain state instead.
 *
 * @param args - The check inputs
 * @param args.channelId - The client's channel id, derived from its channel config
 * @param args.channelConfig - The client's channel config (its `payerAuthorizer` signs vouchers)
 * @param args.accept - The corrective 402's batch-settlement accept
 * @param args.deposit - The client's confirmed escrow ceiling, when it knows one
 * @returns The adoptable cumulative base
 * @throws Error carrying the batch-settlement reason code when the snapshot is not adoptable
 */
export async function checkCorrectiveState(args: {
  channelId: string;
  channelConfig: Pick<BatchChannelConfig, "payerAuthorizer">;
  accept: Pick<PaymentRequirements, "extra">;
  deposit?: bigint | undefined;
}): Promise<AdoptableCorrectiveState> {
  const state = args.accept.extra?.channelState;
  if (!isBatchChannelState(state)) {
    throw new Error(
      `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: corrective challenge carries no channelState`,
    );
  }
  if (state.channelId !== args.channelId) {
    throw new Error(
      `${BatchError.CHANNEL_ID_MISMATCH}: corrective channelState names a different channel`,
    );
  }
  const charged = parseU64(state.chargedCumulativeAmount ?? "0", "chargedCumulativeAmount");
  const proof = args.accept.extra?.voucherState;
  if (proof === undefined) {
    throw new Error(
      `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: corrective challenge carries no voucherState proof`,
    );
  }
  if (!isBatchVoucherState(proof)) {
    throw new Error(`${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: malformed voucherState`);
  }
  if (proof.expiresAt !== CLIENT_VOUCHER_EXPIRES_AT) {
    throw new Error(`${BatchError.VOUCHER_EXPIRY}: voucherState expiresAt must be 0`);
  }
  const signed = parseU64(proof.signedMaxClaimable, "signedMaxClaimable");
  const verified = await verifyVoucherSignature({
    message: encodeVoucherMessageBytes({
      channelId: args.channelId,
      cumulativeAmount: signed,
      expiresAt: BigInt(proof.expiresAt),
    }),
    signatureBase58: proof.signature,
    signerBase58: args.channelConfig.payerAuthorizer,
  });
  if (!verified) {
    throw new Error(
      `${BatchError.VOUCHER_SIGNATURE}: voucherState is not signed by the channel's payerAuthorizer`,
    );
  }
  if (charged > signed) {
    throw new Error(
      `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: corrective chargedCumulativeAmount ${charged} exceeds the proven signedMaxClaimable ${signed}`,
    );
  }
  // A server may never claim to have charged less than the chain has settled.
  if (charged < parseU64(state.totalClaimed, "totalClaimed")) {
    throw new Error(
      `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: corrective chargedCumulativeAmount ${charged} is below totalClaimed ${state.totalClaimed}`,
    );
  }
  if (args.deposit !== undefined && charged > args.deposit) {
    throw new Error(
      `${BatchError.CHANNEL_STATE}: corrective cumulative ${charged} exceeds the escrow ceiling ${args.deposit}`,
    );
  }
  return { chargedCumulativeAmount: charged, channelState: state };
}
