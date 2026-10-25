package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.LazyInitializationBeanFactoryPostProcessor;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.web.servlet.WebMvcAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.spring.annotation.X402Payment;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.autoconfigure.X402WebMvcAutoConfiguration;

/**
 * An {@code @X402Payment} naming no offer fails startup even with lazy initialization, instead of
 * on the first request.
 */
class EagerOfferValidationTest {

  @RestController
  static class Misconfigured {
    @GetMapping("/paid")
    @X402Payment("missing")
    String paid() {
      return "ok";
    }
  }

  @Test
  void anUnknownOfferFailsStartupUnderLazyInitialization() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(WebMvcAutoConfiguration.class,
            X402AutoConfiguration.class, X402WebMvcAutoConfiguration.class))
        .withInitializer(ctx -> ctx.addBeanFactoryPostProcessor(
            new LazyInitializationBeanFactoryPostProcessor()))
        .withUserConfiguration(Misconfigured.class)
        .withPropertyValues("x402.facilitators[0].url=http://127.0.0.1:1")
        .run(ctx -> {
          assertThat(ctx).hasFailed();
          assertThat(ctx.getStartupFailure()).rootCause().hasMessageContaining("names no offer");
        });
  }
}
