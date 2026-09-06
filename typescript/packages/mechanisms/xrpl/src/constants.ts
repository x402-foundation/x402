/**
 * XRPL mainnet CAIP-2 identifier.
 */
export const XRPL_MAINNET = "xrpl:0";

/**
 * XRPL testnet CAIP-2 identifier.
 */
export const XRPL_TESTNET = "xrpl:1";

/**
 * XRPL devnet CAIP-2 identifier.
 */
export const XRPL_DEVNET = "xrpl:2";

/**
 * XRPL CAIP family pattern used in facilitator supported responses.
 */
export const XRPL_CAIP_FAMILY = "xrpl:*";

/**
 * Default XRPL mainnet WebSocket endpoint.
 */
export const XRPL_MAINNET_WS_URL = "wss://s1.ripple.com:51233";

/**
 * Default XRPL testnet WebSocket endpoint.
 */
export const XRPL_TESTNET_WS_URL = "wss://s.altnet.rippletest.net:51233";

/**
 * Default XRPL devnet WebSocket endpoint.
 */
export const XRPL_DEVNET_WS_URL = "wss://s.devnet.rippletest.net:51233";

/**
 * Default maximum transaction fee accepted by the facilitator, in drops.
 */
export const DEFAULT_MAX_FEE_DROPS = "10000";

/**
 * Default number of additional ledgers allowed beyond maxTimeoutSeconds conversion.
 */
export const DEFAULT_LEDGER_CLOSE_SECONDS = 5;

/**
 * Additional ledgers added to maxTimeoutSeconds conversion to tolerate close-time variance.
 */
export const DEFAULT_LEDGER_TOLERANCE = 2;

/**
 * XRPL Payment tfPartialPayment flag.
 */
export const TF_PARTIAL_PAYMENT = 0x00020000;

/**
 * XRPL AccountRoot lsfDisableMaster flag: the account's master key pair is disabled.
 */
export const LSF_DISABLE_MASTER = 0x00100000;

/**
 * Canonical XRPL signing public key: 33-byte compressed secp256k1 (02/03) or
 * ed25519 (ED) hex. rippled rejects non-canonical keys at preflight, so
 * verification rejects them too instead of passing an unsettleable payload.
 */
export const CANONICAL_SIGNING_PUB_KEY_PATTERN = /^(02|03|ED)[0-9A-F]{64}$/i;

/**
 * Maximum XRPL destination tag value (32-bit unsigned integer).
 */
export const MAX_DESTINATION_TAG = 0xffffffff;

/**
 * Maximum number of outstanding tickets an XRPL account can hold.
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
