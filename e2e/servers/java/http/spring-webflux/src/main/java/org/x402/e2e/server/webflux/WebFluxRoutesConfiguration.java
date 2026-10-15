package org.x402.e2e.server.webflux;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Wires the catalog-driven route handlers. */
@Configuration(proxyBeanMethods = false)
class WebFluxRoutesConfiguration {

  @Bean
  static CatalogRouteMappings catalogRouteMappings() {
    return new CatalogRouteMappings();
  }
}
