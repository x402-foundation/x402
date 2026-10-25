package org.x402.spring.client.reactive;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.http.client.reactive.ClientHttpConnectorBuilder;
import org.springframework.boot.web.reactive.function.client.WebClientCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.client.WebClient;
import org.x402.core.client.X402Client;
import org.x402.http.HostPolicy;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.properties.X402Properties;

/**
 * WebClient payments. Independent of the reactive server: a servlet app using {@code
 * WebClient} gets it too. Boot's {@code WebClient.Builder} gets the x402 filter; self-built {@code
 * WebClient} beans are instrumented with {@code mutate().filter(…)}.
 */
@AutoConfiguration(after = X402AutoConfiguration.class)
@ConditionalOnClass(WebClient.class)
@ConditionalOnBean(X402Client.class)
public class X402WebClientAutoConfiguration {

  @Bean
  @ConditionalOnMissingBean
  X402ExchangeFilterFunction x402ExchangeFilterFunction(X402Client client,
      ObjectProvider<HostPolicy> hostPolicy, X402Properties properties) {
    return new X402ExchangeFilterFunction(client,
        hostPolicy.getIfAvailable(() -> HostPolicy.of(java.util.List.of())),
        properties.client().maxReplayBody().toBytes());
  }

  @Bean
  WebClientCustomizer x402WebClientCustomizer(ObjectProvider<X402ExchangeFilterFunction> filter) {
    return builder -> builder.filters(filters -> {
      if (filters.stream().noneMatch(f -> f instanceof X402ExchangeFilterFunction)) {
        filters.add(filter.getObject());
      }
    });
  }

  @Bean
  @ConditionalOnProperty(prefix = "x402.client", name = "instrument-beans", havingValue = "true",
      matchIfMissing = true)
  static X402WebClientBeanPostProcessor x402WebClientBeanPostProcessor(
      ObjectProvider<X402ExchangeFilterFunction> filter) {
    return new X402WebClientBeanPostProcessor(filter);
  }

  /** Paid requests of Boot-built WebClients never follow redirects. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(ClientHttpConnectorBuilder.class)
  static class ConnectorConfiguration {

    @Bean
    static X402ClientHttpConnectorBuilderPostProcessor x402ClientHttpConnectorBuilderPostProcessor() {
      return new X402ClientHttpConnectorBuilderPostProcessor();
    }
  }
}
