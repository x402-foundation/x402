package org.x402.spring;

import org.x402.core.client.X402Client;

/**
 * Registers default client schemes (e.g. the Cardano wallets built from YAML) after every {@link
 * X402ClientCustomizer} ran, only where no scheme is registered yet (wildcards included), so a
 * customizer's scheme (an HSM signer, say) always wins.
 */
@FunctionalInterface
public interface X402ClientSchemeDefaults {

  /**
   * Registers defaults.
   *
   * @param client the client, already customized
   */
  void registerDefaults(X402Client client);
}
