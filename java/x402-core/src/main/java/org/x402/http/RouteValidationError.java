package org.x402.http;

/**
 * One route configuration problem, with the option index and
 * facilitator for pin problems.
 *
 * @param route the route key, or {@code null} for a problem not tied to a route (a registered
 *     scheme the facilitators cannot serve)
 * @param scheme the option's scheme
 * @param network the option's network
 * @param reason the reason
 * @param message the human-readable message
 * @param optionIndex the option's index in {@code accepts}, or {@code null}
 * @param facilitator the facilitator involved, or {@code null}
 * @param retryable whether a re-sync may heal it (a facilitator that could serve it failed)
 */
public record RouteValidationError(
    String route,
    String scheme,
    String network,
    Reason reason,
    String message,
    Integer optionIndex,
    String facilitator,
    boolean retryable) {

  /** Why a route is invalid. */
  public enum Reason {
    /** No server scheme registered. */
    MISSING_SCHEME,
    /** No facilitator lists the kind, or the pinned one does not. */
    MISSING_FACILITATOR,
    /** The scheme lacks the transfer method. */
    UNSUPPORTED_ASSET_TRANSFER_METHOD,
    /** The transfer method lacks the payment flow. */
    UNSUPPORTED_PAYMENT_FLOW,
    /** The pin names no configured facilitator. */
    UNKNOWN_FACILITATOR,
    /** The facilitator's kind cannot serve the option (checked per option). */
    FACILITATOR_CAPABILITY,
    /** The option's own configuration is invalid, whatever the facilitator (never retryable). */
    INVALID_OPTION,
    /** Two options with different routing policies can match one payment. */
    AMBIGUOUS_OPTIONS;
  }
}
