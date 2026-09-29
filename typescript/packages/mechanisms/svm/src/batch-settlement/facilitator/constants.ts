/** Four Ed25519+settle pairs fit under Solana's transaction packet limit. */
export const MAX_CHANNELS_PER_SETTLE_TX = 4;

/** How many times a post-broadcast channel read retries a transient RPC failure. */
export const CHANNEL_READ_ATTEMPTS = 5;

/** First backoff, in milliseconds, before retrying a channel read. Later attempts double it. */
export const CHANNEL_READ_INITIAL_BACKOFF_MS = 200;

/** Suffix on the pending-settlement key once a broadcast's postcondition has been observed. */
export const COMPLETED_BROADCAST_SUFFIX = ":completed";

/** `getSignaturesForAddress` page size. RPC rejects a limit above this. */
export const BINDING_HISTORY_PAGE_LIMIT = 1_000;
