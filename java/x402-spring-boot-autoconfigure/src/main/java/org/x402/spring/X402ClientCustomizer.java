package org.x402.spring;

import org.x402.core.client.X402Client;

/** Customizes the auto-configured payment client: register schemes, policies and hooks. */
@FunctionalInterface
public interface X402ClientCustomizer {

  /**
   * Customizes the client.
   *
   * @param client the client
   */
  void customize(X402Client client);
}
