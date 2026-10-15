package org.x402.spring.autoconfigure;

import java.util.List;
import java.util.function.Supplier;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.security.SecurityProperties;
import org.springframework.boot.autoconfigure.web.reactive.WebFluxAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Lazy;
import org.springframework.web.reactive.DispatcherHandler;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.reactive.result.method.RequestMappingInfoHandlerMapping;
import org.springframework.web.reactive.result.method.annotation.RequestMappingHandlerAdapter;
import org.x402.core.server.X402ResourceServer;
import org.x402.http.PaywallConfig;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.offer.OfferRouteResolver;
import org.x402.spring.offer.X402Offers;
import org.x402.spring.properties.X402Properties;
import org.x402.spring.web.reactive.ReactiveHandlerMethodSource;
import org.x402.spring.web.reactive.X402DispatchGuardHandlerAdapter;
import org.x402.spring.web.reactive.X402WebFilter;

/**
 * WebFlux wiring: the handler → offer registry over the reactive mappings and the x402 web
 * filter, ordered right after Spring Security's {@code WebFilterChainProxy} ({@code
 * x402.filter-order} overrides).
 */
@AutoConfiguration(after = {X402AutoConfiguration.class, WebFluxAutoConfiguration.class})
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.REACTIVE)
@ConditionalOnClass(DispatcherHandler.class)
@ConditionalOnBean(X402HttpResourceServer.class)
public class X402WebFluxAutoConfiguration {

  /** Default order: right after Spring Security ({@code -100}). */
  public static final int DEFAULT_FILTER_ORDER = SecurityProperties.DEFAULT_FILTER_ORDER + 1;

  // Not lazy: it checks every @X402Payment at startup, also under spring.main.lazy-initialization.
  @Bean
  @Lazy(false)
  @ConditionalOnMissingBean
  OfferRegistry x402OfferRegistry(X402Offers offers, X402ResourceServer server,
      ObjectProvider<RequestMappingInfoHandlerMapping> mappings) {
    return new OfferRegistry(new ReactiveHandlerMethodSource(
        () -> mappings.orderedStream().toList()), offers,
        OfferRegistry.settlesAfterHandler(offers, server));
  }

  @Bean
  X402DispatchGuardHandlerAdapter x402DispatchGuardHandlerAdapter(OfferRegistry registry,
      ObjectProvider<RequestMappingHandlerAdapter> adapter) {
    return new X402DispatchGuardHandlerAdapter(registry, adapter::getObject);
  }

  @Bean
  @ConditionalOnMissingBean
  X402WebFilter x402WebFilter(X402HttpResourceServer server, OfferRegistry registry,
      OfferRouteResolver routes, ObjectProvider<DispatcherHandler> dispatcher,
      ObjectProvider<PaywallConfig> paywallConfig, X402Properties properties) {
    Supplier<List<HandlerMapping>> mappings = new Supplier<>() {
      private volatile List<HandlerMapping> cached;

      @Override
      public List<HandlerMapping> get() {
        List<HandlerMapping> m = cached;
        if (m == null) {
          DispatcherHandler handler = dispatcher.getIfAvailable();
          m = handler == null || handler.getHandlerMappings() == null ? List.of()
              : handler.getHandlerMappings();
          cached = m;
        }
        return m;
      }
    };
    return new X402WebFilter(server, registry, routes, mappings, paywallConfig.getIfAvailable(),
        properties.paywall().enabled(),
        properties.filterOrder() != null ? properties.filterOrder() : DEFAULT_FILTER_ORDER);
  }
}
