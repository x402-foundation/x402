import { SettleResponse, PaymentRequirements } from "@x402/core/types";
import { getAddress, isAddressEqual, parseEventLogs } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { BatchSettlementSettlePayload } from "../types";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import * as Errors from "../errors";

/**
 * Explicit gas limit for the `settle` transaction.
 *
 * `settle` auto-estimation is unsafe: the on-chain `settle` is bimodal — it
 * early-returns (~25.5k gas) when `totalClaimed == totalSettled`, and performs
 * an SSTORE plus an ERC-20 transfer (~57k gas) otherwise. The `eth_estimateGas`
 * viem runs for `writeContract` is an independent RPC call that can resolve
 * against a node whose state has not yet caught up to the just-mined `claim`;
 * it then estimates the early-return path and the transaction is broadcast
 * under-gassed, reverting out of gas once the claim is visible.
 *
 * `settle`'s cost is bounded (one SSTORE + one transfer, no loop — it does not
 * scale with voucher or channel count), so a fixed limit is correct here. This
 * value leaves roughly a 2x margin over the observed transfer-path cost.
 * `deposit-permit2.ts` uses the same explicit-gas pattern.
 */
const SETTLE_GAS_LIMIT = 120_000n;

/**
 * Transfers claimed funds from the contract.
 *
 * This should be called after one or more `claim()` transactions have updated the
 * receiver's `totalClaimed` accounting onchain.
 *
 * @param signer - Facilitator signer used to submit the settlement transaction.
 * @param payload - Settle payload containing the receiver address and token address.
 * @param requirements - Payment requirements for network identification.
 * @param dataSuffix - Optional hex suffix appended to the settlement transaction.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeSettle(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementSettlePayload,
  requirements: PaymentRequirements,
  dataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  const network = requirements.network;
  const contractAddr = getAddress(BATCH_SETTLEMENT_ADDRESS);
  const receiver = getAddress(payload.receiver);
  const token = getAddress(payload.token);

  // Check if there is anything to settle
  try {
    const [totalClaimed, totalSettled] = (await signer.readContract({
      address: contractAddr,
      abi: batchSettlementABI,
      functionName: "receivers",
      args: [receiver, token],
    })) as readonly [bigint, bigint];

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
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network,
    };
  }

  // Simulate the settle transaction
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
      gas: SETTLE_GAS_LIMIT,
      dataSuffix,
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
