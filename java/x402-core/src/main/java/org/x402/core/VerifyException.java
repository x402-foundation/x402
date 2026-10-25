package org.x402.core;

import org.x402.core.types.VerifyResponse;

/** A facilitator answered verify with an error status and a verdict body. */
public class VerifyException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  private final int statusCode;
  private final transient VerifyResponse response;

  /**
   * Creates the exception.
   *
   * @param statusCode the HTTP status
   * @param response the verdict body
   */
  public VerifyException(int statusCode, VerifyResponse response) {
    super(message(response.invalidReason(), response.invalidMessage()));
    this.statusCode = statusCode;
    this.response = response;
  }

  static String message(String reason, String detail) {
    String r = reason == null || reason.isEmpty() ? "unknown reason" : reason;
    return detail == null || detail.isEmpty() ? r : r + ": " + detail;
  }

  /**
   * The HTTP status.
   *
   * @return the status
   */
  public int statusCode() {
    return statusCode;
  }

  /**
   * The verdict body.
   *
   * @return the response
   */
  public VerifyResponse response() {
    return response;
  }
}
