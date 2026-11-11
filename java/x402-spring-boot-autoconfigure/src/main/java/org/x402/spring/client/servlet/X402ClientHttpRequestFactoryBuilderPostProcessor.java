package org.x402.spring.client.servlet;

import java.util.Collection;
import java.util.function.Consumer;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder;
import org.springframework.boot.http.client.ClientHttpRequestFactorySettings;
import org.springframework.http.client.ClientHttpRequestFactory;

/**
 * Wraps Boot's {@link ClientHttpRequestFactoryBuilder} bean so every factory it builds for {@code
 * RestClient.Builder} and {@code RestTemplateBuilder} is decorated with x402. The delegate still
 * builds the transport, so Boot's and your HTTP settings (TLS, proxy, timeouts) are kept. Paid
 * requests use a second factory built with the same settings and redirects disabled, so each
 * Boot-built client holds two transports (two connection pools): a redirect must never carry
 * {@code PAYMENT-SIGNATURE} to another host.
 */
public final class X402ClientHttpRequestFactoryBuilderPostProcessor implements BeanPostProcessor {

  private final ObjectProvider<X402ClientHttpRequestFactoryDecorator> decorator;

  /**
   * Creates the post-processor.
   *
   * @param decorator the decorator, resolved when a factory is built
   */
  public X402ClientHttpRequestFactoryBuilderPostProcessor(
      ObjectProvider<X402ClientHttpRequestFactoryDecorator> decorator) {
    this.decorator = decorator;
  }

  @Override
  public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (bean instanceof ClientHttpRequestFactoryBuilder<?> builder
        && !(bean instanceof Delegating)) {
      return new Delegating(builder, decorator);
    }
    return bean;
  }

  /** Builds with the delegate, then decorates. */
  static final class Delegating implements ClientHttpRequestFactoryBuilder<ClientHttpRequestFactory> {
    private final ClientHttpRequestFactoryBuilder<?> delegate;
    private final ObjectProvider<X402ClientHttpRequestFactoryDecorator> decorator;

    Delegating(ClientHttpRequestFactoryBuilder<?> delegate,
        ObjectProvider<X402ClientHttpRequestFactoryDecorator> decorator) {
      this.delegate = delegate;
      this.decorator = decorator;
    }

    @Override
    public ClientHttpRequestFactory build(ClientHttpRequestFactorySettings settings) {
      ClientHttpRequestFactorySettings base = settings != null ? settings
          : ClientHttpRequestFactorySettings.defaults();
      // The paid request never follows a redirect.
      return decorator.getObject().decorate(delegate.build(settings),
          delegate.build(base.withRedirects(ClientHttpRequestFactorySettings.Redirects.DONT_FOLLOW)));
    }

    @Override
    @SuppressWarnings({"unchecked", "rawtypes"})
    public ClientHttpRequestFactoryBuilder<ClientHttpRequestFactory> withCustomizers(
        Collection<Consumer<ClientHttpRequestFactory>> customizers) {
      return new Delegating(((ClientHttpRequestFactoryBuilder) delegate)
          .withCustomizers((Collection) customizers), decorator);
    }
  }
}
