import { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { encodeFunctionData, getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import type {
  AuthorizerSigner,
  BatchSettlementEnrichedRefundPayload,
  ChannelState,
} from "../types";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import { computeChannelId } from "../utils";
import { signClaimBatch } from "../authorizerSigner";
import * as Errors from "../errors";
import { truncateErrorMessage } from "../../utils";
import { waitAndReturnSettleResponse } from "../../shared/settleReceipt";
import { buildVoucherClaimArgs } from "./claim";
import {
  findChannelEvents,
  type OnchainChannelState,
  readChannelState,
  receiptLogsUnavailableResponse,
  toChannelStateExtra,
  toContractChannelConfig,
} from "./utils";

/**
 * Computes the token amount that `refundWithSignature` would transfer after any
 * bundled claims are applied.
 *
 * @param payload - Refund payload containing requested refund amount and claims.
 * @param preState - Onchain channel state before the refund transaction.
 * @param channelId - Channel being refunded.
 * @param network - Network identifier used to compute claim channel ids.
 * @returns Refund amount if it can be determined, or `null` when claim data should be left to simulation.
 */
function getRefundableAmount(
  payload: BatchSettlementEnrichedRefundPayload,
  preState: ChannelState,
  channelId: `0x${string}`,
  network: string,
): bigint | null {
  const postClaimTotalClaimed = payload.claims.reduce((max, claim) => {
    const claimChannelId = computeChannelId(claim.voucher.channel, network);
    if (claimChannelId.toLowerCase() !== channelId.toLowerCase()) {
      return max;
    }

    const totalClaimed = BigInt(claim.totalClaimed);
    return totalClaimed > max ? totalClaimed : max;
  }, preState.totalClaimed);

  if (postClaimTotalClaimed > preState.balance) {
    return null;
  }

  const requestedAmount = BigInt(payload.amount);
  if (requestedAmount === 0n) {
    return null;
  }

  const available = preState.balance - postClaimTotalClaimed;
  return requestedAmount > available ? available : requestedAmount;
}

/**
 * Derives the post-refund channel state from the receipt events and the pre-transaction state,
 * following the contract's `_executeRefund`.
 *
 * `Refunded` carries no post-refund balance, so `balance` assumes no other balance change
 * landed between the pre-read and inclusion.
 *
 * @param preState - Onchain channel state read before the transaction.
 * @param refunded - Amount of the receipt's `Refunded` event.
 * @param claimedTotal - `newTotalClaimed` of the channel's last `Claimed` event in the same
 *   receipt, or `undefined` when no bundled claim took effect.
 * @param refundNonce - Nonce the refund consumed; the contract enforces equality, so it advances by one.
 * @returns Post-refund channel state.
 */
function deriveRefundState(
  preState: OnchainChannelState,
  refunded: bigint,
  claimedTotal: bigint | undefined,
  refundNonce: bigint,
): ChannelState {
  return {
    balance: preState.balance > refunded ? preState.balance - refunded : 0n,
    totalClaimed: claimedTotal ?? preState.totalClaimed,
    withdrawRequestedAt: refunded >= preState.withdrawAmount ? 0 : preState.withdrawRequestedAt,
    refundNonce: refundNonce + 1n,
  };
}

/**
 * Executes a cooperative refund via `refundWithSignature`.
 *
 * `refundAuthorizerSignature` is required: the facilitator has no caller authentication, so
 * it never signs a refund on the server's behalf and rejects an unsigned refund with
 * {@link Errors.ErrRefundAuthorizerSignature}. When `claimAuthorizerSignature` is absent the
 * facilitator signs the claim digest using `authorizerSigner`.
 *
 * If `payload.claims` is non-empty, the claim and refund are batched atomically via
 * the contract's `multicall`.
 *
 * @param signer - Facilitator signer used to submit the onchain transactions.
 * @param payload - Refund payload with optional signatures, amount, and nonce.
 * @param requirements - Payment requirements for network identification.
 * @param authorizerSigner - Optional dedicated key for producing EIP-712 signatures.
 *   When omitted, the payload must already carry the required authorizer signatures.
 * @param dataSuffix - Optional hex suffix appended to the refund transaction.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeRefundWithSignature(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementEnrichedRefundPayload,
  requirements: PaymentRequirements,
  authorizerSigner: AuthorizerSigner | undefined,
  dataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  const network = requirements.network;

  try {
    const refundSig = payload.refundAuthorizerSignature;
    if (!refundSig) {
      return {
        success: false,
        errorReason: Errors.ErrRefundAuthorizerSignature,
        transaction: "",
        network,
      };
    }

    const channelId = computeChannelId(payload.channelConfig, network);
    const preState = await readChannelState(signer, channelId);
    const contractAddr = getAddress(BATCH_SETTLEMENT_ADDRESS);
    const refundableAmount = getRefundableAmount(payload, preState, channelId, network);

    if (refundableAmount === 0n) {
      return {
        success: false,
        errorReason: Errors.ErrRefundNoBalance,
        errorMessage: "Nothing to refund",
        transaction: "",
        network,
      };
    }

    const refundCalldata = encodeFunctionData({
      abi: batchSettlementABI,
      functionName: "refundWithSignature",
      args: [
        toContractChannelConfig(payload.channelConfig),
        BigInt(payload.amount),
        BigInt(payload.refundNonce),
        refundSig,
      ],
    });

    let tx: `0x${string}`;

    if (payload.claims.length > 0) {
      let claimSig = payload.claimAuthorizerSignature;
      if (!claimSig) {
        if (!authorizerSigner) {
          return {
            success: false,
            errorReason: Errors.ErrAuthorizerNotConfigured,
            transaction: "",
            network,
          };
        }
        claimSig = await signClaimBatch(authorizerSigner, payload.claims, network);
      }

      const claimCalldata = encodeFunctionData({
        abi: batchSettlementABI,
        functionName: "claimWithSignature",
        args: [buildVoucherClaimArgs(payload.claims), claimSig],
      });

      try {
        await signer.readContract({
          address: contractAddr,
          abi: batchSettlementABI,
          functionName: "multicall",
          args: [[claimCalldata, refundCalldata]],
        });
      } catch (e) {
        return {
          success: false,
          errorReason: Errors.ErrRefundSimulationFailed,
          errorMessage: e instanceof Error ? e.message : String(e),
          transaction: "",
          network,
        };
      }

      tx = await signer.writeContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "multicall",
        args: [[claimCalldata, refundCalldata]],
        dataSuffix,
      });
    } else {
      try {
        await signer.readContract({
          address: contractAddr,
          abi: batchSettlementABI,
          functionName: "refundWithSignature",
          args: [
            toContractChannelConfig(payload.channelConfig),
            BigInt(payload.amount),
            BigInt(payload.refundNonce),
            refundSig,
          ],
        });
      } catch (e) {
        return {
          success: false,
          errorReason: Errors.ErrRefundSimulationFailed,
          errorMessage: e instanceof Error ? e.message : String(e),
          transaction: "",
          network,
        };
      }

      tx = await signer.writeContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "refundWithSignature",
        args: [
          toContractChannelConfig(payload.channelConfig),
          BigInt(payload.amount),
          BigInt(payload.refundNonce),
          refundSig,
        ],
        dataSuffix,
      });
    }

    return await waitAndReturnSettleResponse(signer, tx, network, payload.channelConfig.payer, {
      failedStatusReason: Errors.ErrRefundTransactionFailed,
      onSuccess: async receipt => {
        if (receipt.logs === undefined) {
          return receiptLogsUnavailableResponse(tx, network, payload.channelConfig.payer);
        }
        const refundedAmount =
          findChannelEvents(receipt.logs, "Refunded", channelId)[0]?.args.amount ?? 0n;
        if (refundedAmount <= 0n) {
          return {
            success: false,
            errorReason: Errors.ErrRefundedEventMismatch,
            errorMessage:
              "refund receipt missing Refunded event with positive amount (possible no-op early return)",
            transaction: tx,
            network,
            payer: payload.channelConfig.payer,
          };
        }

        // A claim only emits `Claimed` when it raises totalClaimed, so the last event is the highest.
        const claimed = findChannelEvents(receipt.logs, "Claimed", channelId);
        const postState = deriveRefundState(
          preState,
          refundedAmount,
          claimed[claimed.length - 1]?.args.newTotalClaimed,
          BigInt(payload.refundNonce),
        );

        return {
          success: true,
          transaction: tx,
          network,
          payer: payload.channelConfig.payer,
          amount: refundedAmount.toString(),
          extra: { channelState: toChannelStateExtra(channelId, postState) },
        };
      },
    });
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrRefundTransactionFailed,
      errorMessage: truncateErrorMessage(e instanceof Error ? e.message : String(e)),
      transaction: "",
      network,
    };
  }
}
