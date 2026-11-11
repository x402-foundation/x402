package org.x402.spring.client.reactive;

import java.util.Collection;
import java.util.function.Consumer;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.http.client.HttpRedirects;
import org.springframework.boot.http.client.reactive.ClientHttpConnectorBuilder;
import org.springframework.boot.http.client.reactive.ClientHttpConnectorSettings;
import org.springframework.http.client.reactive.ClientHttpConnector;

/**
 * Wraps Boot's {@link ClientHttpConnectorBuilder} bean so the connector of Boot's {@code
 * WebClient.Builder} sends paid requests through a twin built with the same settings and
 * redirects disabled, so each Boot-built client holds two connectors (two connection pools): a
 * redirect must never carry {@code PAYMENT-SIGNATURE} to another host.
 */
public final class X402ClientHttpConnectorBuilderPostProcessor implements BeanPostProcessor {

  @Override
  public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (bean instanceof ClientHttpConnectorBuilder<?> builder && !(bean instanceof Delegating)) {
      return new Delegating(builder);
    }
    return bean;
  }

  /** Builds both connectors with the delegate. */
  static final class Delegating implements ClientHttpConnectorBuilder<ClientHttpConnector> {
    private final ClientHttpConnectorBuilder<?> delegate;

    Delegating(ClientHttpConnectorBuilder<?> delegate) {
      this.delegate = delegate;
    }

    @Override
    public ClientHttpConnector build(ClientHttpConnectorSettings settings) {
      ClientHttpConnectorSettings base = settings != null ? settings
          : ClientHttpConnectorSettings.defaults();
      return new X402ClientHttpConnector(delegate.build(settings),
          delegate.build(base.withRedirects(HttpRedirects.DONT_FOLLOW)));
    }

    @Override
    @SuppressWarnings({"unchecked", "rawtypes"})
    public ClientHttpConnectorBuilder<ClientHttpConnector> withCustomizers(
        Collection<Consumer<ClientHttpConnector>> customizers) {
      return new Delegating(((ClientHttpConnectorBuilder) delegate)
          .withCustomizers((Collection) customizers));
    }
  }
}
