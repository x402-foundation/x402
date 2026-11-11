package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

/**
 * A numeric Retry-After too large for milliseconds asks for the longest wait, so it waits the
 * 30 s cap like any other large value; a value that is not a number is no Retry-After at all.
 */
class HttpFacilitatorClientRetryAfterTest {

  private final Clock clock = Clock.fixed(Instant.parse("2026-10-12T00:00:00Z"), ZoneOffset.UTC);

  @Test
  void aTwentyDigitValueWaitsTheCap() {
    assertThat(HttpFacilitatorClient.computeRetryDelay("99999999999999999999", 0, clock))
        .isEqualTo(Duration.ofSeconds(30));
    assertThat(HttpFacilitatorClient.computeRetryDelay("99999999999999999999", 2, clock))
        .isEqualTo(Duration.ofSeconds(30));
  }

  @Test
  void aValueThatOverflowsOnlyWhenMultipliedToMillisWaitsTheCap() {
    // 2^63 / 1000 is about 9.22e15: this parses as a long but overflows as milliseconds.
    assertThat(HttpFacilitatorClient.computeRetryDelay("9223372036854776", 0, clock))
        .isEqualTo(Duration.ofSeconds(30));
  }

  @Test
  void aBigButRepresentableValueIsStillCappedAtThirtySeconds() {
    assertThat(HttpFacilitatorClient.computeRetryDelay("9000000000000", 0, clock))
        .isEqualTo(Duration.ofSeconds(30));
  }

  @Test
  void aValueThatIsNotANumberFallsBackToBackoff() {
    assertThat(HttpFacilitatorClient.computeRetryDelay("soon", 0, clock))
        .isEqualTo(Duration.ofSeconds(1));
  }
}
