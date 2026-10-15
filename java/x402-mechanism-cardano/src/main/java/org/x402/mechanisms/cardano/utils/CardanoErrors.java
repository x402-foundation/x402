package org.x402.mechanisms.cardano.utils;

/** Error codes produced by the Cardano mechanism. */
public final class CardanoErrors {

  /** The scheme or transfer method is not supported. */
  public static final String UNSUPPORTED_SCHEME = "unsupported_scheme";
  /** The payload is missing required fields. */
  public static final String INVALID_PAYLOAD = "invalid_exact_cardano_payload";
  /** The canonical payment requirements are malformed. */
  public static final String REQUIREMENTS_INVALID = "invalid_exact_cardano_requirements";
  /** Declared and accepted networks differ. */
  public static final String NETWORK_MISMATCH = "network_mismatch";
  /** The signed transaction could not be decoded. */
  public static final String TRANSACTION_DECODE_FAILED =
      "invalid_exact_cardano_payload_transaction_decode_failed";
  /** The transaction body targets another network. */
  public static final String NETWORK_ID_MISMATCH =
      "invalid_exact_cardano_payload_network_id_mismatch";
  /** No output pays {@code payTo}. */
  public static final String RECIPIENT_MISMATCH =
      "invalid_exact_cardano_payload_recipient_mismatch";
  /** The payTo output pays another asset. */
  public static final String ASSET_MISMATCH = "invalid_exact_cardano_payload_asset_mismatch";
  /** The payTo output pays too little. */
  public static final String AMOUNT_INSUFFICIENT =
      "invalid_exact_cardano_payload_amount_insufficient";
  /** The nonce is malformed. */
  public static final String NONCE_INVALID = "invalid_exact_cardano_payload_nonce_invalid";
  /** The nonce is not an input. */
  public static final String NONCE_NOT_IN_INPUTS =
      "invalid_exact_cardano_payload_nonce_not_in_inputs";
  /** The nonce UTxO is spent or unknown. */
  public static final String NONCE_NOT_ON_CHAIN =
      "invalid_exact_cardano_payload_nonce_not_on_chain";
  /** Another input is spent. */
  public static final String INPUT_NOT_AVAILABLE =
      "invalid_exact_cardano_payload_input_not_available";
  /** The TTL has passed. */
  public static final String TTL_EXPIRED = "invalid_exact_cardano_payload_ttl_expired";
  /** The validity start lies in the future. */
  public static final String VALIDITY_NOT_YET_VALID = "invalid_exact_cardano_payload_not_yet_valid";
  /** A chain lookup failed. */
  public static final String CHAIN_LOOKUP_FAILED = "exact_cardano_facilitator_chain_lookup_failed";
  /** Settlement failed. */
  public static final String SETTLEMENT_FAILED = "exact_cardano_settlement_failed";
  /** The node definitively rejected the transaction. */
  public static final String SETTLEMENT_DEFINITIVELY_REJECTED =
      "exact_cardano_settlement_definitively_rejected";
  /** Mempool-only evidence was refused. */
  public static final String SETTLEMENT_NOT_CONFIRMED = "exact_cardano_settlement_not_confirmed";
  /** A duplicate settlement. */
  public static final String DUPLICATE_SETTLEMENT = "duplicate_settlement";
  /** A paid retry quotes Masumi terms this server never issued. */
  public static final String MASUMI_TERMS_UNKNOWN = "masumi_terms_unknown";
  /** A paid retry altered the Masumi requirements it was issued. */
  public static final String MASUMI_TERMS_MISMATCH = "masumi_terms_mismatch";

  /** Java only: the terms storage failed while binding; the request is refused. */
  public static final String MASUMI_TERMS_STORAGE_UNAVAILABLE = "masumi_terms_storage_unavailable";
  /** Broadcast, awaiting the required evidence (non-terminal). */
  public static final String SETTLEMENT_PENDING = "settlement_pending";
  /** Script address reconstruction failed. */
  public static final String SCRIPT_ADDRESS_MISMATCH =
      "invalid_exact_cardano_payload_script_address_mismatch";
  /** The script payment's locked output carries no datum its script can spend (policy-dependent). */
  public static final String SCRIPT_DATUM_MISSING = "invalid_exact_cardano_payload_script_datum_missing";
  /** The transaction carries no witness. */
  public static final String TRANSACTION_UNSIGNED = "invalid_exact_cardano_payload_unsigned";
  /** A vkey witness does not verify. */
  public static final String INVALID_SIGNATURE = "invalid_exact_cardano_payload_invalid_signature";
  /** The transaction is phase-2 invalid. */
  public static final String TRANSACTION_PHASE2_INVALID =
      "invalid_exact_cardano_payload_phase2_invalid";
  /** The transaction fails phase-1 validation. */
  public static final String TRANSACTION_PHASE1_INVALID =
      "invalid_exact_cardano_payload_phase1_invalid";
  /** Inputs do not balance outputs plus fee. */
  public static final String VALUE_NOT_CONSERVED =
      "invalid_exact_cardano_payload_value_not_conserved";
  /** Fee below the protocol floor. */
  public static final String FEE_BELOW_MINIMUM = "invalid_exact_cardano_payload_fee_below_minimum";
  /** An input was reported without its value. */
  public static final String INPUT_VALUE_UNAVAILABLE =
      "exact_cardano_facilitator_input_value_unavailable";
  /** The payTo output is below the protocol min-UTxO. */
  public static final String MIN_UTXO_INSUFFICIENT =
      "invalid_exact_cardano_payload_min_utxo_insufficient";
  /** The Masumi escrow output has no inline datum. */
  public static final String MASUMI_DATUM_MISSING =
      "invalid_exact_cardano_payload_masumi_datum_missing";
  /** The Masumi datum does not match the signed terms. */
  public static final String MASUMI_DATUM_MISMATCH =
      "invalid_exact_cardano_payload_masumi_datum_mismatch";
  /** The Masumi datum is malformed or violates lock invariants. */
  public static final String MASUMI_DATUM_INVALID =
      "invalid_exact_cardano_payload_masumi_datum_invalid";
  /** A Masumi deadline rule failed. */
  public static final String MASUMI_DEADLINE = "invalid_exact_cardano_payload_masumi_deadline";
  /** The Masumi collateral rule failed. */
  public static final String MASUMI_COLLATERAL = "invalid_exact_cardano_payload_masumi_collateral";
  /** The escrow output is below the post-result min-UTxO. */
  public static final String MASUMI_MIN_UTXO = "invalid_exact_cardano_payload_masumi_min_utxo";
  /** The escrow output carries a reference script. */
  public static final String MASUMI_REFERENCE_SCRIPT =
      "invalid_exact_cardano_payload_masumi_reference_script";
  /** The escrow output carries the wrong asset set. */
  public static final String MASUMI_ASSET = "invalid_exact_cardano_payload_masumi_asset";
  /** {@code extra.confirmationPolicy} is malformed. */
  public static final String POLICY_INVALID = "invalid_exact_cardano_requirements_policy";
  /** The TTL lies beyond now + maxTimeoutSeconds. */
  public static final String TTL_TOO_FAR = "invalid_exact_cardano_payload_ttl_too_far";
  /** Depth above inclusion needs evidence the backend cannot read. */
  public static final String EVIDENCE_UNAVAILABLE = "exact_cardano_facilitator_evidence_unavailable";
  /** The Masumi extra violates the closed schema. */
  public static final String MASUMI_SCHEMA = "invalid_exact_cardano_requirements_masumi_schema";
  /** A commitment digest does not recompute. */
  public static final String MASUMI_COMMITMENT =
      "invalid_exact_cardano_requirements_masumi_commitment";
  /** The seller COSE authorization does not verify. */
  public static final String MASUMI_SELLER_SIGNATURE =
      "invalid_exact_cardano_requirements_masumi_seller_signature";
  /** The compatibility identifier does not match. */
  public static final String MASUMI_IDENTIFIER =
      "invalid_exact_cardano_requirements_masumi_identifier";
  /** The agent identifier is not a valid registry claim. */
  public static final String MASUMI_AGENT_IDENTIFIER =
      "invalid_exact_cardano_requirements_masumi_agent_identifier";
  /** The derived escrow does not equal payTo. */
  public static final String MASUMI_DEPLOYMENT =
      "invalid_exact_cardano_requirements_masumi_deployment";
  /** The escrow script is not on the facilitator's allowlist for the network. */
  public static final String MASUMI_CONTRACT_MISMATCH =
      "invalid_exact_cardano_requirements_masumi_contract_mismatch";
  /** More or less than one escrow output. */
  public static final String MASUMI_ESCROW_OUTPUT_COUNT =
      "invalid_exact_cardano_payload_masumi_escrow_output_count";

  private CardanoErrors() {}
}
