package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.testing.StubBackend;

/**
 * The confirmation wait ends when the settle's budget for chain calls does ({@code settleTimeout -
 * chainCallReserve}); a configured confirmation timeout above that budget can never take effect
 * and is reported. The default confirmation timeout stands for "as long as the settle allows".
 */
class ConfirmationBudgetWarningTest {

  private static boolean warnsAboutConfirmationTimeout(ExactCardanoFacilitatorOptions options) {
    return ExactCardanoFacilitatorScheme.configurationWarnings(new StubBackend(), options).stream()
        .anyMatch(w -> w.contains("confirmationTimeout"));
  }

  @Test
  void aConfirmationTimeoutBetweenTheBudgetAndTheSettleTimeoutIsReported() {
    // 75 s settle less the 15 s reserve leaves 60 s: a 70 s wait is cut to 60 s.
    assertThat(warnsAboutConfirmationTimeout(ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofSeconds(70)).build())).isTrue();
  }

  @Test
  void theConfiguredReserveCountsAgainstTheBudget() {
    ExactCardanoFacilitatorOptions.Builder options = ExactCardanoFacilitatorOptions.builder()
        .settleTimeout(Duration.ofSeconds(75)).chainCallReserve(Duration.ofSeconds(40));
    assertThat(warnsAboutConfirmationTimeout(options.confirmationTimeout(Duration.ofSeconds(36)).build())).isTrue();
    assertThat(warnsAboutConfirmationTimeout(options.confirmationTimeout(Duration.ofSeconds(35)).build())).isFalse();
  }

  @Test
  void aConfirmationTimeoutWithinTheBudgetIsNotReported() {
    assertThat(warnsAboutConfirmationTimeout(ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofSeconds(60)).build())).isFalse();
  }

  @Test
  void theDefaultConfirmationTimeoutIsNotReportedWhateverTheSettleTimeout() {
    assertThat(warnsAboutConfirmationTimeout(ExactCardanoFacilitatorOptions.defaults())).isFalse();
    assertThat(warnsAboutConfirmationTimeout(ExactCardanoFacilitatorOptions.builder()
        .settleTimeout(Duration.ofSeconds(30)).build())).isFalse();
  }

  @Test
  void theWarningNamesTheBudget() {
    assertThat(ExactCardanoFacilitatorScheme.configurationWarnings(new StubBackend(),
        ExactCardanoFacilitatorOptions.builder().confirmationTimeout(Duration.ofSeconds(70)).build()))
        .anySatisfy(w -> assertThat(w).contains("70000 ms").contains("75000 ms").contains("15000 ms")
            .contains("60000 ms"));
  }
}
