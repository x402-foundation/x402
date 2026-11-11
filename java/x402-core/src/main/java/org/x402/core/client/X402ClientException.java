package org.x402.core.client;

/**
 * The client refused or failed to create a payment: no acceptable option, spend controls, a hook
 * abort, or an HTTP-layer refusal.
 */
public class X402ClientException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  /**
   * Creates the exception.
   *
   * @param message the message
   */
  public X402ClientException(String message) {
    super(message);
  }

  /**
   * Creates the exception with a cause.
   *
   * @param message the message
   * @param cause the cause
   */
  public X402ClientException(String message, Throwable cause) {
    super(message, cause);
  }
}
