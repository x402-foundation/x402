package org.x402.e2e.server;

import java.util.function.Function;

/** Environment lookups shared by the server configuration and the network accounts. */
public final class E2eEnv {

  private E2eEnv() {}

  /**
   * Whether a value is unset or blank.
   *
   * @param s the value
   * @return {@code true} when {@code null} or blank
   */
  public static boolean isBlank(String s) {
    return s == null || s.isBlank();
  }

  /**
   * An environment value, trimmed.
   *
   * @param env the environment lookup
   * @param key the variable
   * @param fallback the value when it is unset or blank
   * @return the value or the fallback
   */
  public static String envOr(Function<String, String> env, String key, String fallback) {
    String v = env.apply(key);
    return isBlank(v) ? fallback : v.trim();
  }
}
