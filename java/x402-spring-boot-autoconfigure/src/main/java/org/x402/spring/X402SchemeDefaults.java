package org.x402.spring;

import org.x402.core.server.X402ResourceServer;

/**
 * Registers default server schemes (e.g. the Cardano schemes built from YAML) after every {@link
 * X402ResourceServerCustomizer} ran. An implementation registers a scheme only where none is
 * registered yet, including wildcard registrations such as {@code cardano:*}, so a customizer's
 * scheme always wins.
 */
@FunctionalInterface
public interface X402SchemeDefaults {

  /**
   * Registers defaults.
   *
   * @param server the core server, already customized
   */
  void registerDefaults(X402ResourceServer server);
}
