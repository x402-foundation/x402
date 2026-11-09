import { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import {
  BatchSettlementRefundPayload,
  BatchSettlementVoucherPayload,
  ChannelConfig,
} from "../types";
import { getEvmChainId } from "../../utils";
import * as Errors from "../errors";
import {
  parseRequirementsAmount,
  validateChannelConfig,
  verifyBatchSettlementVoucherTypedData,
  readChannelState,
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
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementVoucherPayload | BatchSettlementRefundPayload,
  requirements: PaymentRequirements,
  channelConfig: ChannelConfig,
): Promise<VerifyResponse> {
  const { voucher } = payload;
  const channelId = voucher.channelId;
  const chainId = getEvmChainId(requirements.network);

  const configErr = validateChannelConfig(channelConfig, channelId, requirements);
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer: channelConfig.payer };
  }

  // Refunds are zero-charge and never consult the price; every other payload is floored by it.
  const isRefund = payload.type === "refund";
  const price = isRefund ? 0n : parseRequirementsAmount(requirements.amount);
  if (price === undefined) {
    return {
      isValid: false,
      invalidReason: Errors.ErrInvalidVoucherPayload,
      invalidMessage: "invalid requirements amount",
      payer: channelConfig.payer,
    };
  }

  const voucherOk = await verifyBatchSettlementVoucherTypedData(
    signer,
    {
      channelId,
      maxClaimableAmount: voucher.maxClaimableAmount,
      payerAuthorizer: channelConfig.payerAuthorizer,
      payer: channelConfig.payer,
      signature: voucher.signature,
    },
    chainId,
  );
  if (!voucherOk) {
    return {
      isValid: false,
      invalidReason: Errors.ErrInvalidVoucherSignature,
      payer: channelConfig.payer,
    };
  }

  const state = await readChannelState(signer, channelId);

  if (state.balance === 0n) {
    return { isValid: false, invalidReason: Errors.ErrChannelNotFound, payer: channelConfig.payer };
  }

  const maxClaimableAmount = BigInt(voucher.maxClaimableAmount);

  if (maxClaimableAmount > state.balance) {
    return {
      isValid: false,
      invalidReason: Errors.ErrCumulativeExceedsBalance,
      payer: channelConfig.payer,
    };
  }

  // Refunds are zero-charge, so the ceiling only has to cover what is already claimed; any other
  // payload must advance the claimed total by at least the price of this request.
  const belowClaimed = isRefund
    ? maxClaimableAmount < state.totalClaimed
    : maxClaimableAmount < state.totalClaimed + price || maxClaimableAmount <= state.totalClaimed;
  if (belowClaimed) {
    return {
      isValid: false,
      invalidReason: Errors.ErrCumulativeAmountBelowClaimed,
      payer: channelConfig.payer,
    };
  }

  return {
    isValid: true,
    payer: channelConfig.payer,
    extra: {
      channelId,
      balance: state.balance.toString(),
      totalClaimed: state.totalClaimed.toString(),
      withdrawRequestedAt: state.withdrawRequestedAt,
      refundNonce: state.refundNonce.toString(),
    },
  };
}
