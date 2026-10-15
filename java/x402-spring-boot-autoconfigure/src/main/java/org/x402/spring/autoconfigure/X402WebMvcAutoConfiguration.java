package org.x402.spring.autoconfigure;

import jakarta.servlet.DispatcherType;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;
import org.springframework.beans.factory.BeanFactoryUtils;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.security.SecurityProperties;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Lazy;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.handler.HandlerMappingIntrospector;
import org.springframework.web.servlet.mvc.method.RequestMappingInfoHandlerMapping;
import org.x402.core.server.X402ResourceServer;
import org.x402.http.PaywallConfig;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.offer.OfferRouteResolver;
import org.x402.spring.offer.X402Offers;
import org.x402.spring.properties.X402Properties;
import org.x402.spring.web.servlet.ServletHandlerMethodSource;
import org.x402.spring.web.servlet.X402DispatchGuard;
import org.x402.spring.web.servlet.X402ServletFilter;

/**
 * WebMvc wiring: the handler → offer registry and the x402 servlet filter, registered for
 * {@code REQUEST} and {@code ASYNC} dispatches right after Spring Security ({@code
 * x402.filter-order} overrides).
 */
@AutoConfiguration(after = {X402AutoConfiguration.class, WebMvcAutoConfiguration.class})
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnClass(DispatcherServlet.class)
@ConditionalOnBean(X402HttpResourceServer.class)
public class X402WebMvcAutoConfiguration {

  /** Default filter order: right after Spring Security, so 401 comes before 402. */
  public static final int DEFAULT_FILTER_ORDER = SecurityProperties.DEFAULT_FILTER_ORDER + 1;

  // Not lazy: it checks every @X402Payment at startup, also under spring.main.lazy-initialization.
  @Bean
  @Lazy(false)
  @ConditionalOnMissingBean
  OfferRegistry x402OfferRegistry(X402Offers offers, X402ResourceServer server,
      ObjectProvider<RequestMappingInfoHandlerMapping> mappings) {
    return new OfferRegistry(new ServletHandlerMethodSource(
        () -> mappings.orderedStream().toList()), offers,
        OfferRegistry.settlesAfterHandler(offers, server));
  }

  @Bean
  WebMvcConfigurer x402DispatchGuard(ObjectProvider<OfferRegistry> registry) {
    X402DispatchGuard guard = new X402DispatchGuard(registry::getObject);
    return new WebMvcConfigurer() {
      @Override
      public void addInterceptors(InterceptorRegistry interceptors) {
        interceptors.addInterceptor(guard).order(Ordered.HIGHEST_PRECEDENCE);
      }
    };
  }

  @Bean
  @ConditionalOnMissingBean(name = "x402ServletFilter")
  FilterRegistrationBean<X402ServletFilter> x402ServletFilter(
      ObjectProvider<X402HttpResourceServer> server, ObjectProvider<OfferRegistry> registry,
      ObjectProvider<OfferRouteResolver> routes,
      ObjectProvider<HandlerMappingIntrospector> introspector, ApplicationContext context,
      ObjectProvider<PaywallConfig> paywallConfig, X402Properties properties) {
    Supplier<List<HandlerMapping>> mappings = () -> {
      HandlerMappingIntrospector i = introspector.getIfAvailable();
      if (i != null && i.getHandlerMappings() != null) {
        return i.getHandlerMappings();
      }
      List<HandlerMapping> found = new ArrayList<>(BeanFactoryUtils
          .beansOfTypeIncludingAncestors(context, HandlerMapping.class, true, false).values());
      AnnotationAwareOrderComparator.sort(found);
      return found;
    };
    X402ServletFilter filter = new X402ServletFilter(server::getObject, registry::getObject,
        routes::getObject, mappings, paywallConfig.getIfAvailable(),
        properties.paywall().enabled());
    FilterRegistrationBean<X402ServletFilter> registration =
        new FilterRegistrationBean<>(filter);
    registration.setName("x402Filter");
    registration.setOrder(properties.filterOrder() != null ? properties.filterOrder()
        : DEFAULT_FILTER_ORDER);
    registration.setDispatcherTypes(DispatcherType.REQUEST, DispatcherType.ASYNC);
    registration.setAsyncSupported(true);
    return registration;
  }
}
