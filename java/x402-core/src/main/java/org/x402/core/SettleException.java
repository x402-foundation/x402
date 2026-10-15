package org.x402.core;

import org.x402.core.types.SettleResponse;

/** A facilitator answered settle with an error status and a result body. */
public class SettleException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  private final int statusCode;
  private final transient SettleResponse response;

  /**
   * Creates the exception.
   *
   * @param statusCode the HTTP status
   * @param response the result body
   */
  public SettleException(int statusCode, SettleResponse response) {
    super(VerifyException.message(response.errorReason(), response.errorMessage()));
    this.statusCode = statusCode;
    this.response = response;
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
   * The result body.
   *
   * @return the response
   */
  public SettleResponse response() {
    return response;
  }
}
