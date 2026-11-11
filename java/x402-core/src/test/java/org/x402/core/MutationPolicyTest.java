package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.x402.core.SchemeNetworkServer.PaymentRequiredContext;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.core.utils.JsonValues;

/** What scheme enrichment may change, and the JSON comparisons used. */
class MutationPolicyTest {

  private final FakeServerScheme scheme = new FakeServerScheme();
  private final FakeFacilitatorClient f =
      new FakeFacilitatorClient("f", supported(kind(PREPROD), kind(MAINNET)));
  private final X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
  private final PaymentRequirements preprod =
      Fixtures.requirements(PREPROD, "1").withExtra(map("k", 1, "assetTransferMethod", "x"));
  private final PaymentRequirements mainnet = Fixtures.requirements(MAINNET, "1");

  MutationPolicyTest() {
    server.register(PREPROD, scheme);
    server.initialize();
  }

  private void enrich(Function<PaymentRequiredContext, List<PaymentRequirements>> f) {
    scheme.enrich402 = f;
    server.createPaymentRequiredResponse(List.of(preprod, mainnet), ResourceInfo.of("u"), null,
        null, null, null);
  }

  private static List<PaymentRequirements> replace(PaymentRequiredContext c, int i,
      PaymentRequirements r) {
    List<PaymentRequirements> out = new ArrayList<>(c.requirements());
    out.set(i, r);
    return out;
  }

  @Test
  void schemeEnrichmentPolicyViolationsUseTsMessages() {
    String prefix = "[x402] scheme \"exact\" violated accepts mutation policy: ";
    assertThatThrownBy(() -> enrich(c -> List.of(preprod)))
        .hasMessage(prefix + "accepts length changed (2 → 1)");
    assertThatThrownBy(() -> enrich(c -> replace(c, 0,
        new PaymentRequirements("upto", PREPROD, "USDM", "1", Fixtures.PAY_TO, 300, null))))
        .hasMessage(prefix + "scheme/network are immutable (index 0)");
    assertThatThrownBy(() -> enrich(c -> replace(c, 0, preprod.withExtra(map("k", 1)))))
        .hasMessage(prefix + "extra[\"assetTransferMethod\"] was removed (index 0)");
    assertThatThrownBy(() -> enrich(c -> replace(c, 0,
        preprod.withExtra(map("k", 2, "assetTransferMethod", "x")))))
        .hasMessage(prefix + "extra[\"k\"] may not be changed (index 0)");
    assertThatThrownBy(() -> enrich(c -> replace(c, 1, mainnet.withExtra("new", 1))))
        .hasMessage(prefix + "only matching accepts may receive new extra fields (index 1)");
    assertThatThrownBy(() -> enrich(c -> replace(c, 0, preprod.withExtra("paymentFlow", "x"))))
        .hasMessage(prefix + "extra[\"paymentFlow\"] is protocol-reserved and immutable during "
            + "enrichment (index 0)");
    enrich(c -> replace(c, 0, preprod.withExtra("quote", map("n", 1))));
  }

  @Test
  void settlementResponseEnrichmentMergesNestedObjects() {
    f.settleAlways((p, r) -> new SettleResponse(true, null, null, null, "tx", PREPROD, null,
        null, null, map("receipt", map("id", 1))));
    scheme.enrichResponse = c -> map("receipt", map("url", "u"), "more", 2);
    SettleResponse result = server.settlePayment(Fixtures.payload(preprod), preprod, null, null,
        null, SettlePhase.AFTER_HANDLER);
    assertThat(result.extra()).isEqualTo(map("receipt", map("id", 1, "url", "u"), "more", 2));

    scheme.enrichResponse = c -> map("receipt", map("id", 2));
    assertThat(server.settlePayment(Fixtures.payload(preprod), preprod, null, null, null,
        SettlePhase.AFTER_HANDLER).extra()).isEqualTo(map("receipt", map("id", 1)));
  }

  @Test
  void deepEqualIgnoresKeyOrderAndNumberRepresentation() {
    assertThat(JsonValues.deepEqual(map("a", 1, "b", List.of(1, 2.0)),
        map("b", List.of(1.0, 2), "a", 1L))).isTrue();
    assertThat(JsonValues.deepEqual(null, null)).isTrue();
    assertThat(JsonValues.deepEqual("1", 1)).isFalse();
    assertThat(JsonValues.deepEqual(List.of(1, 2), List.of(2, 1))).isFalse();
    assertThat(JsonValues.deepEqual(new Fixture("x"), map("name", "x"))).isTrue();
    assertThat(JsonValues.toNode(JsonValues.toNode("x"))).isEqualTo(JsonValues.toNode("x"));
  }

  @Test
  void subsetsAllowExtraObjectKeysOnly() {
    assertThat(JsonValues.containsSubset(map("a", map("b", 1)), map("a", map("b", 1, "c", 2))))
        .isTrue();
    assertThat(JsonValues.containsSubset(map("a", 1), map("b", 1))).isFalse();
    assertThat(JsonValues.containsSubset(map("a", 1), List.of())).isFalse();
    assertThat(JsonValues.containsSubset(List.of(1), List.of(1, 2))).isFalse();
    assertThat(JsonValues.containsSubset(map(), map("x", 1))).isTrue();
    assertThat(JsonValues.omit(null, List.of("a"))).isNull();
    Map<String, Object> m = map("a", 1);
    assertThat(JsonValues.omit(m, List.of())).isSameAs(m);
    assertThat(JsonValues.isRecord(m)).isTrue();
    assertThat(JsonValues.isRecord("m")).isFalse();
    assertThat(JsonValues.toPlain(JsonValues.toNode(m))).isEqualTo(m);
  }

  record Fixture(String name) {}
}
