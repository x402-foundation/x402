/**
 * Sui-specific payload for the Exact payment scheme.
 * A signed-but-not-executed transaction, per the Sui spec — the client signs and
 * the facilitator broadcasts during settlement. Both fields are Base64.
 */
export type ExactSuiPayload = {
  /**
   * Base64-encoded signature over the transaction bytes (Ed25519/Secp256k1/Secp256r1).
   */
  signature: string;

  /**
   * Base64-encoded Sui transaction bytes (BCS-serialized TransactionData).
   */
  transaction: string;
};

/**
 * A single declared settlement leg of a payment. `amount` is the atomic-unit
 * amount credited to `to`, as a decimal string. The payer's transaction MUST
 * credit each declared `to` EXACTLY this `amount` (see scheme_exact_sui.md
 * "Declared Outputs").
 */
export type SuiOutput = {
  /**
   * Recipient address (an AddressOwner of the asset).
   */
  to: string;

  /**
   * Atomic-unit amount credited to `to`, as a decimal string.
   */
  amount: string;
};

/**
 * The OPTIONAL Sui-scheme additions to `PaymentRequirements.extra`. Absent for
 * the default single-recipient wire shape.
 */
export type ExactSuiExtra = {
  /**
   * The declared fee split. When present, `sum(outputs[].amount) == amount` and
   * the payer's transaction must match these recipients/amounts EXACTLY.
   */
  outputs?: SuiOutput[];

  /**
   * Absolute https URL of a facilitator convenience endpoint that returns
   * unsigned gasless transaction bytes for these terms. The client MUST verify
   * the returned bytes before signing (see scheme_exact_sui.md "Prebuilt
   * Transactions").
   */
  buildUrl?: string;
};
