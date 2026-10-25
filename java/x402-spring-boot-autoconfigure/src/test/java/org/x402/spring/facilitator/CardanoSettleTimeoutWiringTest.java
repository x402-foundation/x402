package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;

/**
 * {@code settle-timeout} reaches the Cardano scheme, the backend Spring builds does not wait for
 * inclusion inside its submission, settings that cannot do what they suggest are logged, and the
 * constructor from before {@code settle-timeout} keeps every other setting.
 */
@ExtendWith(OutputCaptureExtension.class)
class CardanoSettleTimeoutWiringTest {

  private static final String PREPROD = "cardano:preprod";

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=" + PREPROD,
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k");
  }

  @Test
  void theSettleTimeoutPropertyReachesTheScheme() {
    runner().withPropertyValues("x402.facilitator-server.cardano.settle-timeout=30s").run(ctx -> {
      assertThat(ctx).hasNotFailed();
      assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).options(PREPROD).settleTimeout())
          .isEqualTo(Duration.ofSeconds(30));
    });
    runner().run(ctx -> assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).options(PREPROD)
        .settleTimeout()).isEqualTo(Duration.ofSeconds(75)));
  }

  @Test
  void theBlockfrostBackendSpringBuildsDoesNotWaitForInclusionInSubmit() {
    runner().run(ctx -> assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).backend(PREPROD))
        .isInstanceOfSatisfying(BlockfrostChainBackend.class,
            b -> assertThat(b.config().awaitConfirmation()).isFalse()));
  }

  @Test
  void aConfirmationTimeoutAboveTheSettleTimeoutIsLogged() {
    // Reported by the scheme against its budget (settle-timeout less chain-call-reserve), once;
    // the auto-configuration no longer logs a second copy.
    java.util.logging.Logger logger = java.util.logging.Logger.getLogger(
        org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme.class.getName());
    List<String> warnings = new java.util.ArrayList<>();
    java.util.logging.Handler handler = new java.util.logging.Handler() {
      @Override
      public void publish(java.util.logging.LogRecord record) {
        if (record.getMessage().contains("confirmationTimeout")) {
          warnings.add(record.getMessage());
        }
      }

      @Override
      public void flush() {}

      @Override
      public void close() {}
    };
    logger.addHandler(handler);
    try {
      runner().withPropertyValues(
              "x402.facilitator-server.cardano.confirmation-timeout=80s",
              "x402.facilitator-server.cardano.settle-timeout=60s")
          .run(ctx -> assertThat(ctx).hasNotFailed());
    } finally {
      logger.removeHandler(handler);
    }
    assertThat(warnings).singleElement().satisfies(w -> assertThat(w).contains("80000 ms").contains("60000 ms"));
  }

  @Test
  void theDefaultsLogNoTimeoutWarning(CapturedOutput output) {
    runner().run(ctx -> assertThat(ctx).hasNotFailed());
    assertThat(output).doesNotContain("is above settle-timeout").doesNotContain("above 85 s");
  }

  @Test
  void aSettleTimeoutAbove85SecondsIsLogged(CapturedOutput output) {
    runner().withPropertyValues("x402.facilitator-server.cardano.settle-timeout=100s")
        .run(ctx -> assertThat(ctx).hasNotFailed());
    assertThat(output).contains("settle-timeout is 100 s, above 85 s");
  }

  @Test
  void theConstructorWithoutSettleTimeoutKeepsEveryOtherSetting() {
    X402FacilitatorServerProperties.Network network = new X402FacilitatorServerProperties.Network(
        PREPROD, null, null, null, null, null, null);
    X402FacilitatorServerProperties.Cardano cardano = new X402FacilitatorServerProperties.Cardano(
        true, Duration.ofSeconds(61), Duration.ofSeconds(7), Duration.ofMinutes(3),
        Duration.ofSeconds(11), 12, "strict", 4096, List.of(network));

    assertThat(cardano.acceptMempool()).isTrue();
    assertThat(cardano.confirmationTimeout()).isEqualTo(Duration.ofSeconds(61));
    assertThat(cardano.confirmationPoll()).isEqualTo(Duration.ofSeconds(7));
    assertThat(cardano.settleTimeout()).isEqualTo(Duration.ofSeconds(75));
    assertThat(cardano.maxTipAge()).isEqualTo(Duration.ofMinutes(3));
    assertThat(cardano.lookupTimeout()).isEqualTo(Duration.ofSeconds(11));
    assertThat(cardano.maxInputLookups()).isEqualTo(12);
    assertThat(cardano.scriptDatumPolicy()).isEqualTo("strict");
    assertThat(cardano.maxTxBytes()).isEqualTo(4096);
    assertThat(cardano.networks()).containsExactly(network);
  }
}
