package org.x402.examples.server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.x402.core.types.Money;
import org.x402.spring.X402DynamicPrice;
import org.x402.spring.X402ResourceServerCustomizer;

/**
 * Optional: what YAML can't express goes into beans. None of this is needed to get paid.
 */
@Configuration
class X402Customizations {

  private static final Logger LOG = LoggerFactory.getLogger(X402Customizations.class);

  /** Hooks on the resource server: here, one log line per settled payment. */
  @Bean
  X402ResourceServerCustomizer settlementLog() {
    return server -> server.onAfterSettle(ctx -> LOG.info("settled {} {} on {}: tx {}",
        ctx.requirements().amount(), ctx.requirements().asset(), ctx.requirements().network(),
        ctx.result().transaction()));
  }

  /**
   * A price decided per request, referenced from YAML as {@code price-ref: tieredPricer}. The
   * example YAML doesn't use it; an unreferenced bean changes nothing.
   */
  @Bean
  X402DynamicPrice tieredPricer() {
    return request -> "pro".equals(request.header("X-Plan"))
        ? new Money("$0.10")
        : new Money("$0.50");
  }
}
