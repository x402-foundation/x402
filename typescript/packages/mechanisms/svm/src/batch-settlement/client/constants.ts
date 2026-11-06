/** Deposit target when the client sets neither `depositAmount` nor a server hint. */
export const DEFAULT_DEPOSIT_MULTIPLIER = 5;

/** Smallest `depositMultiplier` the client accepts. */
export const MIN_DEPOSIT_MULTIPLIER = 3;

/**
 * Splits a channel key from a request id. Neither side contains NUL, so the
 * pair cannot collide with another channel's key.
 */
export const OPERATION_KEY_SEPARATOR = "\u0000";
