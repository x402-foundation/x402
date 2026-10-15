package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.map;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.x402.core.client.PaymentPolicies;
import org.x402.core.client.SpendControls;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;

/** The client's option selection pipeline and the built-in policies. */
class ClientSelectionTest {

  private static PaymentRequirements req(String scheme, String network, String amount) {
    return new PaymentRequirements(scheme, network, Fixtures.USDM, amount, "p", 300, null);
  }

  private static X402Client client() {
    return new X402Client().register(PREPROD, new FakeClientScheme())
        .register(MAINNET, new FakeClientScheme());
  }

  @Test
  void keepsOnlyRegisteredNetworkAndScheme() {
    PaymentRequirements upto = req("upto", PREPROD, "1");
    PaymentRequirements base = req("exact", "eip155:8453", "1");
    PaymentRequirements ok = req("exact", MAINNET, "1");
    assertThat(client().selectPaymentRequirements(2, List.of(upto, base, ok))).isEqualTo(ok);
    assertThatThrownBy(() -> client().selectPaymentRequirements(2, List.of(upto, base)))
        .isInstanceOf(X402ClientException.class)
        .hasMessageStartingWith("No network/scheme registered for x402 version: 2 which comply "
            + "with the payment requirements.");
    assertThatThrownBy(() -> client().selectPaymentRequirements(1, List.of(base)))
        .hasMessage("No client registered for x402 version: 1");
  }

  @Test
  void wildcardRegistrationsMatchAnyNetworkOfTheFamily() {
    X402Client client = new X402Client().register("cardano:*", new FakeClientScheme());
    PaymentRequirements preview = req("exact", "cardano:preview", "1");
    assertThat(client.selectPaymentRequirements(2, List.of(preview))).isEqualTo(preview);
  }

  @Test
  void dropsUnknownPaymentFlowsAndPrefersAuthorization() {
    PaymentRequirements weird = req("exact", PREPROD, "1").withExtra("paymentFlow", "streaming");
    PaymentRequirements upfront = req("exact", PREPROD, "2").withExtra("paymentFlow", "upfront");
    PaymentRequirements auth = req("exact", PREPROD, "3")
        .withExtra("paymentFlow", "authorization");
    PaymentRequirements plain = req("exact", PREPROD, "4");
    assertThat(client().selectPaymentRequirements(2, List.of(weird, upfront, auth, plain)))
        .isEqualTo(auth);
    assertThat(client().selectPaymentRequirements(2, List.of(weird, upfront))).isEqualTo(upfront);
    assertThatThrownBy(() -> client().selectPaymentRequirements(2, List.of(weird)))
        .hasMessage("No payment requirements with a recognized paymentFlow for x402 version: 2");
  }

  @Test
  void spendControlsRunBeforePoliciesAndPoliciesRunInOrder() {
    List<String> seen = new CopyOnWriteArrayList<>();
    X402Client client = client();
    client.registerPolicy((v, reqs) -> {
      seen.add("p1:" + reqs.size());
      return reqs.subList(1, reqs.size());
    });
    client.registerPolicy((v, reqs) -> {
      seen.add("p2:" + reqs.size());
      return reqs;
    });
    PaymentRequirements tooExpensive = req("exact", PREPROD, "2000000");
    PaymentRequirements a = req("exact", PREPROD, "1");
    PaymentRequirements b = req("exact", MAINNET, "2");
    assertThat(client.selectPaymentRequirements(2, List.of(tooExpensive, a, b))).isEqualTo(b);
    assertThat(seen).containsExactly("p1:2", "p2:1");

    client.registerPolicy((v, reqs) -> List.of());
    assertThatThrownBy(() -> client.selectPaymentRequirements(2, List.of(a, b)))
        .hasMessage("All payment requirements were filtered out by policies for x402 version: 2");
  }

  @Test
  void aCustomSelectorChoosesAmongTheSurvivors() {
    X402Client client = new X402Client((v, reqs) -> reqs.get(reqs.size() - 1))
        .register(PREPROD, new FakeClientScheme());
    PaymentRequirements a = req("exact", PREPROD, "1");
    PaymentRequirements b = req("exact", PREPROD, "2");
    assertThat(client.selectPaymentRequirements(2, List.of(a, b))).isEqualTo(b);
  }

  @Test
  void preferNetworkMakesTheFirstEntryMostPreferred() {
    PaymentRequirements pre = req("exact", PREPROD, "1");
    PaymentRequirements main = req("exact", MAINNET, "1");
    PaymentRequirements prev = req("exact", "cardano:preview", "1");
    List<PaymentRequirements> all = List.of(pre, prev, main);
    assertThat(PaymentPolicies.preferNetwork(MAINNET, PREPROD).apply(2, all))
        .containsExactly(main, pre, prev);
    assertThat(PaymentPolicies.preferNetwork().apply(2, all)).isEqualTo(all);

    X402Client client = client();
    client.registerPolicy(PaymentPolicies.preferNetwork(MAINNET));
    assertThat(client.selectPaymentRequirements(2, List.of(pre, main))).isEqualTo(main);
  }

  @Test
  void preferSchemeIsAStablePartition() {
    PaymentRequirements exact1 = req("exact", PREPROD, "1");
    PaymentRequirements upto = req("upto", PREPROD, "1");
    PaymentRequirements exact2 = req("exact", PREPROD, "2");
    PaymentRequirements other = req("other", PREPROD, "2");
    assertThat(PaymentPolicies.preferScheme("upto", "other").apply(2,
        List.of(exact1, upto, other, exact2))).containsExactly(upto, other, exact1, exact2);
  }

  @Test
  void maxAmountFiltersOnlyItsAsset() {
    PaymentRequirements cheap = req("exact", PREPROD, "100");
    PaymentRequirements pricey = req("exact", PREPROD, "101");
    PaymentRequirements lovelace = new PaymentRequirements("exact", PREPROD, "lovelace",
        "9999999", "p", 300, null);
    assertThat(PaymentPolicies.maxAmount(Fixtures.USDM, "100").apply(2,
        List.of(pricey, cheap, lovelace))).containsExactly(cheap, lovelace);
  }

  @Test
  void createdPayloadsCarryResourceAcceptedMergedExtensionsAndTheSpendCap() {
    FakeClientScheme scheme = new FakeClientScheme();
    scheme.extensions = map("bazaar", map("client", 1, "info", map("x", 2)), "own", true);
    X402Client client = new X402Client().register(PREPROD, scheme);
    PaymentRequirements r = req("exact", PREPROD, "10000");
    PaymentRequired required = new PaymentRequired(2, null, ResourceInfo.of("https://x"),
        List.of(r), map("bazaar", map("server", 1, "info", map("x", 1, "y", 1))));
    PaymentPayload payload = client.createPaymentPayload(required);
    assertThat(payload.x402Version()).isEqualTo(2);
    assertThat(payload.accepted()).isEqualTo(r);
    assertThat(payload.resource()).isEqualTo(ResourceInfo.of("https://x"));
    assertThat(payload.payload()).containsEntry("signed", "10000");
    // server value wins on scalar conflicts; client adds new keys
    assertThat(payload.extensions()).isEqualTo(map("bazaar",
        map("server", 1, "info", map("x", 1, "y", 1), "client", 1), "own", true));
    assertThat(scheme.contexts.get(0).maxAmountPerPayment()).isEqualTo("1000000");
    assertThat(scheme.contexts.get(0).extensions()).isEqualTo(required.extensions());
  }

  @Test
  void schemeExtensionsAloneOrServerExtensionsAloneAreKept() {
    FakeClientScheme scheme = new FakeClientScheme();
    X402Client client = new X402Client().register(PREPROD, scheme);
    client.setSpendControls(SpendControls.disabled());
    PaymentRequirements r = req("exact", PREPROD, "1");
    assertThat(client.createPaymentPayload(new PaymentRequired(2, null, null, List.of(r),
        map("s", 1))).extensions()).isEqualTo(map("s", 1));
    scheme.extensions = map("c", 1);
    assertThat(client.createPaymentPayload(new PaymentRequired(2, null, null, List.of(r), null))
        .extensions()).isEqualTo(map("c", 1));
    assertThat(scheme.contexts.get(0).maxAmountPerPayment()).isNull();
  }
}
