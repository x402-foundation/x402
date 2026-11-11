package org.x402.spring;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.FilteredClassLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.x402.spring.autoconfigure.X402AutoConfiguration;
import org.x402.spring.autoconfigure.X402MechanismCheckAutoConfiguration;
import org.x402.spring.cardano.X402CardanoAutoConfiguration;
import org.x402.spring.client.cardano.X402CardanoClientAutoConfiguration;
import org.x402.spring.facilitator.X402FacilitatorServerAutoConfiguration;

/**
 * Mechanisms are not part of the starter: an application adds the ones it uses. Configuration
 * that names a mechanism whose module is missing must fail at startup and name the dependency to
 * add, never start without it.
 */
class MechanismOnClasspathTest {

  private static final String PREPROD_ADDRESS = "addr_test1qzdjjcstngx8yneqv4d2phmz35ytkyxk4aa09rf"
      + "exu7kj3evleltf708u3qyrn29sudutxqqy0vx5f3lv73dtewsdras79zz7d";
  private static final FilteredClassLoader WITHOUT_CARDANO =
      new FilteredClassLoader("org.x402.mechanisms.cardano");

  private static ApplicationContextRunner server() {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402MechanismCheckAutoConfiguration.class,
            X402AutoConfiguration.class,
            X402CardanoAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitators[0].url=http://127.0.0.1:9/x402",
            "x402.accounts.seller.network=cardano:preprod",
            "x402.accounts.seller.pay-to=" + PREPROD_ADDRESS,
            "x402.routes.weather.path=GET /weather",
            "x402.routes.weather.accepts[0].account=seller",
            "x402.routes.weather.accepts[0].price=$0.01");
  }

  @Test
  void aCardanoServerStartsWithTheMechanism() {
    server().run(ctx -> assertThat(ctx).hasNotFailed());
  }

  @Test
  void aCardanoServerWithoutTheMechanismFailsAndNamesTheDependency() {
    server().withClassLoader(WITHOUT_CARDANO).run(ctx -> assertThat(ctx).getFailure()
            .hasStackTraceContaining("x402-mechanism-cardano"));
  }

  @Test
  void aServerWithoutCardanoConfigurationStartsWithoutTheMechanism() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402MechanismCheckAutoConfiguration.class,
            X402AutoConfiguration.class,
            X402CardanoAutoConfiguration.class))
        .withClassLoader(WITHOUT_CARDANO)
        .withPropertyValues("x402.facilitators[0].url=http://127.0.0.1:9/x402")
        .run(ctx -> assertThat(ctx).hasNotFailed());
  }

  @Test
  void aCardanoClientWithoutTheMechanismFailsAndNamesTheDependency() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402MechanismCheckAutoConfiguration.class,
            X402AutoConfiguration.class,
            X402CardanoClientAutoConfiguration.class))
        .withClassLoader(WITHOUT_CARDANO)
        .withPropertyValues(
            "x402.client.enabled=true",
            "x402.client.cardano.networks[0].network=cardano:preprod",
            "x402.client.cardano.networks[0].mnemonic=placeholder")
        .run(ctx -> assertThat(ctx).getFailure()
            .hasStackTraceContaining("x402-mechanism-cardano"));
  }

  @Test
  void aCardanoFacilitatorWithoutTheMechanismFailsAndNamesTheDependency() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402MechanismCheckAutoConfiguration.class,
            X402FacilitatorServerAutoConfiguration.class))
        .withClassLoader(WITHOUT_CARDANO)
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=cardano:preprod",
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=placeholder")
        .run(ctx -> assertThat(ctx).getFailure()
            .hasStackTraceContaining("x402-mechanism-cardano"));
  }

  @Test
  void relaxedSpellingsAreRecognised() {
    ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402MechanismCheckAutoConfiguration.class))
        .withClassLoader(WITHOUT_CARDANO);
    // camelCase, as YAML may write it; the environment-variable form binds to the same name.
    runner.withPropertyValues("x402.facilitatorServer.enabled=true",
            "x402.facilitatorServer.cardano.networks[0].network=cardano:preprod")
        .run(ctx -> assertThat(ctx).getFailure()
            .hasStackTraceContaining("x402-mechanism-cardano"));
    // A bracketed map key.
    runner.withPropertyValues("x402.accounts[seller].network=cardano:preprod")
        .run(ctx -> assertThat(ctx).getFailure()
            .hasStackTraceContaining("x402-mechanism-cardano"));
  }

  @Test
  void configurationThatWiresNothingIsNotChecked() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402MechanismCheckAutoConfiguration.class))
        .withClassLoader(WITHOUT_CARDANO)
        .withPropertyValues(
            "x402.enabled=false",
            "x402.accounts.seller.network=cardano:preprod",
            "x402.client.cardano.networks[0].network=cardano:preprod",
            "x402.facilitator-server.cardano.networks[0].network=cardano:preprod")
        .run(ctx -> assertThat(ctx).hasNotFailed());
  }
}
