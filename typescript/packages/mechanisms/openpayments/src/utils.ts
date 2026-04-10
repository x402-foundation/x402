import { OpenPaymentsClientError, type WalletAddress } from "@interledger/open-payments";
import { DEFAULT_MAX_RETRIES, DEFAULT_RETRY_DELAY_MS } from "./constants";

/** Thrown when `retryWithBackoff` exhausts attempts while `shouldRetry` still returns true. */
export class RetryConditionNotMetError extends Error {
  readonly name = "RetryConditionNotMetError";

  /**
   * Creates the error.
   *
   * @param message - Error message
   */
  constructor(message = "Max retries reached, condition not met") {
    super(message);
  }
}

/**
 * Extracts `extra.assetScale` from payment requirements when it is a finite number.
 *
 * @param extra - The extra field from PaymentRequirements
 * @returns The asset scale as a number, or undefined if not present or not finite
 */
export function getAssetScaleFromExtra(
  extra: Record<string, unknown> | undefined,
): number | undefined {
  const s = extra?.assetScale;
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
}

/**
 * Discover wallet address information by fetching the wallet address URL.
 *
 * @param walletAddressUrl - The Open Payments wallet address URL to fetch
 * @returns Wallet address response
 * @throws Error if the wallet address cannot be fetched or is missing required fields
 */
export async function discoverWalletAddress(walletAddressUrl: string): Promise<WalletAddress> {
  const response = await fetch(walletAddressUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch wallet address: ${response.status} ${response.statusText}`);
  }

  const walletAddress = (await response.json()) as Partial<WalletAddress>;
  if (!walletAddress.resourceServer || !walletAddress.authServer) {
    throw new Error(
      `Wallet address response at ${walletAddressUrl} missing resourceServer or authServer`,
    );
  }

  return walletAddress as WalletAddress;
}

/**
 * Retry a function with exponential backoff.
 *
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retries
 * @param initialDelayMs - Initial delay in milliseconds (doubles each attempt)
 * @param shouldRetry - Optional predicate; return true to trigger a retry based on the result
 * @returns Promise resolving to the function result
 * @throws Error if max retries are exhausted
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  initialDelayMs: number = DEFAULT_RETRY_DELAY_MS,
  shouldRetry?: (result: T) => boolean,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      if (shouldRetry && shouldRetry(result)) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, initialDelayMs * Math.pow(2, attempt)));
          continue;
        }
        throw new RetryConditionNotMetError();
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, initialDelayMs * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

/**
 * Wait for a condition function to return a truthy value, polling periodically.
 *
 * @param checkFn - Async function whose truthy return value ends the wait
 * @param maxWaitMs - Maximum wait time in milliseconds
 * @param checkIntervalMs - Polling interval in milliseconds
 * @returns Promise resolving to the first truthy result
 * @throws Error if max wait time is exceeded before condition is met
 */
export async function waitForCondition<T>(
  checkFn: () => Promise<T>,
  maxWaitMs: number,
  checkIntervalMs: number = 500,
): Promise<T> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const result = await checkFn();
    if (result) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
  }

  throw new Error(`Condition not met within ${maxWaitMs}ms`);
}

/**
 * Normalize a URL for comparison by removing trailing slashes, hash, and query string.
 *
 * @param url - URL to normalize
 * @returns Normalized URL string
 */
export function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    urlObj.pathname = urlObj.pathname.replace(/\/+$/, "");
    urlObj.hash = "";
    urlObj.search = "";
    return urlObj.toString();
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

/**
 * Returns a `.catch()` handler that re-throws with a context prefix.
 * Extracts `description` from Open Payments SDK errors before falling back to `message`.
 *
 * @param context - Prefix for the error message (e.g. `"Failed to create quote at https://..."`)
 * @returns A function suitable for use with `.catch()`
 */
export function wrapError(context: string): (error: unknown) => never {
  return (error: unknown) => {
    const message =
      error instanceof OpenPaymentsClientError
        ? error.description
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${context}: ${message}`);
  };
}

/**
 * Generate a cache key for payment URL replay tracking.
 *
 * @param incomingPaymentUrl - The incoming payment URL
 * @param resourceUrl - The x402 resource URL
 * @returns Cache key string
 */
export function generatePaymentUrlCacheKey(
  incomingPaymentUrl: string,
  resourceUrl: string,
): string {
  return `${incomingPaymentUrl}:${normalizeUrl(resourceUrl)}`;
}
