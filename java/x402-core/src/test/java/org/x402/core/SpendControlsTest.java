package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PREPROD;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.core.client.SpendControls;
import org.x402.core.client.SpendControls.AllowedAsset;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentRequirements;

/** Spend controls: default assets only, $1 cap. */
class SpendControlsTest {

  private static final String DEFAULT_ASSET_ERROR =
      "All payment requirements were rejected by spendControls: only default assets or entries "
          + "in spendControls.allowedAssets are allowed. Add an allowedAssets entry for "
          + "non-default tokens, set allowedAssets: true, or set spendControls: false.";

  private static PaymentRequirements usdm(String amount) {
    return new PaymentRequirements("exact", PREPROD, Fixtures.USDM, amount, "p", 300, null);
  }

  private static PaymentRequirements lovelace(String network, String amount) {
    return new PaymentRequirements("exact", network, "lovelace", amount, "p", 300, null);
  }

  private static X402Client client(SpendControls controls) {
    X402Client client = new X402Client().register("cardano:*", new FakeClientScheme());
    if (controls != null) {
      client.setSpendControls(controls);
    }
    return client;
  }

  @Test
  void lovelaceIsRefusedByDefault() {
    assertThatThrownBy(() -> client(null).selectPaymentRequirements(2,
        List.of(lovelace(PREPROD, "1500000"))))
        .isInstanceOf(X402ClientException.class)
        .hasMessage(DEFAULT_ASSET_ERROR);
    PaymentRequirements ok = usdm("10000");
    assertThat(client(SpendControls.defaults()).selectPaymentRequirements(2,
        List.of(lovelace(PREPROD, "1"), ok))).isEqualTo(ok);
  }

  @Test
  void lovelaceIsAcceptedViaAnAllowedAssetEntryAndCappedByIt() {
    SpendControls controls = SpendControls.builder()
        .allowedAssets(List.of(new AllowedAsset(PREPROD, "LOVELACE", "5000000")))
        .build();
    PaymentRequirements within = lovelace(PREPROD, "5000000");
    assertThat(client(controls).selectPaymentRequirements(2, List.of(within))).isEqualTo(within);
    assertThatThrownBy(() -> client(controls).selectPaymentRequirements(2,
        List.of(lovelace(PREPROD, "5000001"))))
        .hasMessage("All payment requirements were rejected by spendControls.allowedAssets "
            + "maxAmountPerPayment. Raise the per-asset cap, or omit maxAmountPerPayment to allow "
            + "uncapped (default assets then fall back to the top-level USD cap).");
    assertThatThrownBy(() -> client(controls).selectPaymentRequirements(2,
        List.of(lovelace(MAINNET, "1")))).hasMessage(DEFAULT_ASSET_ERROR);
  }

  @Test
  void anUncappedEntryAllowsAnyAmountAndWildcardNetworksMatch() {
    SpendControls controls = SpendControls.builder()
        .allowedAssets(List.of(new AllowedAsset("cardano:*", "lovelace", null)))
        .build();
    PaymentRequirements big = lovelace(MAINNET, "999999999999");
    assertThat(client(controls).selectPaymentRequirements(2, List.of(big))).isEqualTo(big);
    assertThat(client(controls).createPaymentPayload(Fixtures.paymentRequired(big))).isNotNull();
  }

  @Test
  void allowAnyAssetAcceptsEverything() {
    SpendControls controls = SpendControls.builder().allowAnyAsset().build();
    PaymentRequirements r = lovelace(PREPROD, "1500000");
    assertThat(client(controls).selectPaymentRequirements(2, List.of(r))).isEqualTo(r);
    assertThatThrownBy(() -> client(controls).selectPaymentRequirements(2,
        List.of(usdm("1000001")))).hasMessageContaining("maxAmountPerPayment ($1, including USDM)");
  }

  @Test
  void disabledSpendControlsAllowEverything() {
    PaymentRequirements r = lovelace(PREPROD, "999999999");
    PaymentRequirements expensive = usdm("999999999");
    X402Client client = client(SpendControls.disabled());
    assertThat(client.selectPaymentRequirements(2, List.of(r))).isEqualTo(r);
    assertThat(client.selectPaymentRequirements(2, List.of(expensive))).isEqualTo(expensive);
  }

  @Test
  void usdmIsCappedAtOneDollarByDefault() {
    PaymentRequirements dollar = usdm("1000000");
    assertThat(client(null).selectPaymentRequirements(2, List.of(dollar))).isEqualTo(dollar);
    assertThatThrownBy(() -> client(null).selectPaymentRequirements(2, List.of(usdm("1000001"))))
        .hasMessage("All payment requirements were rejected by spendControls.maxAmountPerPayment "
            + "($1, including USDM). Raise maxAmountPerPayment, set it to false to disable, set "
            + "allowedAssets[].maxAmountPerPayment for a per-asset atomic cap, or set "
            + "spendControls: false to disable all spend controls.");
  }

  @Test
  void aCustomUsdCapOrNoUsdCap() {
    SpendControls two = SpendControls.builder().maxAmountPerPayment("$2").build();
    PaymentRequirements r = usdm("2000000");
    assertThat(client(two).selectPaymentRequirements(2, List.of(r))).isEqualTo(r);
    SpendControls uncapped = SpendControls.builder().noUsdCap().build();
    PaymentRequirements huge = usdm("123456789000");
    assertThat(client(uncapped).selectPaymentRequirements(2, List.of(huge))).isEqualTo(huge);
    assertThatThrownBy(() -> client(uncapped).selectPaymentRequirements(2,
        List.of(lovelace(PREPROD, "1")))).hasMessage(DEFAULT_ASSET_ERROR);
  }

  @Test
  void anEntryMayNameTheDefaultAssetBySymbol() {
    SpendControls controls = SpendControls.builder()
        .allowedAssets(List.of(new AllowedAsset(PREPROD, "usdm", "5000000")))
        .build();
    PaymentRequirements r = usdm("5000000");
    assertThat(client(controls).selectPaymentRequirements(2, List.of(r))).isEqualTo(r);
  }

  @Test
  void aDollarValueAsAnEntryCapIsRejected() {
    SpendControls controls = SpendControls.builder()
        .allowedAssets(List.of(new AllowedAsset(PREPROD, "lovelace", "$5")))
        .build();
    assertThatThrownBy(() -> client(controls).selectPaymentRequirements(2,
        List.of(lovelace(PREPROD, "1"))))
        .hasMessage("spendControls.allowedAssets[].maxAmountPerPayment must be an integer atomic "
            + "amount, not a dollar value; got \"$5\"");
  }

  @Test
  void decimalLedgerAmountsCompareOneToOneAgainstTheUsdCap() {
    PaymentRequirements decimal = usdm("0.5");
    assertThat(client(null).selectPaymentRequirements(2, List.of(decimal))).isEqualTo(decimal);
    assertThatThrownBy(() -> client(null).selectPaymentRequirements(2, List.of(usdm("1.5"))))
        .hasMessageContaining("($1, including USDM)");
  }

  @Test
  void theAtomicCapIsPassedToTheScheme() {
    FakeClientScheme scheme = new FakeClientScheme();
    X402Client client = new X402Client().register(PREPROD, scheme);
    client.setSpendControls(SpendControls.builder()
        .allowedAssets(List.of(new AllowedAsset(PREPROD, "lovelace", "7"))).build());
    client.createPaymentPayload(Fixtures.paymentRequired(lovelace(PREPROD, "7")));
    assertThat(scheme.contexts.get(0).maxAmountPerPayment()).isEqualTo("7");
    assertThat(SpendControls.defaults().maxAmountPerPayment()).isEqualTo("$1");
    assertThat(SpendControls.disabled().enabled()).isFalse();
  }
}
