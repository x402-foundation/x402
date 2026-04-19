/**
 * Error classification categories for retry logic
 */
export enum ErrorCategory {
  /** Error is retryable (transient failure) */
  RETRYABLE = "retryable",
  /** Error is not retryable (permanent failure) */
  NON_RETRYABLE = "non_retryable",
  /** Error category is unknown */
  UNKNOWN = "unknown",
}

/**
 * Interface for error classification
 */
export interface ErrorClassifier {
  /**
   * Determine if an error should trigger a retry
   *
   * @param error - The error to classify
   * @returns true if the error is retryable, false otherwise
   */
  isRetryable(error: unknown): boolean;

  /**
   * Classify error into a category
   *
   * @param error - The error to classify
   * @returns The error category
   */
  classifyError(error: unknown): ErrorCategory;
}

/**
 * Default error classifier implementation
 *
 * Classifies errors based solely on HTTP status codes for reliability and simplicity.
 * This avoids brittleness from string matching and inconsistencies across environments.
 *
 * Retryable: 429 (rate limit), 500, 502, 503, 504 (server errors)
 * Non-retryable: 4xx client errors (except 429)
 * Unknown: Everything else defaults to non-retryable for safety
 */
export class DefaultErrorClassifier implements ErrorClassifier {
  private retryableHttpCodes = new Set([429, 500, 502, 503, 504]);

  private nonRetryableHttpCodes = new Set([
    400, // Bad Request
    401, // Unauthorized
    403, // Forbidden
    404, // Not Found
    405, // Method Not Allowed
    409, // Conflict
    410, // Gone
    422, // Unprocessable Entity
  ]);

  /**
   * Determine if an error is retryable
   *
   * Only uses HTTP status codes for classification to ensure reliability
   * and avoid false positives from string matching or environment-specific behavior.
   *
   * @param error - The error to check
   * @returns true if retryable, false otherwise
   */
  isRetryable(error: unknown): boolean {
    // Only check HTTP status codes
    if (this.isHttpError(error)) {
      const status = this.getHttpStatus(error);
      return this.retryableHttpCodes.has(status);
    }

    // Unknown errors - default to non-retryable for safety
    // Users can extend classification via createErrorClassifier() if needed
    return false;
  }

  /**
   * Classify an error into a category
   *
   * @param error - The error to classify
   * @returns The error category
   */
  classifyError(error: unknown): ErrorCategory {
    if (this.isRetryable(error)) {
      return ErrorCategory.RETRYABLE;
    }

    if (this.isNonRetryableError(error)) {
      return ErrorCategory.NON_RETRYABLE;
    }

    return ErrorCategory.UNKNOWN;
  }

  /**
   * Check if error is an HTTP error
   *
   * @param error - The error to check
   * @returns true if error is an HTTP error with status code
   */
  private isHttpError(error: unknown): boolean {
    // Standard fetch Response with !ok status
    if (this.hasProperty(error, "status") && typeof error.status === "number") {
      return true;
    }

    // Axios error
    if (this.hasProperty(error, "response") && this.hasProperty(error.response, "status")) {
      return true;
    }

    return false;
  }

  /**
   * Extract HTTP status code from error
   *
   * @param error - The error to extract status from
   * @returns HTTP status code or 0 if not found
   */
  private getHttpStatus(error: unknown): number {
    // Direct status property
    if (this.hasProperty(error, "status") && typeof error.status === "number") {
      return error.status;
    }

    // Axios response.status
    if (
      this.hasProperty(error, "response") &&
      this.hasProperty(error.response, "status") &&
      typeof error.response.status === "number"
    ) {
      return error.response.status;
    }

    return 0;
  }

  /**
   * Check if error is explicitly non-retryable
   *
   * @param error - The error to check
   * @returns true if error is explicitly non-retryable
   */
  private isNonRetryableError(error: unknown): boolean {
    // Non-retryable HTTP codes
    if (this.isHttpError(error)) {
      const status = this.getHttpStatus(error);
      return this.nonRetryableHttpCodes.has(status);
    }

    return false;
  }

  /**
   * Type-safe property check
   *
   * @param obj - Object to check
   * @param key - Property key to check for
   * @returns true if object has the property
   */
  private hasProperty<K extends string>(obj: unknown, key: K): obj is Record<K, unknown> {
    return typeof obj === "object" && obj !== null && key in obj;
  }
}

/**
 * Create a custom error classifier with additional retryable/non-retryable rules
 *
 * @param options - Configuration options
 * @param options.retryableHttpCodes - Additional HTTP codes to treat as retryable
 * @param options.nonRetryableHttpCodes - Additional HTTP codes to treat as non-retryable
 * @returns A configured ErrorClassifier instance
 * @example
 * ```typescript
 * // Add custom retryable HTTP codes
 * const classifier = createErrorClassifier({
 *   retryableHttpCodes: [418, 425],
 *   nonRetryableHttpCodes: [451]
 * });
 * ```
 */
export function createErrorClassifier(options?: {
  retryableHttpCodes?: number[];
  nonRetryableHttpCodes?: number[];
}): ErrorClassifier {
  const classifier = new DefaultErrorClassifier();

  if (options?.retryableHttpCodes) {
    for (const code of options.retryableHttpCodes) {
      classifier["retryableHttpCodes"].add(code);
    }
  }

  if (options?.nonRetryableHttpCodes) {
    for (const code of options.nonRetryableHttpCodes) {
      classifier["nonRetryableHttpCodes"].add(code);
    }
  }

  return classifier;
}
