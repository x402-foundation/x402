/** Stable reasons a CIP-30 signer refuses or fails to produce a payment. */
export type Cip30SignerErrorCode =
  | "protocol_parameters_invalid"
  | "protocol_parameters_out_of_bounds"
  | "wallet_network_mismatch"
  | "network_mismatch"
  | "transfer_method_unsupported"
  | "payment_window_too_short"
  | "amount_invalid"
  | "pinned_nonce_missing"
  | "no_spendable_utxo"
  | "body_field_forbidden"
  | "network_id_mismatch"
  | "ttl_missing"
  | "input_outside_pool"
  | "nonce_not_in_inputs"
  | "pay_to_is_change"
  | "output_script_data"
  | "unexpected_output"
  | "recipient_output_count"
  | "recipient_value_mismatch"
  | "amount_below_min_utxo"
  | "recipient_lovelace_too_high"
  | "fee_too_high"
  | "fee_drain"
  | "wallet_declined"
  | "wallet_sign_failed"
  | "witness_set_forbidden"
  | "witness_set_empty"
  | "payment_window_expired";

/** Error raised when a CIP-30 signer refuses to build, sign or return a payment. */
export class Cip30SignerError extends Error {
  /**
   * Creates a signer error.
   *
   * @param code - Stable machine-readable reason.
   * @param message - Human-readable detail.
   * @param options - Standard error options (e.g. the wallet error as `cause`).
   */
  constructor(
    readonly code: Cip30SignerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "Cip30SignerError";
  }
}
