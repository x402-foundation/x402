package org.x402.spring.starter;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.autoconfigure.X402MechanismCheckAutoConfiguration;
import org.x402.spring.facilitator.X402FacilitatorServerAutoConfiguration;

/**
 * On the starter's own classpath, which has no mechanism (see {@link StarterClasspathTest}), not
 * a filtered one: nothing may link against a missing mechanism, and configuration that needs one
 * fails with the dependency to add.
 */
class StarterWithoutMechanismTest {

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(
        X402MechanismCheckAutoConfiguration.class, X402AutoConfiguration.class,
        X402FacilitatorServerAutoConfiguration.class));
  }

  @Test
  void aFacilitatorWithoutCardanoNetworksStarts() {
    runner().withPropertyValues("x402.enabled=false", "x402.facilitator-server.enabled=true")
        .run(ctx -> assertThat(ctx).hasNotFailed());
  }

  @Test
  void aCardanoFacilitatorFailsAndNamesTheDependency() {
    runner().withPropertyValues("x402.enabled=false", "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=cardano:preprod")
        .run(ctx -> assertThat(ctx).getFailure()
            .hasStackTraceContaining("x402-mechanism-cardano"));
  }

  @Test
  void aCardanoServerFailsAndNamesTheDependency() {
    runner().withPropertyValues("x402.facilitators[0].url=http://127.0.0.1:9/x402",
            "x402.accounts.seller.network=cardano:preprod",
            "x402.accounts.seller.pay-to=addr_test1placeholder",
            "x402.routes.weather.path=GET /weather",
            "x402.routes.weather.accepts[0].account=seller",
            "x402.routes.weather.accepts[0].price=$0.01")
        .run(ctx -> assertThat(ctx).getFailure()
            .hasStackTraceContaining("x402-mechanism-cardano"));
  }
}
