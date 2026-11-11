package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.core.client.SpendControls;
import org.x402.core.client.SpendControls.AllowedAsset;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequirements;

/** Allowing any asset keeps the per-asset caps that are configured explicitly. */
class SpendControlsAllowAnyAssetTest {

  private static PaymentRequirements lovelace(String amount) {
    return new PaymentRequirements("exact", PREPROD, "lovelace", amount, "p", 300, null);
  }

  private static X402Client client(SpendControls controls) {
    return new X402Client().register("cardano:*", new FakeClientScheme()).setSpendControls(controls);
  }

  private static SpendControls allowAnyWithLovelaceCap() {
    return SpendControls.builder().noUsdCap().allowAnyAsset()
        .allowedAssets(List.of(new AllowedAsset(PREPROD, "lovelace", "5000000"))).build();
  }

  @Test
  void anExplicitCapStillRefusesALargerPayment() {
    assertThatThrownBy(() -> client(allowAnyWithLovelaceCap())
        .selectPaymentRequirements(2, List.of(lovelace("500000000"))))
        .hasMessageContaining("allowedAssets maxAmountPerPayment");
  }

  @Test
  void anExplicitCapStillAllowsAPaymentWithinIt() {
    PaymentRequirements r = lovelace("5000000");
    assertThat(client(allowAnyWithLovelaceCap()).selectPaymentRequirements(2, List.of(r))).isEqualTo(r);
  }

  @Test
  void anUnlistedAssetStaysAllowedAndUncapped() {
    SpendControls controls = SpendControls.builder().noUsdCap().allowAnyAsset()
        .allowedAssets(List.of(new AllowedAsset("cardano:mainnet", "lovelace", "1"))).build();
    PaymentRequirements r = lovelace("500000000");
    assertThat(client(controls).selectPaymentRequirements(2, List.of(r))).isEqualTo(r);
  }
}
