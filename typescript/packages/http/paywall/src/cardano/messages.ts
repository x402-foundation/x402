import {
  CIP30_MIN_WINDOW_SECONDS,
  type Cip30SignerErrorCode,
  ERR_EVIDENCE_UNAVAILABLE,
  ERR_FEE_BELOW_MINIMUM,
  ERR_INPUT_NOT_AVAILABLE,
  ERR_NONCE_NOT_ON_CHAIN,
  ERR_TTL_EXPIRED,
  ERR_TTL_TOO_FAR,
} from "@x402/cardano";

import type { PaymentView } from "./payment";

/** Shown when the injected protocol parameters fail the signer's bounds. */
export const PARAMETERS_OUT_OF_BOUNDS_MESSAGE =
  "This page received network parameters outside the range it accepts, so it will not ask your wallet to sign. Reload the page; if this persists, contact the site.";

/** Opening of every "the facilitator cannot settle" message. */
export const SETTLEMENT_UNAVAILABLE_MESSAGE =
  "This site's payment service cannot settle Cardano payments right now.";

/** Acknowledgement for starting a second purchase of content already paid for. */
export const BUY_AGAIN_ACK = "I want to buy this content again and pay a second time.";

/**
 * Hint for "the server could not find the funds being spent".
 *
 * @param networkName - e.g. "Cardano Preprod".
 * @returns The hint sentence (without a trailing action).
 */
export function walletNetworkHint(networkName: string): string {
  return `Check your wallet is on ${networkName}, or wait for it to finish syncing`;
}

/**
 * Explains a server rejection that happened before anything was broadcast.
 *
 * @param reason - Facilitator/core reason code.
 * @param networkName - e.g. "Cardano Preprod".
 * @returns Message for the page.
 */
export function rejectionMessage(reason: string | undefined, networkName: string): string {
  switch (reason) {
    case ERR_NONCE_NOT_ON_CHAIN:
    case ERR_INPUT_NOT_AVAILABLE:
      return `The server could not find the funds being spent. ${walletNetworkHint(networkName)}, then try again.`;
    case ERR_FEE_BELOW_MINIMUM:
      return "Network fees have changed since this page loaded. Reload the page and try again.";
    case ERR_TTL_EXPIRED:
    case "payment_window_expired":
      return "The payment window ran out before the server received it. Try again.";
    case ERR_TTL_TOO_FAR:
      return "This site's clock does not match its payment service, so the payment was refused. Nothing was charged. Contact the site if this keeps happening.";
    case ERR_EVIDENCE_UNAVAILABLE:
      return `${SETTLEMENT_UNAVAILABLE_MESSAGE} Nothing was charged. Try again later or contact the site.`;
    default:
      return `The server did not accept this payment${reason ? ` (${reason})` : ""}. Nothing was charged; try again.`;
  }
}

/**
 * Reads the stable code of a `Cip30SignerError` (or of anything shaped like one).
 *
 * @param error - Thrown value.
 * @returns The code, or undefined for other errors.
 */
export function signerErrorCode(error: unknown): Cip30SignerErrorCode | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? (code as Cip30SignerErrorCode) : undefined;
}

/** CIP-30 error codes meaning the user refused: `TxSignError.UserDeclined`, `APIError.Refused`. */
const CIP30_DECLINE_CODES: ReadonlySet<number> = new Set([2, -3]);

/**
 * Text of a thrown value. CIP-30 wallets reject with `{ code, info }` objects,
 * not `Error`s, so `info` is read before falling back to `String()`.
 *
 * @param error - Thrown value.
 * @returns Human-readable text.
 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const info = (error as { info?: unknown } | null | undefined)?.info;
  return typeof info === "string" ? info : String(error);
}

/**
 * Explains an error thrown while connecting a wallet or preparing or signing a payment.
 *
 * @param error - Thrown value.
 * @param walletName - Connected wallet's name.
 * @returns Message for the page.
 */
export function signingErrorMessage(error: unknown, walletName: string): string {
  const message = errorText(error);
  const cip30Code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof cip30Code === "number" && CIP30_DECLINE_CODES.has(cip30Code)) {
    return `You declined the request in ${walletName}.`;
  }
  switch (signerErrorCode(error)) {
    case "protocol_parameters_out_of_bounds":
    case "protocol_parameters_invalid":
      return PARAMETERS_OUT_OF_BOUNDS_MESSAGE;
    case "amount_below_min_utxo":
      return "This price is below the minimum ADA a Cardano payment must carry, so it cannot be paid. Contact the site.";
    case "fee_drain":
      return "This payment would burn leftover ADA as fee. Consolidate your wallet (send yourself a payment) and try again.";
    case "no_spendable_utxo":
      return `${walletName} has no plain ADA on this network that can pay. Add some ADA and try again.`;
    case "payment_window_too_short":
      return `This route's payment window is too short for a browser wallet. The site operator must set maxTimeoutSeconds to at least ${CIP30_MIN_WINDOW_SECONDS}.`;
    case "payment_window_expired":
      return "Signing took longer than this payment allows. Please sign again.";
    case "transfer_method_unsupported":
      return "This payment needs a smart-contract transfer, which this page cannot sign.";
    case "wallet_declined":
      return `You declined the request in ${walletName}.`;
    case "wallet_sign_failed":
      return `${walletName} could not sign this payment: ${message}`;
    case undefined:
      break;
    default:
      return `This payment was refused before signing: ${message}`;
  }
  // Non-standard wallet errors carry neither a signer code nor a CIP-30 code.
  if (/declin|reject|cancel|refus/i.test(message)) {
    return `You declined the request in ${walletName}.`;
  }
  return message || "Payment failed.";
}

/**
 * Copy for terminal states.
 *
 * @param reason - Terminal reason.
 * @returns Message.
 */
export function terminalMessage(
  reason: Extract<PaymentView, { kind: "terminal" }>["reason"],
): string {
  switch (reason) {
    case "storage_unavailable":
      return "This payment page needs site storage to protect you from double charges. Allow site data for this page (or leave private browsing) and reload.";
    case "record_unreadable":
      return "This browser holds a record of an earlier payment for this page that can no longer be read, so this page will not sign a new payment on its own. Check your wallet's history before paying again.";
    case "merchant_misconfigured":
      return `${SETTLEMENT_UNAVAILABLE_MESSAGE} Your payment was refused before anything was submitted. Contact the site, or try again later.`;
    case "no_cross_tab_lock":
      return "This browser cannot guarantee that only one tab pays at a time, so this page will not ask your wallet to sign. Open the page over HTTPS in an up-to-date browser.";
    default:
      return "Too many attempts for this payment. Reload the page later.";
  }
}
