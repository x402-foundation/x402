import { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { getAddress, isAddressEqual, parseEventLogs } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { BatchSettlementSettlePayload } from "../types";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import * as Errors from "../errors";

/**
 * Transfers claimed funds from the contract.
 *
 * This should be called after one or more `claim()` transactions have updated the
 * receiver's `totalClaimed` accounting onchain.
 *
 * @param signer - Facilitator signer used to submit the settlement transaction.
 * @param payload - Settle payload containing the receiver address and token address.
 * @param requirements - Payment requirements for network identification.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeSettle(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementSettlePayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const network = requirements.network;
  const contractAddr = getAddress(BATCH_SETTLEMENT_ADDRESS);
  const receiver = getAddress(payload.receiver);
  const token = getAddress(payload.token);

  try {
    await signer.readContract({
      address: contractAddr,
      abi: batchSettlementABI,
      functionName: "settle",
      args: [receiver, token],
    });
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrSettleSimulationFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network,
    };
  }

  try {
    const tx = await signer.writeContract({
      address: contractAddr,
      abi: batchSettlementABI,
      functionName: "settle",
      args: [receiver, token],
    });

    const receipt = await signer.waitForTransactionReceipt({ hash: tx });

    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: Errors.ErrSettleTransactionFailed,
        errorMessage: `transaction reverted (receipt status ${receipt.status})`,
        transaction: tx,
        network,
      };
    }

    let amount = "";
    if (receipt.logs) {
      const logs = parseEventLogs({
        abi: batchSettlementABI,
        eventName: "Settled",
        logs: receipt.logs.filter(log => isAddressEqual(log.address, contractAddr)),
      });
      const settledLog = logs.find(
        log => isAddressEqual(log.args.receiver, receiver) && isAddressEqual(log.args.token, token),
      );
      amount = settledLog?.args.amount.toString() ?? "0";
    }

    return {
      success: true,
      transaction: tx,
      network,
      amount,
    };
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrSettleTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network,
    };
  }
}
