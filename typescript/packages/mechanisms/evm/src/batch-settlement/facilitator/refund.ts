import { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { encodeFunctionData, getAddress, isAddressEqual, type Log } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import type {
  AuthorizerSigner,
  BatchSettlementEnrichedRefundPayload,
  ChannelState,
} from "../types";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import { computeChannelId } from "../utils";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import * as Errors from "../errors";
import { truncateErrorMessage } from "../../utils";
import { waitAndReturnSettleResponse } from "../../shared/settleReceipt";
import { buildVoucherClaimArgs } from "./claim";
import {
  findChannelEvents,
  type OnchainChannelState,
  readChannelState,
  receiptLogsUnavailableResponse,
  toContractChannelConfig,
  validateChannelConfig,
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
 * Post-refund balance from a same-receipt deposit.
 *
 * `Deposited.newBalance` is absolute. One `Refunded` after the last deposit is subtracted.
 * A negative result returns `undefined` so the pre-read is used instead.
 *
 * @param logs - Receipt logs.
 * @param channelId - The refunded channel.
 * @returns Balance after that deposit, or `undefined` when the receipt has none or the result is negative.
 */
function eventRefundBalance(logs: readonly Log[], channelId: `0x${string}`): bigint | undefined {
  let balance: bigint | undefined;
  let depositAt = -1;
  for (let index = 0; index < logs.length; index++) {
    const log = logs[index];
    if (log === undefined) continue;
    const deposited = findChannelEvents([log], "Deposited", channelId)[0];
    if (!deposited) continue;
    balance = deposited.args.newBalance;
    depositAt = index;
  }
  if (balance === undefined) return undefined;
  for (let index = depositAt + 1; index < logs.length; index++) {
    const log = logs[index];
    if (log === undefined) continue;
    const refunded = findChannelEvents([log], "Refunded", channelId)[0];
    if (!refunded || refunded.args.amount <= 0n) continue;
    const next = balance - refunded.args.amount;
    if (next < 0n) return undefined;
    return next;
  }
  return balance;
}

type RefundChannelState = Omit<ChannelState, "balance"> & { balance?: bigint };

/**
 * Pre-read balance minus the refunded amount, or `undefined` when it cannot be trusted.
 *
 * `finalizeWithdraw` lowers the balance without a `Refunded` event or a `refundNonce` change.
 * It is only callable once a withdrawal is pending and `withdrawDelay` has elapsed, so the
 * figure is an upper bound on the onchain balance only while no withdrawal was pending at the
 * pre-read and less than half of `withdrawDelay` has passed since then.
 *
 * @param preState - Channel state read before the transaction.
 * @param refunded - Amount of the receipt `Refunded` event.
 * @param withdrawDelay - Channel withdraw delay in seconds.
 * @returns The balance, or `undefined` when a withdrawal may have finalized or the result is negative.
 */
function preReadRefundBalance(
  preState: OnchainChannelState,
  refunded: bigint,
  withdrawDelay: number,
): bigint | undefined {
  const withdrawMayHaveFinalized =
    preState.withdrawRequestedAt !== 0 || Date.now() - preState.readAt >= withdrawDelay * 500;
  const balance = preState.balance - refunded;
  return withdrawMayHaveFinalized || balance < 0n ? undefined : balance;
}

/**
 * Builds the post-refund channel state from the pre-read and receipt events.
 *
 * A same-receipt `Deposited.newBalance` wins. Next, a same-receipt `ChannelClosed` means the
 * channel is empty with no pending withdrawal. Otherwise balance comes from the pre-read
 * minus `Refunded.amount`, and is omitted when that figure cannot be trusted.
 *
 * @param preState - Channel state read before the transaction.
 * @param logs - Receipt logs.
 * @param channelId - The refunded channel.
 * @param refunded - Amount of the receipt `Refunded` event.
 * @param claimedTotal - Last `Claimed.newTotalClaimed` in the receipt, if any.
 * @param refundNonce - Nonce the refund consumed.
 * @param withdrawDelay - Channel withdraw delay in seconds.
 * @returns Post-refund channel state. `balance` is absent when it cannot be derived safely.
 */
function deriveRefundState(
  preState: OnchainChannelState,
  logs: readonly Log[],
  channelId: `0x${string}`,
  refunded: bigint,
  claimedTotal: bigint | undefined,
  refundNonce: bigint,
  withdrawDelay: number,
): RefundChannelState {
  const eventBalance = eventRefundBalance(logs, channelId);
  if (
    eventBalance === undefined &&
    findChannelEvents(logs, "ChannelClosed", channelId).length > 0
  ) {
    return { balance: 0n, totalClaimed: 0n, withdrawRequestedAt: 0, refundNonce: refundNonce + 1n };
  }
  return {
    balance: eventBalance ?? preReadRefundBalance(preState, refunded, withdrawDelay),
    totalClaimed: claimedTotal ?? preState.totalClaimed,
    withdrawRequestedAt: refunded >= preState.withdrawAmount ? 0 : preState.withdrawRequestedAt,
    refundNonce: refundNonce + 1n,
  };
}

/**
 * Executes a cooperative refund via `refundWithSignature`.
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
 * @param delegatedRefund - When `true`, sign a refund that carries no `refundAuthorizerSignature`
 *   with `authorizerSigner`. Only safe when `/settle` callers are authenticated out of band.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeRefundWithSignature(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementEnrichedRefundPayload,
  requirements: PaymentRequirements,
  authorizerSigner: AuthorizerSigner | undefined,
  dataSuffix?: `0x${string}`,
  delegatedRefund = false,
): Promise<SettleResponse> {
  const network = requirements.network;

  try {
    const channelId = computeChannelId(payload.channelConfig, network);

    let refundSig = payload.refundAuthorizerSignature;
    if (!refundSig) {
      if (!delegatedRefund || authorizerSigner === undefined) {
        return {
          success: false,
          errorReason: Errors.ErrRefundAuthorizerSignature,
          transaction: "",
          network,
        };
      }
      if (!isAddressEqual(payload.channelConfig.receiverAuthorizer, authorizerSigner.address)) {
        return {
          success: false,
          errorReason: Errors.ErrAuthorizerAddressMismatch,
          transaction: "",
          network,
        };
      }
      const configErr = validateChannelConfig(payload.channelConfig, channelId, requirements);
      if (configErr) {
        return { success: false, errorReason: configErr, transaction: "", network };
      }
    }

    let preState: OnchainChannelState;
    try {
      preState = await readChannelState(signer, channelId);
    } catch (e) {
      return {
        success: false,
        errorReason: Errors.ErrRpcReadFailed,
        errorMessage: truncateErrorMessage(
          `failed to read channel state: ${e instanceof Error ? e.message : String(e)}`,
        ),
        transaction: "",
        network,
      };
    }
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

    if (!refundSig) {
      if (authorizerSigner === undefined) {
        return {
          success: false,
          errorReason: Errors.ErrRefundAuthorizerSignature,
          transaction: "",
          network,
        };
      }
      refundSig = await signRefund(
        authorizerSigner,
        channelId,
        payload.amount,
        payload.refundNonce,
        network,
      );
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
      revertedReason: Errors.ErrTransactionReverted,
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

        const claimed = findChannelEvents(receipt.logs, "Claimed", channelId);
        const postState = deriveRefundState(
          preState,
          receipt.logs,
          channelId,
          refundedAmount,
          claimed[claimed.length - 1]?.args.newTotalClaimed,
          BigInt(payload.refundNonce),
          payload.channelConfig.withdrawDelay,
        );

        return {
          success: true,
          transaction: tx,
          network,
          payer: payload.channelConfig.payer,
          amount: refundedAmount.toString(),
          extra: {
            channelState: {
              channelId,
              totalClaimed: postState.totalClaimed.toString(),
              withdrawRequestedAt: postState.withdrawRequestedAt,
              refundNonce: postState.refundNonce.toString(),
              ...(postState.balance !== undefined ? { balance: postState.balance.toString() } : {}),
            },
          },
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
