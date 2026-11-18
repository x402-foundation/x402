/**
 * Payload shape used by x402 `exact` payments on NEAR.
 *
 * `signedDelegateAction` is a base64-encoded Borsh `SignedDelegate` (NEP-366)
 * whose delegate action represents exactly one NEP-141 `ft_transfer`.
 */
export type ExactNearPayload = {
  signedDelegateAction: string;
};

/**
 * Decoded NEP-141 `ft_transfer` arguments.
 */
export type NearFtTransferArgs = {
  receiver_id: string;
  amount: string;
  memo?: string;
};

/**
 * Access-key permission variants relevant to delegate-action verification.
 * Anything that is neither full-access nor a standard function-call key is
 * reported as `Unknown` so verification can fail closed (spec §8).
 */
export type NearAccessKeyPermissionKind = "FullAccess" | "FunctionCall" | "Unknown";

/**
 * Result of an onchain `view_access_key` query (spec §5 / §8).
 */
export type NearAccessKeyView = {
  /** On-chain nonce for the access key. */
  nonce: bigint;
  /** Normalized permission variant. */
  permissionKind: NearAccessKeyPermissionKind;
};

/**
 * Result of an onchain `view_account` query (spec §9).
 */
export type NearAccountView = {
  /** Base58 code hash; equals the all-zero hash when no contract is deployed. */
  codeHash: string;
};

/**
 * Status of a single onchain receipt outcome.
 */
export type NearReceiptStatus =
  | { kind: "success"; value: string }
  | { kind: "failure"; error: string };

/**
 * Result of submitting the outer relayer transaction and waiting for the inner
 * `ft_transfer` receipt to finish executing (spec §7 / Settlement).
 */
export type NearSettlementOutcome = {
  /** Final outer transaction hash. */
  transaction: string;
  /** Status of the inner `ft_transfer` receipt. */
  innerReceipt: NearReceiptStatus;
};
