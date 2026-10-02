import type { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { getAddress, isAddressEqual, parseEventLogs, type Log } from "viem";
import type { FacilitatorHederaBatchSigner } from "../signer";
import type { BatchSettlementSettlePayload } from "../types";
import { batchSettlementABI } from "../abi";
import {
  CHANNEL_STATE_POLL_INTERVAL_MS,
  CHANNEL_STATE_POLL_MS,
  HEDERA_GAS,
  getBatchSettlementDeployment,
} from "../constants";
import * as Errors from "../errors";
import { runContractSettlement, truncate } from "../transport";
import { resolveTokenId } from "./utils";

/** Options for settle execution. */
export type SettleExecutionOptions = {
  simulateBeforeSend?: boolean;
  gas?: bigint;
  /** How long to re-read `receivers` while it still reports nothing to settle (Mirror Node lag). */
  pollMs?: number;
};

/**
 * Transfers claimed funds from the escrow to the receiver via `settle(receiver, token)`.
 *
 * @param signer - Facilitator signer used to submit the settlement transaction.
 * @param payload - Settle payload containing the receiver address and token address.
 * @param requirements - Payment requirements for network identification.
 * @param options - Simulation / gas options.
 * @returns A {@link SettleResponse} with the transaction id and swept `amount` on success.
 */
export async function executeSettle(
  signer: FacilitatorHederaBatchSigner,
  payload: BatchSettlementSettlePayload,
  requirements: PaymentRequirements,
  options: SettleExecutionOptions = {},
): Promise<SettleResponse> {
  const network = requirements.network;
  const contractAddr = getAddress(getBatchSettlementDeployment(network).settlement);
  const receiver = getAddress(payload.receiver);
  const token = getAddress(payload.token);

  try {
    // The Mirror Node lags consensus by a few seconds; a settle that immediately follows a claim
    // may read stale aggregates, so poll briefly before concluding there is nothing to settle.
    const deadline = Date.now() + (options.pollMs ?? CHANNEL_STATE_POLL_MS);
    let totalClaimed = 0n;
    let totalSettled = 0n;
    for (;;) {
      [totalClaimed, totalSettled] = (await signer.readContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "receivers",
        args: [receiver, token],
      })) as readonly [bigint, bigint];
      if (totalClaimed > totalSettled || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, CHANNEL_STATE_POLL_INTERVAL_MS));
    }

    if (totalClaimed <= totalSettled) {
      return {
        success: false,
        errorReason: Errors.ErrNothingToSettle,
        errorMessage: "nothing to settle for receiver and token",
        transaction: "",
        network,
      };
    }
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrRpcReadFailed,
      errorMessage: truncate(e instanceof Error ? e.message : String(e)),
      transaction: "",
      network,
    };
  }

  // The receiver must be able to hold the HTS token, otherwise the transfer reverts.
  const tokenId = resolveTokenId(token);
  if (tokenId) {
    try {
      if (!(await signer.mirror.canReceiveToken(receiver, tokenId))) {
        return {
          success: false,
          errorReason: Errors.ErrTokenNotAssociated,
          errorMessage: `receiver ${receiver} is not associated with ${tokenId}`,
          transaction: "",
          network,
        };
      }
    } catch (e) {
      return {
        success: false,
        errorReason: Errors.ErrRpcReadFailed,
        errorMessage: truncate(e instanceof Error ? e.message : String(e)),
        transaction: "",
        network,
      };
    }
  }

  if (options.simulateBeforeSend ?? true) {
    try {
      await signer.simulateContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "settle",
        args: [receiver, token],
      });
    } catch (e) {
      return {
        success: false,
        errorReason: Errors.ErrSettleSimulationFailed,
        errorMessage: truncate(e instanceof Error ? e.message : String(e)),
        transaction: "",
        network,
      };
    }
  }

  return runContractSettlement(
    () =>
      signer.executeContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: "settle",
        args: [receiver, token],
        gas: options.gas ?? HEDERA_GAS.settle,
      }),
    network,
    undefined,
    {
      failedStatusReason: Errors.ErrSettleTransactionFailed,
      onSuccess: result => {
        let amount = "0";
        try {
          const logs = parseEventLogs({
            abi: batchSettlementABI,
            eventName: "Settled",
            logs: result.logs.filter(log =>
              isAddressEqual(log.address, contractAddr),
            ) as unknown as Log[],
          });
          const settledLog = logs.find(
            log =>
              isAddressEqual(log.args.receiver, receiver) && isAddressEqual(log.args.token, token),
          );
          amount = settledLog?.args.amount.toString() ?? "0";
        } catch {
          // Leave amount as "0" when logs cannot be decoded.
        }
        return { success: true, transaction: result.transactionId, network, amount };
      },
    },
  );
}
