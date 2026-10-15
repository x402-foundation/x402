package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;
import static org.x402.http.HttpTestSupport.core;
import static org.x402.http.HttpTestSupport.http;
import static org.x402.http.HttpTestSupport.option;
import static org.x402.http.HttpTestSupport.pay;
import static org.x402.http.HttpTestSupport.routes;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.types.PaymentPayload;

/**
 * On a paid request, every 402 built for it hands the paid payload to scheme
 * enrichment (the same payload the {@code PAYMENT-SIGNATURE} header carries), so a quote issuer
 * can re-serve the quote the payment names.
 */
class PaidPathEnrichmentTest {

  @Test
  void schemeEnrichmentSeesThePaidPayloadOnThePaidPathOnly() {
    FakeServerScheme scheme = new FakeServerScheme();
    List<PaymentPayload> seen = new ArrayList<>();
    scheme.enrich402 = ctx -> {
      seen.add(ctx.paymentPayload());
      return null;
    };
    FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));
    X402HttpResourceServer http = http(core(scheme, f), routes("/r", RouteConfig.builder()
        .accepts(List.of(option("$1").build())).build()));
    http.initialize();

    PaymentPayload payload = pay(http, "/r", 0);
    assertThat(seen).containsExactly((PaymentPayload) null);

    http.processHttpRequest(TestAdapter.get("/r").paying(payload).context());
    assertThat(seen).hasSize(2).last().isEqualTo(payload);

    PaymentPayload unmatched = new PaymentPayload(2, null, payload.accepted().withAmount("1"),
        payload.payload(), null);
    http.processHttpRequest(TestAdapter.get("/r").paying(unmatched).context());
    assertThat(seen).hasSize(4);
    assertThat(seen.subList(2, 4)).containsOnly(unmatched);
  }
}
