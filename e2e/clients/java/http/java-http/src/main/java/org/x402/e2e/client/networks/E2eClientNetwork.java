package org.x402.e2e.client.networks;

import org.x402.core.client.X402Client;
import org.x402.core.types.SettleResponse;

/**
 * One network the e2e client can pay on, created only when its env is set, like the per-network
 * blocks of the Go, Python and TypeScript clients. Add a network by adding an implementation in
 * {@code networks.impl} and its {@code fromEnv()} call in {@code Main}.
 */
public interface E2eClientNetwork {

  /**
   * The CAIP-2 namespace this network handles, e.g. {@code cardano}.
   *
   * @return the namespace
   */
  String namespace();

  /**
   * Registers this network's schemes.
   *
   * @param client the client
   */
  void register(X402Client client);

  /**
   * Runs after a {@code PAYMENT-RESPONSE} on this network (also a failed one), e.g. to wait until
   * the wallet's change is visible to the next client process. Must not throw.
   *
   * @param settle the settlement response
   */
  default void afterSettle(SettleResponse settle) {}
}
