/**
 * Canton mechanism constants. No hardcoded chain ids or token addresses — a
 * Canton network is identified by its Global Synchronizer id at runtime
 * (`canton:<sync-id>`), and instruments are named per-request via
 * `extra.instrumentId`.
 */

/** CAIP family pattern for the supported-response signer grouping. */
export const CANTON_CAIP_FAMILY = "canton:*";

/** The sole on-ledger settlement method (CIP-56 token-standard transfer). */
export const CANTON_TRANSFER_METHOD = "transfer-factory";

/** Canton Coin's instrument symbol as advertised in `asset`. */
export const CANTON_COIN_SYMBOL = "CC";

/** Canton Coin ledger precision: 1 CC = 1e10 atomic units. */
export const CANTON_COIN_DECIMALS = 10;
