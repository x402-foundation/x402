package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentRequirements;

/**
 * A scheme can decline an option it cannot pay ({@link SchemeNetworkClient#supports}); the client
 * then selects among the options left, as if the declined one had never been offered.
 */
class SchemeSupportsSelectionTest {

  private static final String PREPROD = "cardano:preprod";
  private static final String USDM = "usdmPolicy.usdm";

  /**
   * Pays lovelace only. {@code supports} carries no {@code @Override}, so this compiles against
   * an interface without the method and the test fails on behaviour, not on compilation.
   */
  static final class LovelaceOnly implements SchemeNetworkClient {

    @Override
    public String scheme() {
      return "exact";
    }

    @Override
    public PaymentPayloadResult createPaymentPayload(
        int x402Version, PaymentRequirements requirements, PaymentPayloadContext context) {
      return new PaymentPayloadResult(x402Version, Map.of("signed", requirements.amount()), null);
    }

    public boolean supports(PaymentRequirements requirements) {
      return "lovelace".equals(requirements.asset());
    }
  }

  private static PaymentRequirements option(String asset) {
    return new PaymentRequirements("exact", PREPROD, asset, "1000000", "addr_test1pay", 300,
        Map.of());
  }

  private static X402Client client(SchemeNetworkClient scheme) {
    return new X402Client().register(PREPROD, scheme).setSpendControls(SpendControls.disabled());
  }

  @Test
  void aDeclinedOptionIsSkippedAndTheNextOneIsPaid() {
    PaymentRequirements usdm = option(USDM);
    PaymentRequirements lovelace = option("lovelace");
    assertThat(client(new LovelaceOnly()).selectPaymentRequirements(2, List.of(usdm, lovelace)))
        .isEqualTo(lovelace);
  }

  @Test
  void everyOptionDeclinedFailsLikeAnUnregisteredScheme() {
    assertThatThrownBy(() -> client(new LovelaceOnly())
        .selectPaymentRequirements(2, List.of(option(USDM))))
        .isInstanceOf(X402ClientException.class)
        .hasMessageContaining("No network/scheme registered");
  }

  @Test
  void aSchemeWithoutAnOverrideSelectsAsBefore() {
    PaymentRequirements usdm = option(USDM);
    PaymentRequirements lovelace = option("lovelace");
    assertThat(client(new FakeClientScheme()).selectPaymentRequirements(2, List.of(usdm, lovelace)))
        .isEqualTo(usdm);
  }
}
