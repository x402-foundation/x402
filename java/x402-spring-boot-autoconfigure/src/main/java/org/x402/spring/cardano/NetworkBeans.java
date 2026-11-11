package org.x402.spring.cardano;

import java.util.function.Function;
import org.springframework.beans.factory.ObjectProvider;
import org.x402.spring.X402ConfigurationException;

/** Resolves a per-network override: provider, else a single plain bean, else none. */
public final class NetworkBeans {

  private NetworkBeans() {}

  /**
   * Resolves the bean for one network.
   *
   * @param <T> the bean type
   * @param network the network
   * @param networkCount how many Cardano networks are configured in this role
   * @param provider the by-network provider bean, if any
   * @param fromProvider reads the provider for a network
   * @param plain a plain bean of the type, if any
   * @param type the type name for messages
   * @return the bean, or {@code null} to use the YAML settings
   * @throws X402ConfigurationException for a plain bean with several networks
   */
  public static <T> T resolve(String network, int networkCount,
      ObjectProvider<X402CardanoNetworkBeans> provider,
      Function<X402CardanoNetworkBeans, T> fromProvider, ObjectProvider<T> plain, String type) {
    X402CardanoNetworkBeans beans = provider.getIfAvailable();
    if (beans != null) {
      T found = fromProvider.apply(beans);
      if (found != null) {
        return found;
      }
    }
    T single = plain.getIfUnique();
    if (single == null) {
      long candidates = plain.stream().count();
      if (candidates > 1) {
        throw new X402ConfigurationException(candidates + " " + type + " beans and none is "
            + "@Primary; mark one @Primary, or define an X402CardanoNetworkBeans bean that "
            + "returns one per network");
      }
      return null;
    }
    if (networkCount > 1) {
      throw new X402ConfigurationException("a single " + type + " bean cannot serve "
          + networkCount + " Cardano networks; define an X402CardanoNetworkBeans bean that "
          + "returns one per network");
    }
    return single;
  }
}
