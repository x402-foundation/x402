package org.x402.spring;

/** The x402 starter configuration is invalid; startup fails with this message. */
public class X402ConfigurationException extends IllegalStateException {

  private static final long serialVersionUID = 1L;

  /**
   * Creates the exception.
   *
   * @param message what is wrong and how to fix it
   */
  public X402ConfigurationException(String message) {
    super(message);
  }
}
