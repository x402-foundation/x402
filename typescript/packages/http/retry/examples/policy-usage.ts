/**
 * Example usage of RetryPolicy
 *
 * This file demonstrates various ways to configure and use retry policies
 * in the x402 retry utility.
 */

import {
  defaultRetryPolicy,
  createRetryPolicy,
  defaultBackoffConfig,
  type RetryPolicy,
} from "../src/index";

// ============================================================================
// Example 1: Using the default retry policy
// ============================================================================

console.log("Example 1: Default Retry Policy");
console.log("================================");
console.log(JSON.stringify(defaultRetryPolicy, null, 2));
console.log();

// The default policy provides:
// - 3 retry attempts
// - 60 second timeout
// - Exponential backoff (1s, 2s, 4s) with 10% jitter
// - No circuit breaker
// - Retries on: 429, 500, 502, 503, 504 HTTP errors

// ============================================================================
// Example 2: Customizing specific options
// ============================================================================

console.log("Example 2: Custom Retry Attempts");
console.log("=================================");

const aggressivePolicy = createRetryPolicy({
  maxAttempts: 5,
  backoff: {
    initialMs: 500,
    maxMs: 10000,
    multiplier: 1.5,
    jitter: true,
    jitterFactor: 0.2,
  },
});

console.log(
  `Max attempts: ${aggressivePolicy.maxAttempts} (default: ${defaultRetryPolicy.maxAttempts})`,
);
console.log(
  `Initial backoff: ${aggressivePolicy.backoff.initialMs}ms (default: ${defaultBackoffConfig.initialMs}ms)`,
);
console.log();

// ============================================================================
// Example 3: Enabling circuit breaker
// ============================================================================

console.log("Example 3: Circuit Breaker Enabled");
console.log("===================================");

const circuitBreakerPolicy = createRetryPolicy({
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
    resetTimeoutMs: 30000,
  },
  hooks: {
    onCircuitOpen: failures => {
      console.log(`Circuit breaker opened after ${failures} consecutive failures`);
      console.log("Subsequent requests will fail fast until circuit resets");
    },
    onCircuitClose: () => {
      console.log("Circuit breaker closed - normal operation resumed");
    },
  },
});

console.log(
  `Circuit breaker: ${circuitBreakerPolicy.circuitBreaker?.enabled ? "enabled" : "disabled"}`,
);
console.log(`Failure threshold: ${circuitBreakerPolicy.circuitBreaker?.failureThreshold}`);
console.log(`Reset timeout: ${circuitBreakerPolicy.circuitBreaker?.resetTimeoutMs}ms`);
console.log();

// ============================================================================
// Example 4: Adding observability hooks
// ============================================================================

console.log("Example 4: Observability Hooks");
console.log("===============================");

const observablePolicy = createRetryPolicy({
  hooks: {
    onRetry: (attempt, error, backoffMs) => {
      console.log(`Retry attempt ${attempt}: ${error.message} (waiting ${backoffMs}ms)`);
    },
    onSuccess: (attempts, totalTimeMs) => {
      console.log(`Success after ${attempts} attempt(s) in ${totalTimeMs}ms`);
    },
    onFailure: (attempts, errors, totalTimeMs) => {
      console.log(`Failed after ${attempts} attempt(s) in ${totalTimeMs}ms`);
      console.log(`Errors: ${errors.map(e => e.message).join(", ")}`);
    },
  },
});

console.log("Hooks configured:");
console.log(`  - onRetry: ${observablePolicy.hooks?.onRetry ? "yes" : "no"}`);
console.log(`  - onSuccess: ${observablePolicy.hooks?.onSuccess ? "yes" : "no"}`);
console.log(`  - onFailure: ${observablePolicy.hooks?.onFailure ? "yes" : "no"}`);
console.log();

// ============================================================================
// Example 5: Conservative retry policy (for production)
// ============================================================================

console.log("Example 5: Conservative Production Policy");
console.log("==========================================");

const productionPolicy: RetryPolicy = createRetryPolicy({
  maxAttempts: 2, // Limited retries
  timeoutMs: 120000, // 2 minute timeout
  backoff: {
    initialMs: 2000, // Start with 2 second wait
    maxMs: 60000, // Max 60 seconds
    multiplier: 3, // More aggressive backoff
    jitter: false, // Predictable timing
    jitterFactor: 0,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 10, // Higher threshold for production
    resetTimeoutMs: 120000, // 2 minute reset
  },
  hooks: {
    onRetry: (attempt, error, backoff) => {
      // Log to monitoring service
      console.error(
        `[RETRY] Attempt ${attempt} failed, retrying in ${backoff}ms: ${error.message}`,
      );
    },
    onFailure: (attempts, errors, time) => {
      // Alert on-call
      console.error(`[ALERT] Payment failed after ${attempts} retries in ${time}ms`);
    },
  },
});

console.log("Production policy:");
console.log(`  Max attempts: ${productionPolicy.maxAttempts}`);
console.log(`  Timeout: ${productionPolicy.timeoutMs}ms`);
console.log(`  Circuit breaker: ${productionPolicy.circuitBreaker?.enabled}`);
console.log();

// ============================================================================
// Example 6: Calculating expected backoff delays
// ============================================================================

console.log("Example 6: Backoff Delay Calculations");
console.log("======================================");

/**
 * Calculate exponential backoff delay
 *
 * @param attempt - Retry attempt number
 * @param config - Backoff configuration
 * @returns Calculated backoff delay in milliseconds
 */
function calculateBackoff(attempt: number, config: typeof defaultBackoffConfig): number {
  const exponential = config.initialMs * Math.pow(config.multiplier, attempt - 1);
  return Math.min(exponential, config.maxMs);
}

console.log("Expected delays with default backoff config:");
for (let i = 1; i <= 5; i++) {
  const delay = calculateBackoff(i, defaultBackoffConfig);
  const withJitter = defaultBackoffConfig.jitter
    ? ` (±${defaultBackoffConfig.jitterFactor * 100}% jitter)`
    : "";
  console.log(`  Attempt ${i}: ${delay}ms${withJitter}`);
}
console.log();

// ============================================================================
// Example 7: Policy comparison
// ============================================================================

console.log("Example 7: Policy Comparison");
console.log("============================");

const policies = {
  default: defaultRetryPolicy,
  aggressive: createRetryPolicy({
    maxAttempts: 5,
    backoff: { ...defaultBackoffConfig, initialMs: 500, multiplier: 1.5 },
  }),
  conservative: createRetryPolicy({
    maxAttempts: 2,
    backoff: { ...defaultBackoffConfig, initialMs: 2000, multiplier: 3 },
  }),
};

console.log("Policy comparison:");
for (const [name, policy] of Object.entries(policies)) {
  console.log(`  ${name}:`);
  console.log(`    Max attempts: ${policy.maxAttempts}`);
  console.log(`    Initial backoff: ${policy.backoff.initialMs}ms`);
  console.log(`    Multiplier: ${policy.backoff.multiplier}`);
}
