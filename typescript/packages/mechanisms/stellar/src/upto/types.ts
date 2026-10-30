/** `PaymentPayload.payload` of an `upto` payment on Stellar. */
export interface UptoStellarPayload {
  /** Base64 XDR `SorobanAuthorizationEntry` of the payer for `settle(terms)`. */
  readonly authorization: string;
  /** Base64 XDR entries of a smart-account payer's delegated signers (at most 4). */
  readonly signerAuthorizations?: readonly string[];
}

/** `PaymentRequirements.extra` of an `upto` payment on Stellar. */
export interface UptoStellarExtra {
  readonly areFeesSponsored: true;
  /** The settlement authority: the only address that can choose the amount and settle. */
  readonly facilitatorAddress: string;
}
