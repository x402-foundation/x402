import { ErrUnsupportedTransactionVersion } from "../exact/facilitator/errors";

const PREFIX = "invalid_batch_settlement_svm_";

export const BatchError = {
  PAYLOAD_TYPE: `${PREFIX}payload_type`,
  PAYMENT_FLOW: `${PREFIX}payment_flow`,
  TOKEN_PROGRAM: `${PREFIX}token_program`,
  VOUCHER_SIGNATURE: `${PREFIX}voucher_signature`,
  CHANNEL_ID_MISMATCH: `${PREFIX}channel_id_mismatch`,
  FEE_PAYER_MISMATCH: `${PREFIX}fee_payer_mismatch`,
  RECEIVER_AUTHORIZER_MISMATCH: `${PREFIX}receiver_authorizer_mismatch`,
  RECEIVER_BINDING_UNAVAILABLE: `${PREFIX}receiver_binding_unavailable`,
  DELEGATED_UNAUTHENTICATED: `${PREFIX}delegated_unauthenticated`,
  CLOSE_AUTHORIZATION: `${PREFIX}close_authorization`,
  CLOSE_AMOUNT_UNSUPPORTED: `${PREFIX}close_amount_unsupported`,
  CLOSE_STATE: `${PREFIX}close_state`,
  CHANNEL_CLOSING: `${PREFIX}channel_closing`,
  WITHDRAW_DELAY_MISMATCH: `${PREFIX}withdraw_delay_mismatch`,
  WITHDRAW_DELAY_OUT_OF_RANGE: `${PREFIX}withdraw_delay_out_of_range`,
  CUMULATIVE_AMOUNT_MISMATCH: `${PREFIX}cumulative_amount_mismatch`,
  CUMULATIVE_EXCEEDS_DEPOSIT: `${PREFIX}cumulative_exceeds_deposit`,
  VOUCHER_EXPIRY: `${PREFIX}voucher_expiry`,
  SETUP_TRANSACTION: `${PREFIX}setup_transaction`,
  SETTLEMENT_SIMULATION: `${PREFIX}settlement_simulation`,
  DEPOSIT_BELOW_MIN_DEPOSIT: `${PREFIX}deposit_below_min_deposit`,
  CHANNEL_STATE: `${PREFIX}channel_state`,
  REFUND_TRANSACTION: `${PREFIX}refund_transaction`,
  PAYOUT_ATTRIBUTION_AMBIGUOUS: `${PREFIX}payout_attribution_ambiguous`,
  OPERATION_CEILING_CHANGED: `${PREFIX}operation_ceiling_changed`,
} as const;

export type BatchErrorReason = (typeof BatchError)[keyof typeof BatchError];

/**
 * Give a failed `open` or `top_up` verification its spec code (spec 7): the
 * binding Memo naming another receiver authorizer is
 * `receiver_authorizer_mismatch`, a grace period other than
 * `extra.withdrawDelay` is `withdraw_delay_mismatch`, an unaccepted message
 * version keeps `unsupported_transaction_version`, and every other sponsor
 * safety check (layout, signers, budget, size) is `setup_transaction`.
 *
 * @param error - The error the setup-transaction verifier threw
 * @returns Never; always throws the classified error
 */
export function rethrowSetupTransactionError(error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  if (detail.startsWith(ErrUnsupportedTransactionVersion)) throw new Error(detail);
  const reason = detail.includes("names another receiver authorizer")
    ? BatchError.RECEIVER_AUTHORIZER_MISMATCH
    : /gracePeriod \d+ != expected withdrawDelay/.test(detail)
      ? BatchError.WITHDRAW_DELAY_MISMATCH
      : BatchError.SETUP_TRANSACTION;
  throw new Error(`${reason}: ${detail}`);
}
