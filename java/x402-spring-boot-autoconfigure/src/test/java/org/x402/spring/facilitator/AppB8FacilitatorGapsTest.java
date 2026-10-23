package org.x402.spring.facilitator;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.okJson;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;

import com.github.tomakehurst.wiremock.junit5.WireMockExtension;
import java.time.Clock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;

/**
 * Work package B8-gaps, Spring part: the app's provider-identity and readiness tests
 * (ProviderNetworkIdentityTest, ChainReadinessTest) against the starter's facilitator server with a
 * WireMock Blockfrost. The starter derives the expected network magic from the (alias-normalized)
 * network, builds one backend per configured network and fails startup for a network without a
 * provider.
 */
class AppB8FacilitatorGapsTest {

  @RegisterExtension
  static WireMockExtension wm = WireMockExtension.newInstance().options(wireMockConfig().dynamicPort()).build();

  private static final String PREPROD = "cardano:preprod";

  @BeforeEach
  void reset() {
    wm.resetAll();
  }

  private static void freshTip() {
    long slot = CardanoNetworks.currentSlot(PREPROD, Clock.systemUTC());
    wm.stubFor(get("/blocks/latest").willReturn(okJson("{\"height\":103,\"slot\":" + slot + "}")));
  }

  private static ApplicationContextRunner runner(String network) {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=" + network,
            "x402.facilitator-server.cardano.networks[0].blockfrost.base-url=" + wm.baseUrl(),
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k");
  }

  /**
   * GP ProviderNetworkIdentityTest#matchingProviderIsHealthyAndIdentityIsCached, the cip34 row
   * ({@code cip34:0-1,1}): a CIP-34 alias configures its canonical network and expects magic 1.
   */
  @Test
  void aCip34AliasExpectsTheCanonicalNetworksMagic() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":1}")));
    freshTip();

    runner("cip34:0-1").run(ctx -> {
      CardanoFacilitatorSchemes schemes = ctx.getBean(CardanoFacilitatorSchemes.class);
      assertThat(schemes.networks()).containsExactly(PREPROD);
      Health health = ctx.getBean(X402FacilitatorHealthIndicator.class).health();
      assertThat(health.getStatus()).isEqualTo(Status.UP);
      assertThat(health.getDetails().toString()).contains(PREPROD).contains("UP");
    });
  }

  /** GP ProviderNetworkIdentityTest#wrongNetworkIsUnhealthy..., for the alias: a mainnet provider is DOWN. */
  @Test
  void aProviderOnAnotherNetworkMakesTheAliasedNetworkUnhealthy() {
    wm.stubFor(get("/genesis").willReturn(okJson("{\"network_magic\":764824073}")));
    freshTip();

    runner("cip34:0-1").run(ctx -> {
      Health health = ctx.getBean(X402FacilitatorHealthIndicator.class).health();
      assertThat(health.getStatus()).isEqualTo(Status.DOWN);
      assertThat(health.getDetails().toString()).contains("does not serve the configured network");
    });
  }

  /** GAP ProviderNetworkIdentityTest#unavailableIdentityFailsClosed (:55-63), through the starter. */
  @Test
  void anUnreadableProviderIdentityMakesTheNetworkUnhealthy() {
    wm.stubFor(get("/genesis").willReturn(aResponse().withStatus(503)));
    freshTip();

    runner(PREPROD).run(ctx -> {
      Health health = ctx.getBean(X402FacilitatorHealthIndicator.class).health();
      assertThat(health.getStatus()).isEqualTo(Status.DOWN);
    });
  }

  /**
   * GP ChainReadinessTest#missingRequiredBackendIsUnavailable. The starter has no optional
   * network: a configured network without a provider or backend bean never starts, so a facilitator
   * cannot report ready with a missing backend.
   */
  @Test
  void aConfiguredNetworkWithoutAProviderFailsStartup() {
    new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=" + PREPROD)
        .run(ctx -> {
          assertThat(ctx).hasFailed();
          Throwable failure = ctx.getStartupFailure();
          StringBuilder chain = new StringBuilder();
          for (Throwable t = failure; t != null; t = t.getCause()) {
            chain.append(t.getMessage()).append(" | ");
          }
          assertThat(chain.toString()).contains("blockfrost.project-id is required");
        });
  }
}
