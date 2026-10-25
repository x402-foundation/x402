package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.logging.Handler;
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
 * A confirmation-timeout above 85 s is not warned about as a resource-server timeout risk: the
 * settle budget ends the wait first, which the scheme warns about once, and the resource-server
 * bound is settle-timeout, warned about on its own. The auto-configuration only notes which
 * setting bounds the settle.
 */
@ExtendWith(OutputCaptureExtension.class)
class ConfirmationTimeoutWarnedOnceTest {

  private static ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402FacilitatorServerAutoConfiguration.class))
        .withPropertyValues(
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.cardano.networks[0].network=cardano:preprod",
            "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=k");
  }

  private static List<String> schemeWarnings(ApplicationContextRunner runner) {
    Logger logger = Logger.getLogger(ExactCardanoFacilitatorScheme.class.getName());
    List<String> warnings = new ArrayList<>();
    Handler handler = new Handler() {
      @Override
      public void publish(LogRecord record) {
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
      runner.run(ctx -> assertThat(ctx).hasNotFailed());
    } finally {
      logger.removeHandler(handler);
    }
    return warnings;
  }

  @Test
  void aLongConfirmationTimeoutUnderTheDefaultSettleTimeoutIsReportedOnlyAgainstTheBudget(
      CapturedOutput output) {
    List<String> warnings = schemeWarnings(
        runner().withPropertyValues("x402.facilitator-server.cardano.confirmation-timeout=100s"));

    assertThat(warnings).singleElement().satisfies(w -> assertThat(w).contains("100000 ms").contains("60000 ms"));
    assertConfirmationNoteOnly(output, "confirmation-timeout is 100 s");
  }

  /** The auto-configuration's line on confirmation-timeout is a note naming settle-timeout, not a warning. */
  private static void assertConfirmationNoteOnly(CapturedOutput output, String marker) {
    List<String> lines = output.toString().lines().filter(l -> l.contains(marker)).toList();
    assertThat(lines).isNotEmpty().allSatisfy(l -> assertThat(l)
        .doesNotContain("WARN").doesNotContain("slow confirmation").contains("settle-timeout ("));
  }

  @Test
  void aLongConfirmationTimeoutTheSettleAllowsIsReportedThroughTheSettleTimeout(CapturedOutput output) {
    List<String> warnings = schemeWarnings(runner().withPropertyValues(
        "x402.facilitator-server.cardano.confirmation-timeout=100s",
        "x402.facilitator-server.cardano.settle-timeout=120s"));

    assertThat(warnings).isEmpty();
    assertThat(output).contains("settle-timeout is 120 s, above 85 s");
    assertConfirmationNoteOnly(output, "confirmation-timeout is 100 s");
  }
}
