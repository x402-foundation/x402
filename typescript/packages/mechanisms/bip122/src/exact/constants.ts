export const SCHEME = "exact" as const;
export const ASSET = "BTC" as const;
export const PAY_TO_ANONYMOUS = "anonymous" as const;
export const PAYMENT_METHOD_LIGHTNING = "lightning" as const;
export const DEFAULT_INVOICE_DESCRIPTION = "x402 payment" as const;
export const DEFAULT_INVOICE_EXPIRY_SECONDS = 3600;
export const SETTLEMENT_TTL_BUFFER_MS = 60_000;

export const BTC_MAINNET_CAIP2 = "bip122:000000000019d6689c085ae165831e93" as const;
export const BTC_TESTNET_CAIP2 = "bip122:000000000933ea01ad0ee984209779ba" as const;

export const SUPPORTED_NETWORKS = [BTC_MAINNET_CAIP2, BTC_TESTNET_CAIP2] as const;

export const ERR_UNSUPPORTED_NETWORK = "unsupported_network";
export const ERR_INVALID_ASSET = "invalid_asset";
export const ERR_INVALID_PAY_TO = "invalid_pay_to";
export const ERR_INVALID_PAYMENT_METHOD = "invalid_payment_method";
export const ERR_MISSING_INVOICE = "missing_invoice";
export const ERR_INVALID_INVOICE = "invalid_invoice";
export const ERR_INVOICE_SUBSTITUTION = "invoice_substitution";
export const ERR_INVOICE_EXPIRED = "invoice_expired";
export const ERR_AMOUNT_MISMATCH = "amount_mismatch";
export const ERR_INVOICE_IN_FLIGHT = "invoice_in_flight";
export const ERR_INVOICE_NOT_PAID = "invoice_not_paid";
export const ERR_DUPLICATE_SETTLEMENT = "duplicate_settlement";
