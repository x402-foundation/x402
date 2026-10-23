package org.x402.core;

/**
 * A facilitator answered verify or settle with an error status and no verdict body (the message
 * reads e.g. {@code Facilitator verify failed (503): busy}). Unlike {@link
 * FacilitatorResponseException} it is not a transport failure for the HTTP layer: the request ends
 * in a 402 rather than a 502. A 5xx or 429 status still counts as a transport-level failure for
 * opt-in verify failover.
 */
public class FacilitatorStatusException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  private final int statusCode;

  /**
   * Creates the exception.
   *
   * @param message the message, e.g. {@code Facilitator verify failed (503): busy}
   * @param statusCode the HTTP status
   */
  public FacilitatorStatusException(String message, int statusCode) {
    super(message);
    this.statusCode = statusCode;
  }

  /**
   * The HTTP status.
   *
   * @return the status
   */
  public int statusCode() {
    return statusCode;
  }
}
