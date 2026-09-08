/**
 * Exact SVM payload structure containing a base64 encoded Solana transaction
 */
export type ExactSvmPayloadV1 = {
  /**
   * Base64 encoded Solana transaction
   */
  transaction: string;
};

/**
 * Exact SVM payload V2 structure (currently same as V1, reserved for future extensions)
 */
export type ExactSvmPayloadV2 = ExactSvmPayloadV1;

/**
 * Client authorization for the `upto` SVM scheme.
 *
 * The client opens a payment channel whose `deposit` is the authorized ceiling,
 * with `authorizedSigner` set as the channel `authorized_signer` so the server
 * can settle the actual metered amount with a single voucher. The client signs
 * only the `open` transaction; the fee payer broadcasts it. The `from`,
 * `maxAmount`, `validAfter`, and `expiresAt` fields mirror the network-agnostic
 * `UptoPayload`; the channel fields are the SVM specialization.
 *
 * `voucherSignature` is server-owned and settle-only; verify rejects the field
 * if present on the client payload.
 */
export type UptoSvmPayloadV2 = {
  /** Payer wallet (base58). */
  from: string;
  /** Signed ceiling (base units). MUST equal verification-phase `amount`. */
  maxAmount: string;
  /** Deadline (Unix seconds); signed into the onchain voucher. */
  expiresAt: number;
  /** Activation time (Unix seconds). */
  validAfter: number;
  /** Unique per-authorization identifier. */
  nonce: string;
  /** Slot encoded in the open instruction and used as a channel PDA seed. */
  openSlot: string;
  /** Channel PDA (base58). */
  channelId: string;
  /** Onchain escrow ceiling (base units); MUST equal `maxAmount`. */
  deposit: string;
  /** Voucher signer; MUST equal `extra.receiverAuthorizer` (base58). */
  authorizedSigner: string;
  /** Base64 client-signed `open` transaction for the fee payer to broadcast. */
  openTransaction: string;
  /**
   * Base58 Ed25519 voucher signature by `authorizedSigner`. Settle-only;
   * verify rejects any client-supplied value (including empty string).
   * Omitted when the channel delegates receiver authorization to the facilitator.
   */
  voucherSignature?: string;
  /**
   * Per-settle phase stamped by the resource server. Not part of the client
   * authorization (that payload is reused for deposit and claim). Verify
   * rejects it if present. Required when the channel delegates receiver
   * authorization.
   */
  type?: "deposit" | "claim";
};

/**
 * Type guard for {@link UptoSvmPayloadV2}.
 *
 * @param payload - The candidate payload (the scheme-specific `PaymentPayload.payload`)
 * @returns Whether `payload` has the `upto` payment-channel shape
 */
export function isUptoSvmPayload(payload: Record<string, unknown>): payload is UptoSvmPayloadV2 {
  return (
    typeof payload.from === "string" &&
    typeof payload.maxAmount === "string" &&
    typeof payload.deposit === "string" &&
    typeof payload.channelId === "string" &&
    typeof payload.authorizedSigner === "string" &&
    typeof payload.openTransaction === "string" &&
    typeof payload.openSlot === "string" &&
    Number.isSafeInteger(payload.expiresAt) &&
    Number.isSafeInteger(payload.validAfter) &&
    typeof payload.nonce === "string" &&
    (payload.voucherSignature === undefined || typeof payload.voucherSignature === "string") &&
    (payload.type === undefined || payload.type === "deposit" || payload.type === "claim")
  );
}
