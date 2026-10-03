/**
 * Xahau mainnet CAIP-2 identifier.
 */
export const XAHAU_MAINNET = "xahau:21337";

/**
 * Xahau testnet CAIP-2 identifier.
 */
export const XAHAU_TESTNET = "xahau:21338";

/**
 * Xahau CAIP family pattern used in facilitator supported responses.
 */
export const XAHAU_CAIP_FAMILY = "xahau:*";

/**
 * Default Xahau mainnet WebSocket endpoint.
 */
export const XAHAU_MAINNET_WS_URL = "wss://xahau.network";

/**
 * Default Xahau testnet WebSocket endpoint.
 */
export const XAHAU_TESTNET_WS_URL = "wss://xahau-test.net";

/**
 * Default maximum transaction fee accepted by the facilitator, in drops (0.1 XAH).
 * Strong Hooks on the payer and destination are paid for in the fee; hooked mainnet
 * payments observed in September 2026 paid up to ~60000 drops.
 */
export const DEFAULT_MAX_FEE_DROPS = "100000";

/**
 * Default number of additional ledgers allowed beyond maxTimeoutSeconds conversion.
 */
export const DEFAULT_LEDGER_CLOSE_SECONDS = 5;

/**
 * Additional ledgers added to maxTimeoutSeconds conversion to tolerate close-time variance.
 */
export const DEFAULT_LEDGER_TOLERANCE = 2;

/**
 * Xahau Payment tfPartialPayment flag.
 */
export const TF_PARTIAL_PAYMENT = 0x00020000;

/**
 * Xahau AccountRoot lsfDisableMaster flag: the account's master key pair is disabled.
 */
export const LSF_DISABLE_MASTER = 0x00100000;

/**
 * Canonical Xahau signing public key: 33-byte compressed secp256k1 (02/03) or
 * ed25519 (ED) hex. xahaud rejects non-canonical keys at preflight, so
 * verification rejects them too instead of passing an unsettleable payload.
 */
export const CANONICAL_SIGNING_PUB_KEY_PATTERN = /^(02|03|ED)[0-9A-F]{64}$/i;

/**
 * Maximum Xahau destination tag value (32-bit unsigned integer).
 */
export const MAX_DESTINATION_TAG = 0xffffffff;

/**
 * Maximum number of outstanding tickets a Xahau account can hold.
 */
export const MAX_ACCOUNT_TICKETS = 250;

/**
 * Default (and minimum) settlement cache TTL in milliseconds.
 *
 * A cached entry must outlive its transaction's landable window: while the
 * transaction can still land, a re-submission of the same signed blob would
 * pass re-verification (its sequence number or ticket is not yet consumed) and
 * resolve to the same validated `tesSUCCESS`. The scheme therefore sizes each
 * entry's TTL from the payment's `maxTimeoutSeconds` (which bounds the
 * `LastLedgerSequence` expiry) and uses this constant as the floor and as the
 * margin added on top. 120 seconds mirrors the SVM settlement cache and
 * comfortably covers ledger-close variance and clock skew.
 */
export const SETTLEMENT_TTL_MS = 120_000;
