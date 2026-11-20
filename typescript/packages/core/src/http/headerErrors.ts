/**
 * Adds an actionable diagnostic for Node HTTP response-header overflow errors.
 *
 * @param error - The transport error, possibly wrapping a parser error in its cause
 * @returns An error retaining the original cause, or undefined for unrelated failures
 */
export function getResponseHeadersOverflowError(error: unknown): Error | undefined {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (code === "UND_ERR_HEADERS_OVERFLOW" || code === "HPE_HEADER_OVERFLOW") {
      return new Error(
        "Response headers exceed the HTTP client's size limit. A large PAYMENT-REQUIRED header " +
          "(for example, Bazaar metadata) may be responsible. Ask the server operator to reduce the response headers.",
        { cause: error },
      );
    }
    current = cause;
  }
  return undefined;
}
