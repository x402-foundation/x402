package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ReactiveWebApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** An application's own {@code x402FacilitatorRoutes} bean replaces the auto-configured one. */
class FacilitatorRoutesOverrideTest {

  private static final String[] PROPERTIES = {
      "x402.facilitator-server.enabled=true",
      "x402.facilitator-server.cardano.networks[0].network=cardano:preprod",
      "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k"};

  @Configuration(proxyBeanMethods = false)
  static class OwnMvcRoutes {
    @Bean
    org.springframework.web.servlet.function.RouterFunction<
        org.springframework.web.servlet.function.ServerResponse> x402FacilitatorRoutes() {
      return org.springframework.web.servlet.function.RouterFunctions.route()
          .GET("/own", r -> org.springframework.web.servlet.function.ServerResponse.ok().build())
          .build();
    }
  }

  @Configuration(proxyBeanMethods = false)
  static class OwnWebFluxRoutes {
    @Bean
    org.springframework.web.reactive.function.server.RouterFunction<
        org.springframework.web.reactive.function.server.ServerResponse> x402FacilitatorRoutes() {
      return org.springframework.web.reactive.function.server.RouterFunctions.route()
          .GET("/own", r -> org.springframework.web.reactive.function.server.ServerResponse.ok()
              .build())
          .build();
    }
  }

  @Test
  void mvcBacksOff() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withUserConfiguration(OwnMvcRoutes.class)
        .withPropertyValues(PROPERTIES)
        .run(ctx -> assertThat(ctx).hasNotFailed().hasBean("x402FacilitatorRoutes"));
  }

  @Test
  void webFluxBacksOff() {
    new ReactiveWebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withUserConfiguration(OwnWebFluxRoutes.class)
        .withPropertyValues(PROPERTIES)
        .run(ctx -> assertThat(ctx).hasNotFailed().hasBean("x402FacilitatorRoutes"));
  }
}
