import type { Network } from "@x402/core/types";

export const SCHEME = "exact";
export const ASSET = "BTC";
export const ASSET_TRANSFER_METHOD = "bolt11";
export const PAYMENT_FLOW = "upfront";
export const CAIP_FAMILY = "lnbtc:*";

export const LNBTC_MAINNET: Network = "lnbtc:000000000019d6689c085ae165831e93";
export const LNBTC_TESTNET: Network = "lnbtc:000000000933ea01ad0ee984209779ba";

/**
 * Concrete lnbtc networks mapped to their BOLT11 currency prefix.
 */
export const LNBTC_NETWORKS: Readonly<Record<string, string>> = Object.freeze({
  [LNBTC_MAINNET]: "bc",
  [LNBTC_TESTNET]: "tb",
});

export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

/** Replay entries are retained at least this long after `invoice_end + skew`. */
export const REPLAY_RETENTION_SECONDS = 3600;

export const BINDING_DOMAIN_PREFIX = "x402:exact:lnbtc:bolt11:";
export const HTTP_PROFILE = "http:1";
export const MCP_PROFILE = "mcp:1";

export const DYNAMIC_EXTRA_FIELDS = ["invoice"];

/** Error reasons returned by the facilitator, verbatim from the specification. */
export const Errors = {
  unsupportedScheme: "unsupported_scheme",
  networkMismatch: "network_mismatch",
  unsupportedNetwork: "unsupported_network",
  duplicateSettlement: "duplicate_settlement",
  asset: "invalid_exact_lnbtc_asset",
  amount: "invalid_exact_lnbtc_amount",
  amountMismatch: "invalid_exact_lnbtc_amount_mismatch",
  payToMismatch: "invalid_exact_lnbtc_pay_to_mismatch",
  payToMalformed: "invalid_exact_lnbtc_pay_to_malformed",
  maxTimeoutMismatch: "invalid_exact_lnbtc_max_timeout_mismatch",
  maxTimeout: "invalid_exact_lnbtc_max_timeout",
  extraMismatch: "invalid_exact_lnbtc_extra_mismatch",
  requestBinding: "invalid_exact_lnbtc_request_binding",
  requestMismatch: "invalid_exact_lnbtc_request_mismatch",
  assetTransferMethod: "invalid_exact_lnbtc_asset_transfer_method",
  paymentFlow: "invalid_exact_lnbtc_payment_flow",
  invoiceMissing: "invalid_exact_lnbtc_invoice_missing",
  invoiceDecodeFailed: "invalid_exact_lnbtc_invoice_decode_failed",
  invoiceDescription: "invalid_exact_lnbtc_invoice_description",
  invoiceRequestMismatch: "invalid_exact_lnbtc_invoice_request_mismatch",
  invoicePayeeMismatch: "invalid_exact_lnbtc_invoice_payee_mismatch",
  invoiceCurrencyMismatch: "invalid_exact_lnbtc_invoice_currency_mismatch",
  invoiceAmountMismatch: "invalid_exact_lnbtc_invoice_amount_mismatch",
  invoiceExpiryMismatch: "invalid_exact_lnbtc_invoice_expiry_mismatch",
  invoiceCreatedInFuture: "invalid_exact_lnbtc_invoice_created_in_future",
  invoiceExpired: "invalid_exact_lnbtc_invoice_expired",
  preimageMissing: "invalid_exact_lnbtc_preimage_missing",
  preimageMalformed: "invalid_exact_lnbtc_preimage_malformed",
  preimageLength: "invalid_exact_lnbtc_preimage_length",
  preimageHashMismatch: "invalid_exact_lnbtc_preimage_hash_mismatch",
  // Local client/server reasons (not facilitator responses).
  issuanceDenied: "exact_lnbtc_invoice_issuance_denied",
  payerInvoiceMismatch: "invalid_exact_lnbtc_payer_invoice_mismatch",
  payerPaymentHashMismatch: "invalid_exact_lnbtc_payer_payment_hash_mismatch",
  payerAmountMismatch: "invalid_exact_lnbtc_payer_amount_mismatch",
  paymentInFlight: "exact_lnbtc_payment_in_flight",
  paymentNotPaid: "exact_lnbtc_payment_not_paid",
  payerPreimageRequired: "invalid_exact_lnbtc_payer_preimage_required",
  payerPreimageMalformed: "invalid_exact_lnbtc_payer_preimage_malformed",
  payerPreimageHashMismatch: "invalid_exact_lnbtc_payer_preimage_hash_mismatch",
} as const;

export type LnbtcErrorReason = (typeof Errors)[keyof typeof Errors];

/**
 * Error carrying a stable lnbtc reason string.
 */
export class LnbtcError extends Error {
  /**
   * Creates an error whose message is the stable reason.
   *
   * @param reason - Stable reason string from {@link Errors}
   */
  constructor(readonly reason: LnbtcErrorReason) {
    super(reason);
    this.name = "LnbtcError";
  }
}
