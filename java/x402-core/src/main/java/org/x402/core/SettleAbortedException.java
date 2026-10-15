package org.x402.core;

/**
 * A facilitator before-settle hook aborted (its message is {@code Settlement
 * aborted: <reason>}). The HTTP handler maps it to a 200 abort body.
 */
public class SettleAbortedException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  private final String reason;

  /**
   * Creates the exception.
   *
   * @param reason the hook's reason
   */
  public SettleAbortedException(String reason) {
    super("Settlement aborted: " + reason);
    this.reason = reason;
  }

  /**
   * The hook's reason.
   *
   * @return the reason
   */
  public String reason() {
    return reason;
  }
}
