package org.x402.spring;

import org.x402.core.server.X402ResourceServer;
import org.x402.http.X402HttpResourceServer;

/**
 * Customizes the auto-configured resource server: register schemes and hooks. Customizers run in
 * {@code @Order}; a scheme registered here replaces an auto-registered one for the same scheme and
 * network.
 */
@FunctionalInterface
public interface X402ResourceServerCustomizer {

  /**
   * Customizes the core server before its first sync.
   *
   * @param server the server
   */
  void customize(X402ResourceServer server);

  /**
   * Customizes the HTTP server (protected-request hooks, paywall) after it is created.
   *
   * @param server the HTTP server
   */
  default void customizeHttp(X402HttpResourceServer server) {}
}
