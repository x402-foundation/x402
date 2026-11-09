/** Default `maxTimeoutSeconds` used by upto fixtures across `upto.facilitator.test.ts` and `upto.pendingSettlement.test.ts`. */
export const MAX_TIMEOUT_SECONDS = 300;

/** Computes a voucher's `expiresAt` challenge deadline relative to now. */
export function challengeExpiresAt(maxTimeoutSeconds = MAX_TIMEOUT_SECONDS): number {
  return Math.floor(Date.now() / 1000) + maxTimeoutSeconds;
}
