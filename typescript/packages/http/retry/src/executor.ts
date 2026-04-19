import type { RetryPolicy, BackoffConfig } from "./types";

/**
 * Circuit breaker states
 */
enum CircuitState {
  /** Normal operation - requests allowed */
  CLOSED = "closed",
  /** Too many failures - requests blocked */
  OPEN = "open",
  /** Testing if service recovered - limited requests allowed */
  HALF_OPEN = "half-open",
}

/**
 * Error thrown when retries are exhausted
 */
export class RetryExhaustedError extends Error {
  /** All errors encountered during retries */
  public readonly retriedErrors: Error[];
  /** Total number of attempts made */
  public readonly attempts: number;
  /** Total time spent retrying in milliseconds */
  public readonly totalTimeMs: number;

  /**
   * Create retry exhausted error
   *
   * @param attempts - Number of attempts made
   * @param errors - All errors encountered
   * @param totalTimeMs - Total time spent in milliseconds
   */
  constructor(attempts: number, errors: Error[], totalTimeMs: number) {
    const lastError = errors[errors.length - 1];
    super(
      `Payment failed after ${attempts} attempts in ${totalTimeMs}ms. Last error: ${lastError?.message || "Unknown error"}`,
    );
    this.name = "RetryExhaustedError";
    this.retriedErrors = errors;
    this.attempts = attempts;
    this.totalTimeMs = totalTimeMs;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, RetryExhaustedError.prototype);
  }
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  /** Number of consecutive failures that caused circuit to open */
  public readonly failureCount: number;

  /**
   * Create circuit breaker open error
   *
   * @param failureCount - Number of consecutive failures
   */
  constructor(failureCount: number) {
    super(`Circuit breaker is open after ${failureCount} consecutive failures`);
    this.name = "CircuitBreakerOpenError";
    this.failureCount = failureCount;

    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

/**
 * Error thrown when operation timeout is exceeded
 */
export class RetryTimeoutError extends Error {
  /** Configured timeout in milliseconds */
  public readonly timeoutMs: number;
  /** Number of attempts made before timeout */
  public readonly attempts: number;

  /**
   * Create retry timeout error
   *
   * @param timeoutMs - Configured timeout in milliseconds
   * @param attempts - Number of attempts made before timeout
   */
  constructor(timeoutMs: number, attempts: number) {
    super(`Operation timed out after ${timeoutMs}ms (${attempts} attempts)`);
    this.name = "RetryTimeoutError";
    this.timeoutMs = timeoutMs;
    this.attempts = attempts;

    Object.setPrototypeOf(this, RetryTimeoutError.prototype);
  }
}

/**
 * Core retry executor with exponential backoff and circuit breaker
 *
 * Executes operations with configurable retry logic, including:
 * - Exponential backoff with jitter
 * - Circuit breaker pattern
 * - Timeout enforcement
 * - Error classification
 * - Observability hooks
 *
 * @example
 * ```typescript
 * const executor = new RetryExecutor();
 * const result = await executor.execute(
 *   async () => {
 *     const response = await fetch('https://api.example.com');
 *     if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *     return response.json();
 *   },
 *   defaultRetryPolicy
 * );
 * ```
 */
export class RetryExecutor {
  private circuitState: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private circuitOpenedAt?: number;

  /**
   * Execute an operation with retry logic
   *
   * @param operation - The async operation to execute
   * @param policy - Retry policy configuration
   * @returns The result of the successful operation
   * @throws {RetryExhaustedError} When all retry attempts are exhausted
   * @throws {CircuitBreakerOpenError} When circuit breaker is open
   * @throws {RetryTimeoutError} When operation timeout is exceeded
   * @throws {Error} When a non-retryable error occurs
   */
  async execute<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
    const startTime = Date.now();
    const errors: Error[] = [];
    let attempt = 0;

    // Check circuit breaker before starting
    if (this.isCircuitOpen(policy)) {
      throw new CircuitBreakerOpenError(this.consecutiveFailures);
    }

    while (attempt < policy.maxAttempts) {
      // Check timeout before each attempt
      if (policy.timeoutMs && Date.now() - startTime > policy.timeoutMs) {
        this.onFailure(policy, attempt, errors, Date.now() - startTime);
        throw new RetryTimeoutError(policy.timeoutMs, attempt);
      }

      try {
        const result = await operation();

        // Success - reset circuit breaker and call hooks
        this.onSuccess(policy, attempt + 1, Date.now() - startTime);
        return result;
      } catch (error) {
        const err = this.normalizeError(error);
        errors.push(err);
        attempt++;

        // Check if error is retryable
        if (!policy.errorClassifier.isRetryable(error)) {
          this.onFailure(policy, attempt, errors, Date.now() - startTime);
          // Throw original error if it's an Error or has HTTP properties, otherwise throw normalized
          if (error instanceof Error || (error && typeof error === "object" && "status" in error)) {
            throw error;
          }
          throw err;
        }

        // Check if we've exhausted retries
        if (attempt >= policy.maxAttempts) {
          this.onFailure(policy, attempt, errors, Date.now() - startTime);
          throw new RetryExhaustedError(attempt, errors, Date.now() - startTime);
        }

        // Calculate backoff and wait
        const backoffMs = this.calculateBackoff(attempt, policy.backoff);
        this.callHook(() => policy.hooks?.onRetry?.(attempt, err, backoffMs));

        await this.sleep(backoffMs);
      }
    }

    // Should never reach here, but for type safety
    this.onFailure(policy, attempt, errors, Date.now() - startTime);
    throw new RetryExhaustedError(attempt, errors, Date.now() - startTime);
  }

  /**
   * Reset circuit breaker state
   *
   * Useful for testing or manual intervention.
   */
  public resetCircuit(): void {
    this.circuitState = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.circuitOpenedAt = undefined;
  }

  /**
   * Get current circuit breaker state
   *
   * @returns Current circuit state
   */
  public getCircuitState(): string {
    return this.circuitState;
  }

  /**
   * Get consecutive failure count
   *
   * @returns Number of consecutive failures
   */
  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Calculate exponential backoff delay with optional jitter
   *
   * @param attempt - Current attempt number (1-based)
   * @param config - Backoff configuration
   * @returns Calculated backoff delay in milliseconds
   */
  private calculateBackoff(attempt: number, config: BackoffConfig): number {
    // Exponential backoff: initialMs * multiplier^(attempt-1)
    const exponential = config.initialMs * Math.pow(config.multiplier, attempt - 1);
    const cappedBackoff = Math.min(exponential, config.maxMs);

    if (!config.jitter) {
      return cappedBackoff;
    }

    // Add jitter: backoff * (1 + random(-jitterFactor, +jitterFactor))
    const jitterRange = config.jitterFactor * 2;
    const jitterOffset = -config.jitterFactor;
    const jitter = 1 + (Math.random() * jitterRange + jitterOffset);

    return Math.floor(cappedBackoff * jitter);
  }

  /**
   * Sleep for specified milliseconds
   *
   * @param ms - Milliseconds to sleep
   * @returns Promise that resolves after delay
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if circuit breaker is currently open
   *
   * @param policy - Retry policy with circuit breaker config
   * @returns true if circuit is open and blocking requests
   */
  private isCircuitOpen(policy: RetryPolicy): boolean {
    if (!policy.circuitBreaker?.enabled) {
      return false;
    }

    if (this.circuitState === CircuitState.CLOSED) {
      return false;
    }

    if (this.circuitState === CircuitState.OPEN) {
      // Check if enough time has passed to try half-open
      const elapsed = Date.now() - (this.circuitOpenedAt || 0);
      if (elapsed >= (policy.circuitBreaker.resetTimeoutMs || 60000)) {
        this.circuitState = CircuitState.HALF_OPEN;
        return false;
      }
      return true;
    }

    // half-open: allow one request through to test if service recovered
    return false;
  }

  /**
   * Handle successful operation
   *
   * @param policy - Retry policy
   * @param attempts - Number of attempts made (including successful one)
   * @param totalTimeMs - Total elapsed time
   */
  private onSuccess(policy: RetryPolicy, attempts: number, totalTimeMs: number): void {
    const wasOpen = this.circuitState !== CircuitState.CLOSED;

    // Reset circuit breaker state
    this.consecutiveFailures = 0;
    this.circuitState = CircuitState.CLOSED;

    // Call hooks
    if (wasOpen && policy.circuitBreaker?.enabled) {
      this.callHook(() => policy.hooks?.onCircuitClose?.());
    }
    this.callHook(() => policy.hooks?.onSuccess?.(attempts, totalTimeMs));
  }

  /**
   * Handle operation failure
   *
   * @param policy - Retry policy
   * @param attempts - Number of attempts made
   * @param errors - All errors encountered
   * @param totalTimeMs - Total elapsed time
   */
  private onFailure(
    policy: RetryPolicy,
    attempts: number,
    errors: Error[],
    totalTimeMs: number,
  ): void {
    this.consecutiveFailures++;

    // Check if we should open circuit breaker
    if (
      policy.circuitBreaker?.enabled &&
      this.consecutiveFailures >= (policy.circuitBreaker.failureThreshold || 5) &&
      this.circuitState !== CircuitState.OPEN
    ) {
      this.circuitState = CircuitState.OPEN;
      this.circuitOpenedAt = Date.now();
      this.callHook(() => policy.hooks?.onCircuitOpen?.(this.consecutiveFailures));
    }

    this.callHook(() => policy.hooks?.onFailure?.(attempts, errors, totalTimeMs));
  }

  /**
   * Safely call a hook function, catching any errors it throws
   *
   * @param hookFn - The hook function to call
   */
  private callHook(hookFn: () => void): void {
    try {
      hookFn();
    } catch {
      // Silently ignore hook errors to prevent them from breaking retry logic
      // Hooks are for observability only and should not affect operation
    }
  }

  /**
   * Normalize unknown errors to Error objects
   *
   * @param error - The error to normalize
   * @returns An Error object
   */
  private normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    if (typeof error === "string") {
      return new Error(error);
    }

    if (error && typeof error === "object" && "message" in error) {
      return new Error(String(error.message));
    }

    return new Error("Unknown error occurred");
  }
}
