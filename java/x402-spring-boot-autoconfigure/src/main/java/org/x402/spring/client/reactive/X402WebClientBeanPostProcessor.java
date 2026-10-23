package org.x402.spring.client.reactive;

import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.web.reactive.function.client.WebClient;
import org.x402.spring.client.TransportRedirects;

/**
 * Adds the x402 filter to self-built {@code WebClient} beans with {@code mutate().filter(…)},
 * which keeps their connector. Clients already carrying the filter (built from Boot's builder) are
 * left alone, so nothing is instrumented twice.
 */
public final class X402WebClientBeanPostProcessor implements BeanPostProcessor {

  private final ObjectProvider<X402ExchangeFilterFunction> filter;

  /**
   * Creates the post-processor.
   *
   * @param filter the filter, resolved on first use
   */
  public X402WebClientBeanPostProcessor(ObjectProvider<X402ExchangeFilterFunction> filter) {
    this.filter = filter;
  }

  @Override
  public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (bean instanceof WebClient client && !instrumented(client)) {
      WebClient.Builder builder = client.mutate();
      Object connector = connector(builder);
      X402ExchangeFilterFunction x402 = filter.getObject();
      return builder.filter(connector == null ? x402
          : x402.forTransport(TransportRedirects.of(connector))).build();
    }
    return bean;
  }

  /** The builder's connector; {@code null} when it was never set (the default is created later). */
  private static Object connector(WebClient.Builder builder) {
    java.lang.reflect.Field field = org.springframework.util.ReflectionUtils.findField(
        builder.getClass(), "connector");
    if (field == null) {
      return null;
    }
    try {
      org.springframework.util.ReflectionUtils.makeAccessible(field);
      return field.get(builder);
    } catch (IllegalAccessException | RuntimeException e) {
      return null;
    }
  }

  static boolean instrumented(WebClient client) {
    AtomicBoolean found = new AtomicBoolean();
    client.mutate().filters(list -> found.set(list.stream()
        .anyMatch(f -> f instanceof X402ExchangeFilterFunction)));
    return found.get();
  }
}
