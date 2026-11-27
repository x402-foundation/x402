/** Four Ed25519+settle pairs fit under Solana's transaction packet limit. */
export const MAX_CHANNELS_PER_SETTLE_TX = 4;

/** Ed25519+settle pairs that fit one version-1 transaction (size-bound). */
export const V1_MAX_CLAIM_CHANNELS = 18;

/**
 * `distribute` instructions advertised per version-1 transaction. Bound by the
 * 64 static account keys; 14 fit when every channel pays the same recipient,
 * 13 leaves room for one more account per channel.
 */
export const V1_MAX_SETTLE_CHANNELS = 13;

/** How many times a post-broadcast channel read retries a transient RPC failure. */
export const CHANNEL_READ_ATTEMPTS = 5;

/** First backoff, in milliseconds, before retrying a channel read. Later attempts double it. */
export const CHANNEL_READ_INITIAL_BACKOFF_MS = 200;

/** Suffix on the pending-settlement key once a broadcast's postcondition has been observed. */
export const COMPLETED_BROADCAST_SUFFIX = ":completed";

/** `getSignaturesForAddress` page size. RPC rejects a limit above this. */
export const BINDING_HISTORY_PAGE_LIMIT = 1_000;
