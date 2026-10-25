package org.x402.spring.cardano;

import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSigner;
import org.x402.mechanisms.cardano.exact.server.CardanoSellerSigner;

/**
 * Per-network override beans: a provider returns the seller or buyer signer for a network.
 * Return {@code null} to fall back to the YAML settings for that network. A single plain {@link
 * CardanoSellerSigner} or {@link ClientCardanoSigner} bean is accepted only when exactly one
 * Cardano network is configured; with several networks, define this provider instead.
 */
public interface X402CardanoNetworkBeans {

  /**
   * The Masumi seller for a network.
   *
   * @param network the Cardano network
   * @return the signer, or {@code null} for the YAML default
   */
  default CardanoSellerSigner sellerSigner(String network) {
    return null;
  }

  /**
   * The buyer's wallet for a network.
   *
   * @param network the Cardano network
   * @return the signer, or {@code null} for the YAML default
   */
  default ClientCardanoSigner clientSigner(String network) {
    return null;
  }

  /**
   * The chain backend for a network (used by the facilitator server).
   *
   * @param network the Cardano network
   * @return the backend, or {@code null} for the YAML default
   */
  default CardanoChainBackend chainBackend(String network) {
    return null;
  }
}
