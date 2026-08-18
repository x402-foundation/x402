import { Network, SettleResponse } from "@x402/core/types";
import { invalidBroadcastHashResponse, isValidTxHash, truncateErrorMessage } from "../utils";
import { ErrInvalidTransactionState, ErrSettlementPending } from "../exact/facilitator/errors";
import { FacilitatorEvmSigner } from "../signer";

type SettleReceipt = Awaited<ReturnType<FacilitatorEvmSigner["waitForTransactionReceipt"]>>;

/**
 * Optional behavior for {@link waitAndReturnSettleResponse}.
 */
export interface WaitForSettleReceiptOptions {
  /**
   * Error reason for terminal failures: an invalid broadcast hash or reverted receipt.
   * Receipt-wait failures always report `ErrSettlementPending` regardless of this value.
   * Defaults to `ErrInvalidTransactionState`.
   */
  failedStatusReason?: string;
  /**
   * Optional check after a successful receipt (e.g. Transfer event). Return a SettleResponse
   * to fail settlement; return undefined to accept success.
   */
  validateReceipt?: (receipt: SettleReceipt) => SettleResponse | undefined;
  /** Settled amount attached on success when `onSuccess` is omitted. */
  amount?: string;
  /** Builds the success response from the receipt when set. */
  onSuccess?: (receipt: SettleReceipt) => SettleResponse | Promise<SettleResponse>;
}

/**
 * Waits for a transaction receipt and returns the appropriate SettleResponse.
 *
 * @param signer - Signer with waitForTransactionReceipt capability
 * @param tx - The transaction hash to wait for
 * @param network - Network the transaction was broadcast to
 * @param payer - The payer address
 * @param options - Optional receipt-wait behavior; see {@link WaitForSettleReceiptOptions}
 * @returns Promise resolving to a settlement response indicating success or failure
 */
export async function waitAndReturnSettleResponse(
  signer: Pick<FacilitatorEvmSigner, "waitForTransactionReceipt">,
  tx: `0x${string}`,
  network: Network,
  payer: string | undefined,
  options: WaitForSettleReceiptOptions = {},
): Promise<SettleResponse> {
  const {
    failedStatusReason = ErrInvalidTransactionState,
    validateReceipt,
    amount,
    onSuccess,
  } = options;

  if (!isValidTxHash(tx)) {
    return invalidBroadcastHashResponse(tx, failedStatusReason, network, payer);
  }

  let receipt;
  try {
    receipt = await signer.waitForTransactionReceipt({ hash: tx });
  } catch (error) {
    return settlementPendingResponse(tx, network, payer, error);
  }

  try {
    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: failedStatusReason,
        transaction: tx,
        network,
        payer,
      };
    }

    const validationFailure = validateReceipt?.(receipt);
    if (validationFailure) {
      return validationFailure;
    }

    if (onSuccess) {
      return await onSuccess(receipt);
    }

    return {
      success: true,
      transaction: tx,
      network,
      payer,
      ...(amount !== undefined ? { amount } : {}),
    };
  } catch (error) {
    // Processing a confirmed receipt threw, leaving the transaction onchain with an unknown
    // effect. A reverted receipt and an explicit validation failure return above and stay
    // terminal; this does not.
    return settlementPendingResponse(tx, network, payer, error);
  }
}

/**
 * Builds the non-terminal failure for a broadcast whose effect could not be established,
 * preserving the hash for the caller to reconcile against.
 *
 * @param tx - The broadcast transaction hash
 * @param network - Network the transaction was broadcast to
 * @param payer - The payer address
 * @param error - The receipt-wait or receipt-processing error
 * @returns Failed settle response with reason `settlement_pending`
 */
function settlementPendingResponse(
  tx: `0x${string}`,
  network: Network,
  payer: string | undefined,
  error: unknown,
): SettleResponse {
  return {
    success: false,
    errorReason: ErrSettlementPending,
    errorMessage: truncateErrorMessage(error instanceof Error ? error.message : String(error)),
    transaction: tx,
    network,
    payer,
  };
}
