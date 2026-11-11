package org.x402.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.x402.core.SchemeNetworkClient;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequirements;
import org.x402.spring.autoconfigure.X402AutoConfiguration;

/** {@code allow-any-asset} next to an {@code allowed-assets} cap keeps the cap. */
class SpendControlsAllowAnyAssetBindingTest {

  private static final SchemeNetworkClient ECHO = new SchemeNetworkClient() {
    @Override
    public String scheme() {
      return "exact";
    }

    @Override
    public PaymentPayloadResult createPaymentPayload(
        int x402Version, PaymentRequirements requirements, PaymentPayloadContext context) {
      return new PaymentPayloadResult(x402Version, Map.of("signed", requirements.amount()), null);
    }
  };

  private static PaymentRequirements lovelace(String amount) {
    return new PaymentRequirements("exact", "test:net", "lovelace", amount, "p", 300, null);
  }

  @Test
  void anAllowedAssetCapHoldsUnderAllowAnyAsset() {
    new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(X402AutoConfiguration.class))
        .withPropertyValues("x402.client.enabled=true",
            "x402.client.spend-controls.allow-any-asset=true",
            "x402.client.spend-controls.allowed-assets[0].network=test:net",
            "x402.client.spend-controls.allowed-assets[0].asset=lovelace",
            "x402.client.spend-controls.allowed-assets[0].max-amount-per-payment=5000000")
        .run(ctx -> {
          assertThat(ctx).hasNotFailed();
          X402Client client = ctx.getBean(X402Client.class).register("test:*", ECHO);
          assertThatThrownBy(() -> client.selectPaymentRequirements(2,
              List.of(lovelace("500000000"))))
              .hasMessageContaining("allowedAssets maxAmountPerPayment");
          PaymentRequirements within = lovelace("5000000");
          assertThat(client.selectPaymentRequirements(2, List.of(within))).isEqualTo(within);
        });
  }
}
