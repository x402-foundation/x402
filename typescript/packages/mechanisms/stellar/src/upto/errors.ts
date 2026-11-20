/** x402 v2 codes this scheme returns, with their default reasons. */
export const uptoStandardCodes = Object.freeze({
  invalid_x402_version: "Only x402 version 2 is supported.",
  unsupported_scheme: "Only the upto scheme is handled here.",
  invalid_network: "This facilitator does not settle upto payments on this network.",
  network_mismatch: "The accepted network differs from the payment requirements.",
  insufficient_funds: "The payer's balance is lower than the amount.",
  settlement_pending:
    "The settlement was submitted but is not confirmed; reconcile the transaction hash before retrying.",
  unexpected_verify_error: "Verification failed with an unexpected error.",
  unexpected_settle_error: "Settlement failed with an unexpected error.",
} as const);

/** Codes specific to `upto` on Stellar, with their default reasons. */
export const uptoStellarCodes = Object.freeze({
  invalid_upto_stellar_requirements_fees_not_sponsored: "extra.areFeesSponsored must be true.",
  invalid_upto_stellar_requirements_facilitator_mismatch:
    "extra.facilitatorAddress is not this facilitator's settlement authority.",
  invalid_upto_stellar_requirements_invalid_pay_to:
    "payTo must be a G… or C… address other than a facilitator account, the settlement contract or the asset.",
  invalid_upto_stellar_requirements_invalid_amount:
    "The amount must be an integer string within i128; the maximum must be positive.",
  invalid_upto_stellar_requirements_asset_not_accepted:
    "This facilitator does not settle the requested asset.",
  invalid_upto_stellar_requirements_timeout_out_of_range:
    "maxTimeoutSeconds is outside the accepted range.",
  invalid_upto_stellar_payload_accepted_mismatch:
    "The accepted requirements differ from the payment requirements.",
  invalid_upto_stellar_payload_malformed:
    "payload.authorization must be one canonical base64 XDR SorobanAuthorizationEntry.",
  invalid_upto_stellar_payload_too_large: "An authorization entry exceeds the size limit.",
  invalid_upto_stellar_payload_unsupported_credential_type:
    "The payer's entry must use address credentials of a G… or C… address.",
  invalid_upto_stellar_payload_missing_payer_signature: "The payer's entry is not signed.",
  invalid_upto_stellar_payload_wrong_contract:
    "The entry is not for this network's settlement contract.",
  invalid_upto_stellar_payload_wrong_function: "The entry must authorize settle(terms).",
  invalid_upto_stellar_payload_invalid_terms: "The settle argument is not a valid UptoTerms value.",
  invalid_upto_stellar_payload_wrong_recipient: "The signed recipient differs from payTo.",
  invalid_upto_stellar_payload_wrong_asset: "The signed token differs from the asset.",
  invalid_upto_stellar_payload_wrong_amount: "The signed maximum differs from the accepted amount.",
  invalid_upto_stellar_payload_facilitator_mismatch:
    "The signed settlement authority is not this facilitator's.",
  invalid_upto_stellar_payload_expiration_mismatch:
    "terms.expiration_ledger differs from signatureExpirationLedger.",
  invalid_upto_stellar_payload_not_yet_valid: "The terms are not valid yet.",
  invalid_upto_stellar_payload_invalid_authorization_tree:
    "The entry must have exactly one child, token.approve(payer, contract, max, expiration).",
  invalid_upto_stellar_payload_facilitator_is_payer:
    "The payer is a facilitator account or the settlement contract.",
  invalid_upto_stellar_payload_self_payment: "The payer is payTo.",
  invalid_upto_stellar_payload_unsupported_recipient:
    "Muxed (M…) payTo addresses are not supported.",
  invalid_upto_stellar_payload_invalid_signer_authorization:
    "signerAuthorizations must be at most 4 signed __check_auth entries of a C… payer's delegated signers.",
  invalid_upto_stellar_payload_settlement_exceeds_amount:
    "The settlement amount exceeds the signed maximum.",
  invalid_upto_stellar_signature_expired: "The authorization has expired.",
  invalid_upto_stellar_signature_expiration_too_far:
    "The authorization expires later than maxTimeoutSeconds allows.",
  invalid_upto_stellar_signature_expiration_too_soon:
    "The authorization expires before a settlement can be included.",
  invalid_upto_stellar_payload_simulation_failed: "Simulating the settlement failed.",
  invalid_upto_stellar_payload_nonce_already_used: "The authorization was already used.",
  invalid_upto_stellar_payload_invalid_signature: "The payer's signature does not verify.",
  invalid_upto_stellar_payload_smart_account_rejected:
    "The payer's smart account rejected the authorization.",
  invalid_upto_stellar_payload_payer_trustline_missing: "The payer has no trustline for the asset.",
  invalid_upto_stellar_payload_recipient_trustline_missing: "payTo has no trustline for the asset.",
  invalid_upto_stellar_payload_trustline_not_authorized:
    "A trustline for the asset is not authorized by the issuer.",
  invalid_upto_stellar_payload_account_missing: "An account in the settlement does not exist.",
  invalid_upto_stellar_payload_archived_state:
    "Ledger state the settlement needs is archived and must be restored first.",
  invalid_upto_stellar_settlement_contract_archived:
    "The settlement contract's instance or code is archived.",
  invalid_upto_stellar_payload_fee_exceeds_maximum:
    "The settlement fee exceeds the facilitator's ceiling.",
  invalid_upto_stellar_payload_unexpected_balance_change:
    "The simulation must move exactly the amount from the payer to payTo, and nothing else.",
  invalid_upto_stellar_payload_settlement_event_mismatch:
    "The simulation did not emit exactly one matching upto_settled event.",
  settle_upto_stellar_transaction_signing_failed: "Signing the settlement transaction failed.",
  settle_upto_stellar_fee_bump_signing_failed: "Signing the fee-bump transaction failed.",
  settle_upto_stellar_transaction_submission_failed:
    "The network refused the settlement transaction; no funds moved.",
  settle_upto_stellar_transaction_failed: "The settlement transaction failed; no funds moved.",
  settle_upto_stellar_transaction_expired:
    "The settlement transaction expired before inclusion; no funds moved.",
  settle_upto_stellar_idempotency_conflict:
    "This authorization was already submitted in another settlement request.",
} as const);

export type UptoCode = keyof typeof uptoStandardCodes | keyof typeof uptoStellarCodes;

/** A refusal: a stable code and a non-empty reason. */
export interface UptoRejection {
  readonly code: UptoCode;
  readonly reason: string;
}

/**
 * Builds a refusal with a specific reason, or the code's default one.
 *
 * @param code - The code
 * @param reason - A specific reason
 * @returns The refusal
 */
export function reject(code: UptoCode, reason?: string): UptoRejection {
  const codes: Record<string, string> = { ...uptoStandardCodes, ...uptoStellarCodes };
  return { code, reason: reason ?? (codes[code] as string) };
}
