/**
 * Status message type for displaying user feedback.
 * Uses discriminated union pattern for type safety.
 */
export type Status =
  | { type: "success"; message: string }
  | { type: "error"; message: string }
  | { type: "info"; message: string };

/**
 * Helper to create a success status.
 *
 * @param message - Success message to display.
 * @returns Status object with type "success".
 */
export function statusSuccess(message: string): Status {
  return { type: "success", message };
}

/**
 * Helper to create an error status.
 *
 * @param message - Error message to display.
 * @returns Status object with type "error".
 */
export function statusError(message: string): Status {
  return { type: "error", message };
}

/**
 * Helper to create an info status.
 *
 * @param message - Info message to display.
 * @returns Status object with type "info".
 */
export function statusInfo(message: string): Status {
  return { type: "info", message };
}

/**
 * Helper to clear status (returns null).
 *
 * @returns null to clear status.
 */
export function statusClear(): null {
  return null;
}
