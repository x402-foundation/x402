package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Code that built the Cardano properties before {@code settle-timeout} existed still compiles. */
class CardanoPropertiesCompatibilityTest {

  @Test
  void theConstructorWithoutSettleTimeoutDefaultsIt() {
    X402FacilitatorServerProperties.Cardano cardano = new X402FacilitatorServerProperties.Cardano(
        false, Duration.ofSeconds(75), Duration.ofSeconds(5), Duration.ofMinutes(5),
        Duration.ofSeconds(10), 64, "reference", 65536, List.of());
    assertThat(cardano.settleTimeout()).isEqualTo(Duration.ofSeconds(75));
    assertThat(cardano.maxTipAge()).isEqualTo(Duration.ofMinutes(5));
  }
}
