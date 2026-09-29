/** Scheme name on the wire and in payment requirements. */
export const BATCH_SETTLEMENT_SCHEME = "batch-settlement";

/** Shortest grace period a channel may advertise, in seconds (15 minutes). */
export const MIN_WITHDRAW_DELAY = 900;

/** Longest grace period a channel may advertise, in seconds (30 days). */
export const MAX_WITHDRAW_DELAY = 2_592_000;

/** Basis points that assign the whole deposit to one recipient. */
export const FULL_SPLIT_BPS = 10_000;

/** Voucher expiry this scheme uses: the voucher does not expire on its own. */
export const CLIENT_VOUCHER_EXPIRES_AT = 0;

/** Domain separator for the payer authorization a server-signed channel spends. */
export const AUTHORIZATION_DOMAIN = new TextEncoder().encode("x402-batch-authorization-v2");

/** Domain separator for a receiver-authorizer close authorization. */
export const CLOSE_DOMAIN = new TextEncoder().encode("x402:batch-settlement:svm:close:v1");
