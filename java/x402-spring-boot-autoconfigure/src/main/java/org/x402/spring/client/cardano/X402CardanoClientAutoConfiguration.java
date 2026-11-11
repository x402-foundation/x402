package org.x402.spring.client.cardano;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.x402.core.client.X402Client;
import org.x402.mechanisms.cardano.exact.client.ClientCardanoSigner;
import org.x402.mechanisms.cardano.exact.client.ExactCardanoClientScheme;
import org.x402.spring.X402ClientSchemeDefaults;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.cardano.X402CardanoNetworkBeans;
import org.x402.spring.cardano.X402CardanoProperties;
import org.springframework.core.env.Environment;

/**
 * The Cardano payment client from {@code x402.client.cardano.*}: one {@link
 * ExactCardanoClientScheme} per network entry, registered after every customizer and only where
 * no scheme answers yet, so an application's scheme (exact or {@code cardano:*}) wins.
 */
@AutoConfiguration(after = X402AutoConfiguration.class)
@ConditionalOnClass(ExactCardanoClientScheme.class)
@ConditionalOnBean(X402Client.class)
public class X402CardanoClientAutoConfiguration {

  @Bean
  @ConditionalOnMissingBean
  X402CardanoClients x402CardanoClients(Environment environment,
      ObjectProvider<X402CardanoNetworkBeans> networkBeans,
      ObjectProvider<ClientCardanoSigner> signerBean) {
    return new X402CardanoClients(X402CardanoProperties.bind(environment).client().cardano(),
        networkBeans, signerBean);
  }

  @Bean
  X402ClientSchemeDefaults x402CardanoClientSchemes(X402CardanoClients clients) {
    return client -> clients.networks().forEach(network -> {
      if (!client.hasRegisteredScheme(network, "exact")) {
        client.register(network, new ExactCardanoClientScheme(clients.signer(network)));
      }
    });
  }
}
