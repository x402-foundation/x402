package org.x402.e2e.client.networks;

/** Environment lookups shared by the client and its networks. */
public final class E2eEnv {

  private E2eEnv() {}

  /**
   * An environment value, trimmed.
   *
   * @param name the variable
   * @param fallback the value when it is unset or blank
   * @return the value or the fallback
   */
  public static String envOr(String name, String fallback) {
    String value = System.getenv(name);
    return value == null || value.isBlank() ? fallback : value.trim();
  }
}
