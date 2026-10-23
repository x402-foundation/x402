package org.x402.core.server;

/**
 * Whether a client's extension echoes preserve the server's advertisement.
 *
 * @param valid whether the echoes are acceptable
 * @param invalidReason {@code extension_echo_mismatch} when not
 * @param extensionKey the offending extension key when not
 */
public record ExtensionValidation(boolean valid, String invalidReason, String extensionKey) {

  /** The valid result. */
  public static final ExtensionValidation VALID = new ExtensionValidation(true, null, null);

  /**
   * An echo mismatch.
   *
   * @param key the extension key
   * @return the result
   */
  public static ExtensionValidation mismatch(String key) {
    return new ExtensionValidation(false, "extension_echo_mismatch", key);
  }
}
