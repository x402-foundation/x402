package org.x402.core;

/**
 * A facilitator call failed at transport level or returned an unusable body.
 * {@link Timeout} is the subclass for a request that timed out.
 */
public class FacilitatorResponseException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  private final int statusCode;

  /**
   * Creates the exception.
   *
   * @param message the message
   * @param statusCode the HTTP status, or 0 when there was no response
   * @param cause the cause, may be {@code null}
   */
  public FacilitatorResponseException(String message, int statusCode, Throwable cause) {
    super(message, cause);
    this.statusCode = statusCode;
  }

  /**
   * The HTTP status, or 0 when no response arrived.
   *
   * @return the status
   */
  public int statusCode() {
    return statusCode;
  }

  /** The facilitator did not answer in time. */
  public static class Timeout extends FacilitatorResponseException {

    private static final long serialVersionUID = 1L;

    private final String operation;
    private final long timeoutMillis;

    /**
     * Creates the exception.
     *
     * @param operation {@code verify}, {@code settle} or {@code supported}
     * @param timeoutMillis the timeout that elapsed
     */
    public Timeout(String operation, long timeoutMillis) {
      super("Facilitator " + operation + " timed out after " + timeoutMillis + "ms", 0, null);
      this.operation = operation;
      this.timeoutMillis = timeoutMillis;
    }

    /**
     * The operation.
     *
     * @return the operation
     */
    public String operation() {
      return operation;
    }

    /**
     * The elapsed timeout.
     *
     * @return milliseconds
     */
    public long timeoutMillis() {
      return timeoutMillis;
    }
  }
}
