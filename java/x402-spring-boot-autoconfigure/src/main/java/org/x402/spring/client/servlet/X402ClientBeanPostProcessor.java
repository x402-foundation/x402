package org.x402.spring.client.servlet;

import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicBoolean;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.web.client.RestClientCustomizer;
import org.springframework.boot.web.client.RestTemplateCustomizer;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpRequestInitializer;
import org.springframework.http.client.support.HttpAccessor;
import org.springframework.util.ReflectionUtils;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestTemplate;

/**
 * Warns about self-built {@code RestClient} / {@code RestTemplate} beans: their request factory
 * cannot be read and wrapped safely afterwards, so they are left unchanged and do not pay. Clients
 * built from Boot's builders carry {@link #MARKER} and are skipped silently, as are clients whose
 * factory was decorated with {@code x402Decorator.decorate(factory, nonRedirectingFactory)}.
 */
public final class X402ClientBeanPostProcessor implements BeanPostProcessor {

  /** A no-op initializer marking clients built from Boot's (x402-instrumented) builders. */
  public static final ClientHttpRequestInitializer MARKER = request -> { };

  private static final Log LOG = LogFactory.getLog(X402ClientBeanPostProcessor.class);

  /**
   * Marks {@code RestClient.Builder}s.
   *
   * @return the customizer
   */
  public static RestClientCustomizer restClientMarker() {
    return builder -> builder.requestInitializer(MARKER);
  }

  /**
   * Marks {@code RestTemplateBuilder}-built templates.
   *
   * @return the customizer
   */
  public static RestTemplateCustomizer restTemplateMarker() {
    return template -> {
      if (!template.getClientHttpRequestInitializers().contains(MARKER)) {
        template.getClientHttpRequestInitializers().add(MARKER);
      }
    };
  }

  @Override
  public Object postProcessAfterInitialization(Object bean, String beanName) {
    if (bean instanceof RestClient client && !instrumented(client)) {
      warn("RestClient", beanName, "RestClient.Builder");
    } else if (bean instanceof RestTemplate template && !instrumented(template)) {
      warn("RestTemplate", beanName, "RestTemplateBuilder");
    }
    return bean;
  }

  private static void warn(String type, String beanName, String builder) {
    LOG.warn("x402: " + type + " bean '" + beanName + "' was not built from Boot's " + builder
        + ", so it does not pay 402s and is left unchanged. Build it from the injected " + builder
        + ", or give it a paying factory at construction: x402Decorator.decorate(factory, nonRedirectingFactory) "
        + "(inject X402ClientHttpRequestFactoryDecorator).");
  }

  static boolean instrumented(RestClient client) {
    RestClient.Builder builder = client.mutate();
    AtomicBoolean marked = new AtomicBoolean();
    builder.requestInitializers(list -> marked.set(list.contains(MARKER)));
    return marked.get() || decorated(read(builder, "requestFactory"));
  }

  static boolean instrumented(RestTemplate template) {
    return template.getClientHttpRequestInitializers().contains(MARKER)
        || decorated(read(template, "requestFactory"));
  }

  private static boolean decorated(Object factory) {
    return factory instanceof X402ClientHttpRequestFactory;
  }

  /** Reads a private factory field; {@code null} when Spring's internals differ. */
  private static Object read(Object target, String name) {
    Class<?> owner = target instanceof RestTemplate ? HttpAccessor.class : target.getClass();
    Field field = ReflectionUtils.findField(owner, name, ClientHttpRequestFactory.class);
    if (field == null) {
      return null;
    }
    try {
      ReflectionUtils.makeAccessible(field);
      return field.get(target);
    } catch (IllegalAccessException | RuntimeException e) {
      return null;
    }
  }
}
