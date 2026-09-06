const PREFIX = "invalid_batch_settlement_svm_";

export const BatchError = {
  PAYLOAD_TYPE: `${PREFIX}payload_type`,
  PAYMENT_FLOW: `${PREFIX}payment_flow`,
  TOKEN_PROGRAM: `${PREFIX}token_program`,
  VOUCHER_SIGNATURE: `${PREFIX}voucher_signature`,
  CHANNEL_ID_MISMATCH: `${PREFIX}channel_id_mismatch`,
  FEE_PAYER_MISMATCH: `${PREFIX}fee_payer_mismatch`,
  RECEIVER_AUTHORIZER_MISMATCH: `${PREFIX}receiver_authorizer_mismatch`,
  CLOSE_AUTHORIZATION: `${PREFIX}close_authorization`,
  CLOSE_AMOUNT_UNSUPPORTED: `${PREFIX}close_amount_unsupported`,
  CLOSE_STATE: `${PREFIX}close_state`,
  WITHDRAW_DELAY_MISMATCH: `${PREFIX}withdraw_delay_mismatch`,
  WITHDRAW_DELAY_OUT_OF_RANGE: `${PREFIX}withdraw_delay_out_of_range`,
  CUMULATIVE_AMOUNT_MISMATCH: `${PREFIX}cumulative_amount_mismatch`,
  CUMULATIVE_EXCEEDS_DEPOSIT: `${PREFIX}cumulative_exceeds_deposit`,
  VOUCHER_EXPIRY: `${PREFIX}voucher_expiry`,
  SETUP_TRANSACTION: `${PREFIX}setup_transaction`,
  SETTLEMENT_SIMULATION: `${PREFIX}settlement_simulation`,
  CHANNEL_STATE: `${PREFIX}channel_state`,
  REFUND_TRANSACTION: `${PREFIX}refund_transaction`,
} as const;

export type BatchErrorReason = (typeof BatchError)[keyof typeof BatchError];
