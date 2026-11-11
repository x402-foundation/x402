package org.x402.e2e.server.mvc;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Wires the catalog-driven route handlers. */
@Configuration(proxyBeanMethods = false)
class MvcRoutesConfiguration {

  @Bean
  static CatalogRouteMappings catalogRouteMappings() {
    return new CatalogRouteMappings();
  }
}
