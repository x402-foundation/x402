import { Network, SettleResponse } from "@x402/core/types";
import { PendingSettlementStore } from "@x402/core/facilitator";
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
 * Wraps a settle attempt with `PendingSettlementStore` bookkeeping: only a
 * retryable `settlement_pending` failure (carrying a broadcast transaction
 * hash) is recorded, so a subsequent settle attempt for the same payload can
 * reconcile against it instead of re-broadcasting. Every other outcome —
 * success, or any terminal failure (e.g. a reverted receipt) — clears the
 * entry instead; a terminal failure still has a `transaction` hash but is
 * not safe to reconcile against indefinitely, so it must not be cached until
 * TTL expiry.
 *
 * If persisting the pending entry itself fails, a later retry has no record
 * to reconcile against — blindly returning `settlement_pending` would let it
 * re-verify/re-broadcast and risk a double-send. That case is downgraded to
 * `nonRetryableReason`, preserving the transaction hash for manual
 * reconciliation. A failure to clear the entry (success or terminal-failure
 * path) is swallowed instead: the settle outcome is already correct and
 * must not be masked by a storage hiccup, and a stale entry merely lingers
 * until TTL expiry.
 *
 * Used by mechanisms whose failure reasons need no special-casing beyond
 * "did this attempt broadcast a transaction" (Permit2 exact/upto,
 * batch-settlement deposit, EIP-3009).
 *
 * @param store - The pending-settlement store to update
 * @param pendingKey - Deterministic key for this payload (e.g. a signature); when
 *   undefined, the store is left untouched entirely
 * @param settle - Thunk that performs the settle attempt (broadcast + receipt wait)
 * @param nonRetryableReason - Error reason to report if a `settlement_pending`
 *   outcome cannot be persisted to `store`. Defaults to `ErrInvalidTransactionState`.
 * @returns The settle result from `settle()`, unmodified unless persisting a
 *   pending entry failed
 */
export async function withPendingSettlementStore(
  store: PendingSettlementStore,
  pendingKey: string | undefined,
  settle: () => Promise<SettleResponse>,
  nonRetryableReason: string = ErrInvalidTransactionState,
): Promise<SettleResponse> {
  const result = await settle();
  if (!pendingKey) {
    return result;
  }

  const isPending =
    !result.success && result.errorReason === ErrSettlementPending && !!result.transaction;

  if (isPending) {
    try {
      await store.set(pendingKey, result.transaction as string);
    } catch (storeError) {
      return {
        ...result,
        errorReason: nonRetryableReason,
        errorMessage: `settlement_pending, but failed to persist for retry: ${
          storeError instanceof Error ? storeError.message : String(storeError)
        }`,
      };
    }
    return result;
  }

  try {
    await store.delete(pendingKey);
  } catch {
    // Best-effort cleanup; see doc comment above.
  }
  return result;
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
