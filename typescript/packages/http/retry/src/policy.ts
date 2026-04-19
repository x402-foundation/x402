import type { RetryPolicy, BackoffConfig, CircuitBreakerConfig } from "./types";
import { DefaultErrorClassifier } from "./classifier";

/**
 * Default backoff configuration
 *
 * Provides exponential backoff with jitter:
 * - Attempt 1: ~1000ms (900-1100ms with jitter)
 * - Attempt 2: ~2000ms (1800-2200ms with jitter)
 * - Attempt 3: ~4000ms (3600-4400ms with jitter)
 */
export const defaultBackoffConfig: BackoffConfig = {
  initialMs: 1000,
  maxMs: 30000,
  multiplier: 2,
  jitter: true,
  jitterFactor: 0.1,
};

/**
 * Default circuit breaker configuration
 *
 * Disabled by default to maintain backward compatibility.
 * Users can enable circuit breaker by providing custom config.
 */
export const defaultCircuitBreakerConfig: CircuitBreakerConfig = {
  enabled: false,
  failureThreshold: 5,
  resetTimeoutMs: 60000,
};

/**
 * Default retry policy
 *
 * Provides safe defaults for retry behavior:
 * - 3 retry attempts with exponential backoff
 * - 60 second overall timeout
 * - Retries only on 429, 500, 502, 503, 504 HTTP errors
 * - No circuit breaker (opt-in)
 * - No observability hooks (opt-in)
 *
 * @example
 * ```typescript
 * import { defaultRetryPolicy } from '@x402/retry';
 *
 * // Use as-is
 * const executor = new RetryExecutor();
 * await executor.execute(operation, defaultRetryPolicy);
 *
 * // Customize specific options
 * const customPolicy = {
 *   ...defaultRetryPolicy,
 *   maxAttempts: 5,
 *   hooks: {
 *     onRetry: (attempt, error) => console.log(`Retry ${attempt}: ${error.message}`)
 *   }
 * };
 * ```
 */
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 60000,
  backoff: defaultBackoffConfig,
  circuitBreaker: defaultCircuitBreakerConfig,
  errorClassifier: new DefaultErrorClassifier(),
};

/**
 * Create a custom retry policy with partial overrides
 *
 * Merges provided options with defaults for easy policy customization.
 *
 * @param options - Partial retry policy to override defaults
 * @returns A complete RetryPolicy with defaults filled in
 *
 * @example
 * ```typescript
 * import { createRetryPolicy } from '@x402/retry';
 *
 * // Increase retry attempts only
 * const policy = createRetryPolicy({ maxAttempts: 5 });
 *
 * // Enable circuit breaker
 * const policy = createRetryPolicy({
 *   circuitBreaker: { enabled: true, failureThreshold: 3, resetTimeoutMs: 30000 }
 * });
 *
 * // Add observability
 * const policy = createRetryPolicy({
 *   hooks: {
 *     onRetry: (attempt, error, backoff) =>
 *       logger.warn(`Retry ${attempt} after ${backoff}ms: ${error.message}`),
 *     onFailure: (attempts, errors, totalTime) =>
 *       logger.error(`Failed after ${attempts} attempts in ${totalTime}ms`)
 *   }
 * });
 * ```
 */
export function createRetryPolicy(options?: Partial<RetryPolicy>): RetryPolicy {
  return {
    ...defaultRetryPolicy,
    ...options,
    backoff: {
      ...defaultBackoffConfig,
      ...(options?.backoff || {}),
    },
    circuitBreaker: {
      ...defaultCircuitBreakerConfig,
      ...(options?.circuitBreaker || {}),
    },
    hooks: options?.hooks,
  };
}
