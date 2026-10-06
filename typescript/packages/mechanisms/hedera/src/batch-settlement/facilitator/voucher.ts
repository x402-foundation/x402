import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import type { FacilitatorHederaBatchSigner } from "../signer";
import type {
  BatchSettlementRefundPayload,
  BatchSettlementVoucherPayload,
  ChannelConfig,
} from "../types";
import * as Errors from "../errors";
import {
  readChannelState,
  signatureCheckErrorCode,
  validateChannelConfig,
  verifyVoucherSignature,
} from "./utils";

/**
 * Verifies a cumulative voucher payload against onchain channel state.
 *
 * @param signer - Facilitator signer used for onchain reads and signature verification.
 * @param payload - Voucher or refund payload with signed voucher fields.
 * @param requirements - Server payment requirements (asset, network, amount).
 * @param channelConfig - Reconstructed channel configuration for the payer/receiver pair.
 * @returns A {@link VerifyResponse} indicating validity and returning channel state in `extra`.
 */
export async function verifyVoucher(
  signer: FacilitatorHederaBatchSigner,
  payload: BatchSettlementVoucherPayload | BatchSettlementRefundPayload,
  requirements: PaymentRequirements,
  channelConfig: ChannelConfig,
): Promise<VerifyResponse> {
  const { voucher } = payload;
  const channelId = voucher.channelId;
  const payer = channelConfig.payer;

  const configErr = validateChannelConfig(channelConfig, channelId, requirements);
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer };
  }

  const sigCheck = await verifyVoucherSignature(
    signer,
    {
      channelId,
      maxClaimableAmount: voucher.maxClaimableAmount,
      payerAuthorizer: channelConfig.payerAuthorizer,
      payer: channelConfig.payer,
      signature: voucher.signature,
    },
    requirements.network,
  );
  if (!sigCheck.ok) {
    return {
      isValid: false,
      invalidReason: signatureCheckErrorCode(sigCheck, Errors.ErrInvalidVoucherSignature),
      invalidMessage: sigCheck.message,
      payer,
    };
  }

  let state;
  try {
    state = await readChannelState(signer, channelId, requirements.network);
  } catch (error) {
    return {
      isValid: false,
      invalidReason: Errors.ErrRpcReadFailed,
      invalidMessage: error instanceof Error ? error.message : String(error),
      payer,
    };
  }

  if (state.balance === 0n) {
    return { isValid: false, invalidReason: Errors.ErrChannelNotFound, payer };
  }

  const maxClaimableAmount = BigInt(voucher.maxClaimableAmount);

  if (maxClaimableAmount > state.balance) {
    return { isValid: false, invalidReason: Errors.ErrCumulativeExceedsBalance, payer };
  }

  const belowClaimed =
    payload.type === "refund"
      ? maxClaimableAmount < state.totalClaimed
      : maxClaimableAmount <= state.totalClaimed;
  if (belowClaimed) {
    return { isValid: false, invalidReason: Errors.ErrCumulativeAmountBelowClaimed, payer };
  }

  return {
    isValid: true,
    payer,
    extra: {
      channelId,
      balance: state.balance.toString(),
      totalClaimed: state.totalClaimed.toString(),
      withdrawRequestedAt: state.withdrawRequestedAt,
      refundNonce: state.refundNonce.toString(),
    },
  };
}
