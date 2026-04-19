import { PaymentPayload } from "@x402/core/types";
import type { ErrorClassifier } from "./classifier";

/**
 * Function type for generating idempotency keys from payment payloads
 */
export type KeyGeneratorFn = (payload: PaymentPayload) => string;

/**
 * Interface for idempotency key generation
 */
export interface IdempotencyKeyGenerator {
  /**
   * Generate an idempotency key for a payment payload.
   * Keys are deterministic - same payload produces same key.
   *
   * @param payload - The payment payload to generate a key for
   * @returns A deterministic, URL-safe idempotency key
   */
  generateKey(payload: PaymentPayload): string;
}

/**
 * Configuration for exponential backoff behavior
 */
export interface BackoffConfig {
  /**
   * Initial backoff delay in milliseconds
   *
   * @default 1000
   */
  initialMs: number;

  /**
   * Maximum backoff delay in milliseconds
   *
   * @default 30000
   */
  maxMs: number;

  /**
   * Multiplier for exponential backoff (e.g., 2 doubles the delay each retry)
   *
   * @default 2
   */
  multiplier: number;

  /**
   * Enable jitter to randomize backoff delays
   * Helps prevent thundering herd problem
   *
   * @default true
   */
  jitter: boolean;

  /**
   * Jitter randomization factor (0-1)
   * Applied as: backoff * (1 + random(-jitterFactor, +jitterFactor))
   *
   * @default 0.1
   */
  jitterFactor: number;
}

/**
 * Configuration for circuit breaker pattern
 *
 * Circuit breaker prevents excessive retries during persistent failures.
 * States: closed (normal) -> open (failing) -> half-open (testing) -> closed
 */
export interface CircuitBreakerConfig {
  /**
   * Enable circuit breaker functionality
   *
   * @default false
   */
  enabled: boolean;

  /**
   * Number of consecutive failures before opening the circuit
   *
   * @default 5
   */
  failureThreshold: number;

  /**
   * Time in milliseconds before attempting to close the circuit
   * After this timeout, circuit transitions from open to half-open
   *
   * @default 60000
   */
  resetTimeoutMs: number;
}

/**
 * Event hooks for observability and logging
 */
export interface RetryHooks {
  /**
   * Called before each retry attempt
   *
   * @param attempt - The retry attempt number (1-based)
   * @param error - The error that triggered the retry
   * @param nextBackoffMs - The calculated backoff delay in milliseconds
   */
  onRetry?: (attempt: number, error: Error, nextBackoffMs: number) => void;

  /**
   * Called on successful operation completion
   *
   * @param attempts - Total number of attempts made (including successful one)
   * @param totalTimeMs - Total elapsed time in milliseconds
   */
  onSuccess?: (attempts: number, totalTimeMs: number) => void;

  /**
   * Called on final failure after all retries exhausted
   *
   * @param attempts - Total number of attempts made
   * @param errors - Array of all errors encountered
   * @param totalTimeMs - Total elapsed time in milliseconds
   */
  onFailure?: (attempts: number, errors: Error[], totalTimeMs: number) => void;

  /**
   * Called when circuit breaker opens due to excessive failures
   *
   * @param failureCount - Number of consecutive failures that triggered the open state
   */
  onCircuitOpen?: (failureCount: number) => void;

  /**
   * Called when circuit breaker closes (returns to normal operation)
   */
  onCircuitClose?: () => void;
}

/**
 * Comprehensive retry policy configuration
 *
 * Defines retry behavior including backoff strategy, circuit breaker,
 * error classification, and observability hooks.
 */
export interface RetryPolicy {
  /**
   * Maximum number of retry attempts
   *
   * @default 3
   */
  maxAttempts: number;

  /**
   * Overall operation timeout in milliseconds
   * Prevents infinite retry loops
   *
   * @default 60000
   */
  timeoutMs?: number;

  /**
   * Exponential backoff configuration
   */
  backoff: BackoffConfig;

  /**
   * Circuit breaker configuration
   *
   * @default { enabled: false }
   */
  circuitBreaker?: CircuitBreakerConfig;

  /**
   * Error classifier for determining retryable vs non-retryable errors
   */
  errorClassifier: ErrorClassifier;

  /**
   * Optional event hooks for observability
   */
  hooks?: RetryHooks;
}
