/** Defensive implementation budgets. They do not change Cardano ledger rules. */

/** Largest signed transaction this package decodes before consulting a node. */
export const MAX_CARDANO_TRANSACTION_BYTES = 64 * 1024;
/** Maximum transaction inputs resolved through provider calls during verification. */
export const MAX_CARDANO_TRANSACTION_INPUTS = 256;
/** Maximum simultaneous provider lookups for transaction inputs. */
export const MAX_CARDANO_INPUT_LOOKUP_CONCURRENCY = 8;
/** Largest arbitrary inline Plutus script accepted from payment requirements. */
export const MAX_CARDANO_SCRIPT_BYTES = 64 * 1024;
/** Largest arbitrary inline datum accepted from payment requirements. */
export const MAX_CARDANO_DATUM_BYTES = 64 * 1024;
/** Maximum number of parameters applied to an arbitrary Plutus script. */
export const MAX_CARDANO_SCRIPT_PARAMETERS = 64;
/** Aggregate UTF-8/hex input budget for arbitrary script parameters. */
export const MAX_CARDANO_SCRIPT_PARAMETER_BYTES = 64 * 1024;

/** Maximum number of request-commitment parts in one Masumi requirements block. */
export const MAX_MASUMI_COMMITMENT_PARTS = 32;
/** Maximum content represented by one Masumi commitment part. */
export const MAX_MASUMI_COMMITMENT_CONTENT_BYTES = 1024 * 1024;
/** Maximum number of weighted admin keys in a custom deployment. */
export const MAX_MASUMI_ADMIN_KEYS = 64;
/** Maximum compressed bytes in the Masumi compatibility identifier. */
export const MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES = 8 * 1024;
/** Maximum decoded text characters in the Masumi compatibility identifier. */
export const MAX_MASUMI_IDENTIFIER_TEXT_CHARS = 32 * 1024;
/** Maximum bytes in one COSE key or signature field. */
export const MAX_MASUMI_COSE_BYTES = 16 * 1024;
/** Maximum entries in the pure deployment script-hash memoization cache. */
export const MAX_MASUMI_SCRIPT_HASH_CACHE_ENTRIES = 256;

/** Default deadline for reference-signer provider operations. */
export const DEFAULT_CARDANO_PROVIDER_TIMEOUT_MS = 10_000;
