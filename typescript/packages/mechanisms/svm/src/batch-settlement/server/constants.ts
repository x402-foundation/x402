/** Error when a reservation conflicts with work already in flight on the channel. */
export const CHANNEL_BUSY = "duplicate_settlement";

/** How many request amounts of escrow to hint when the server does not set `minDeposit`. */
export const DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER = 10n;

/**
 * Server-signed escrow is what the operator could take, so the published
 * min-deposit hint stays near the client-side minimum.
 */
export const DEFAULT_SERVER_SIGNED_MIN_DEPOSIT_MULTIPLIER = 3n;
