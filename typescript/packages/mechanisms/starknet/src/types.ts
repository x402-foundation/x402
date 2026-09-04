/**
 * Starknet `exact` scheme payload, carried in the x402 `PaymentPayload.payload`
 * field. The payment authorization is the SNIP-9 v2 OutsideExecution the client
 * signed: the facilitator derives recipient, amount, and token from
 * `outsideExecution.typedData.message.Calls` and never trusts sidecar fields.
 */
export interface ExactStarknetPayload {
  /**
   * The payer's account contract address. This account validates the signature
   * (SNIP-6 `is_valid_signature`) and executes the calls at settlement.
   */
  from: string;

  outsideExecution: {
    /**
     * The complete SNIP-12 typed data the client signed (a SNIP-9 v2
     * OutsideExecution). The facilitator reconstructs the canonical form and
     * hashes that, never the object as received.
     */
    typedData: unknown;

    /**
     * The felt-array signature, passed verbatim to the account's
     * `is_valid_signature`. Length varies by account (single-key, multisig,
     * guardian).
     */
    signature: string[];
  };
}
