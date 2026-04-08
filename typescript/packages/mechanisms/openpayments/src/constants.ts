/**
 * Open Payments scheme identifier.
 * Uses "exact" scheme.
 */
export const OPEN_PAYMENTS_SCHEME = "exact";

/**
 * Default retry configuration for payment status checks.
 */
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 5000;
export const DEFAULT_CACHE_EVICTION_TTL_MS = 600_000; // 10 minutes

/**
 * Network identifier for Open Payments.
 */
export const OPEN_PAYMENTS_NETWORK = "ilp:openpayments";
