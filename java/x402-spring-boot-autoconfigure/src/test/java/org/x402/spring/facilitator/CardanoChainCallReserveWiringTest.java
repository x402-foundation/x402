package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.x402.mechanisms.cardano.exact.facilitator.ExactCardanoFacilitatorScheme;

/**
 * {@code chain-call-reserve} reaches the Cardano scheme, and a confirmation timeout the settle
 * budget ({@code settle-timeout} less {@code chain-call-reserve}) always cuts short is reported
 * once per scheme, by the scheme, not again by the auto-configuration.
 */
@ExtendWith(OutputCaptureExtension.class)
class CardanoChainCallReserveWiringTest {

  private static final String PREPROD = "cardano:preprod";

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=" + PREPROD,
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k");
  }

  /** The confirmation-timeout warnings the scheme logs while {@code run} runs. */
  private static List<String> schemeWarnings(Consumer<ApplicationContextRunner> run, ApplicationContextRunner r) {
    Logger logger = Logger.getLogger(ExactCardanoFacilitatorScheme.class.getName());
    List<String> warnings = new ArrayList<>();
    Handler handler = new Handler() {
      @Override
      public void publish(LogRecord record) {
        if (record.getLevel() == Level.WARNING && record.getMessage().contains("confirmationTimeout")) {
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
      run.accept(r);
    } finally {
      logger.removeHandler(handler);
    }
    return warnings;
  }

  @Test
  void theChainCallReservePropertyReachesTheScheme() {
    runner().withPropertyValues("x402.facilitator-server.cardano.chain-call-reserve=40s").run(ctx -> {
      assertThat(ctx).hasNotFailed();
      assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).options(PREPROD).chainCallReserve())
          .isEqualTo(Duration.ofSeconds(40));
    });
    runner().run(ctx -> assertThat(ctx.getBean(CardanoFacilitatorSchemes.class).options(PREPROD)
        .chainCallReserve()).isEqualTo(Duration.ofSeconds(15)));
  }

  @Test
  void aChainCallReserveAsLongAsTheSettleTimeoutFailsStartup() {
    runner().withPropertyValues(
            "x402.facilitator-server.cardano.settle-timeout=60s",
            "x402.facilitator-server.cardano.chain-call-reserve=60s")
        .run(ctx -> assertThat(ctx).hasFailed());
  }

  @Test
  void aConfirmationTimeoutAboveTheBudgetIsReportedOnceByTheScheme(CapturedOutput output) {
    List<String> warnings = schemeWarnings(r -> r.run(ctx -> assertThat(ctx).hasNotFailed()),
        runner().withPropertyValues(
            "x402.facilitator-server.cardano.confirmation-timeout=50s",
            "x402.facilitator-server.cardano.chain-call-reserve=40s"));

    assertThat(warnings).hasSize(1);
    assertThat(warnings.get(0)).contains("50000 ms").contains("35000 ms");
    assertThat(output).doesNotContain("is above settle-timeout");
  }

  @Test
  void theAutoConfigurationLogsNoSecondCopy(CapturedOutput output) {
    List<String> warnings = schemeWarnings(r -> r.run(ctx -> assertThat(ctx).hasNotFailed()),
        runner().withPropertyValues(
            "x402.facilitator-server.cardano.confirmation-timeout=80s",
            "x402.facilitator-server.cardano.settle-timeout=60s"));

    assertThat(warnings).hasSize(1);
    assertThat(output).doesNotContain("confirmation-timeout (80 s)");
  }

  @Test
  void theDefaultsReportNoConfirmationTimeout() {
    assertThat(schemeWarnings(r -> r.run(ctx -> assertThat(ctx).hasNotFailed()), runner())).isEmpty();
  }
}
