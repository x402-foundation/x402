/** Denominator a `ChannelSplit.bps` is measured against; 10_000 = 100%. */
export const BASIS_POINTS_DENOMINATOR = 10_000;

/**
 * Commitment for reading account state the caller must act on. Opens are
 * confirmed at this level, and the RPC default (`finalized`) lags a fresh open
 * by seconds, reporting a live channel as missing.
 *
 * The Go SDK reads the same class of state at the same level, so both
 * facilitators judge the same channel identically.
 */
export const STATE_COMMITMENT = "confirmed" as const;

/**
 * Commitment for reading the slot used as an `openSlot` anchor. Clients pin
 * `openSlot` at this level to keep `openSlot <= clock.slot` when the open lands,
 * so verify and the reclaim gate must judge it in the same frame.
 */
export const SLOT_COMMITMENT = "finalized" as const;

/**
 * Commitment for reading transaction-lifetime blockhashes. A finalized hash
 * cannot be dropped by a fork before the transaction lands.
 */
export const BLOCKHASH_COMMITMENT = "finalized" as const;
