package org.x402.mechanisms.cardano.chain;

/** A chain provider call failed (network error, unexpected status, malformed answer). */
public final class ChainLookupException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  /**
   * Creates the exception.
   *
   * @param message what failed
   */
  public ChainLookupException(String message) {
    super(message);
  }

  /**
   * Creates the exception with a cause.
   *
   * @param message what failed
   * @param cause the cause
   */
  public ChainLookupException(String message, Throwable cause) {
    super(message, cause);
  }
}
