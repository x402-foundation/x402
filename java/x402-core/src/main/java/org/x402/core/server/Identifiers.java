package org.x402.core.server;

/** Facilitator identifier normalization (trailing slashes are ignored). */
final class Identifiers {

  /** The identifier reserved for the in-process facilitator. */
  static final String LOCAL = "local";

  private Identifiers() {}

  /**
   * Removes trailing slashes, keeping a lone {@code /}.
   *
   * @param identifier the identifier
   * @return the normalized identifier
   */
  static String normalize(String identifier) {
    int end = identifier.length();
    while (end > 1 && identifier.charAt(end - 1) == '/') {
      end--;
    }
    return identifier.substring(0, end);
  }
}
