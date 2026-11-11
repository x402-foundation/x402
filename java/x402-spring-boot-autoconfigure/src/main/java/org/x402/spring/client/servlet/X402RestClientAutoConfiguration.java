package org.x402.spring.client.servlet;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder;
import org.springframework.boot.web.client.RestClientCustomizer;
import org.springframework.boot.web.client.RestTemplateCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.web.client.RestClient;
import org.x402.core.client.X402Client;
import org.x402.http.HostPolicy;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.properties.X402Properties;

/**
 * Blocking clients: {@code RestClient} and {@code RestTemplate} built from Boot's builders
 * pay through a decorated request factory; self-built beans get a warning and the {@link
 * X402ClientHttpRequestFactoryDecorator} bean ({@code x402Decorator}) for an explicit opt-in.
 */
@AutoConfiguration(after = X402AutoConfiguration.class)
@ConditionalOnClass({RestClient.class, ClientHttpRequestFactoryBuilder.class})
@ConditionalOnBean(X402Client.class)
public class X402RestClientAutoConfiguration {

  @Bean
  @ConditionalOnMissingBean
  X402ClientHttpRequestFactoryDecorator x402Decorator(X402Client client,
      ObjectProvider<HostPolicy> hostPolicy, X402Properties properties) {
    return new X402ClientHttpRequestFactoryDecorator(client,
        hostPolicy.getIfAvailable(() -> HostPolicy.of(java.util.List.of())),
        properties.client().maxReplayBody().toBytes());
  }

  @Bean
  static X402ClientHttpRequestFactoryBuilderPostProcessor x402ClientHttpRequestFactoryBuilderPostProcessor(
      ObjectProvider<X402ClientHttpRequestFactoryDecorator> decorator) {
    return new X402ClientHttpRequestFactoryBuilderPostProcessor(decorator);
  }

  @Bean
  RestClientCustomizer x402RestClientMarker() {
    return X402ClientBeanPostProcessor.restClientMarker();
  }

  @Bean
  RestTemplateCustomizer x402RestTemplateMarker() {
    return X402ClientBeanPostProcessor.restTemplateMarker();
  }

  @Bean
  @ConditionalOnProperty(prefix = "x402.client", name = "instrument-beans", havingValue = "true",
      matchIfMissing = true)
  static X402ClientBeanPostProcessor x402ClientBeanPostProcessor() {
    return new X402ClientBeanPostProcessor();
  }
}
