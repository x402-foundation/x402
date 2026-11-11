package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.core.SchemeNetworkServer;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;

/** Shared helpers for the HTTP-layer tests. */
final class HttpTestSupport {

  private HttpTestSupport() {}

  static X402ResourceServer core(SchemeNetworkServer scheme, FakeFacilitatorClient... clients) {
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(clients)).build();
    server.register(Fixtures.PREPROD, scheme);
    server.register(Fixtures.MAINNET, scheme);
    return server;
  }

  static X402ResourceServer core(FakeFacilitatorClient... clients) {
    return core(new FakeServerScheme(), clients);
  }

  static PaymentOption.Builder option(String price) {
    return PaymentOption.builder().scheme("exact").network(Fixtures.PREPROD)
        .payTo(Fixtures.PAY_TO).price(price);
  }

  static Map<String, RouteConfig> routes(Object... kv) {
    Map<String, RouteConfig> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      m.put((String) kv[i], (RouteConfig) kv[i + 1]);
    }
    return m;
  }

  static X402HttpResourceServer http(X402ResourceServer core, Map<String, RouteConfig> routes) {
    return new X402HttpResourceServer(core, new PatternRouteResolver(routes));
  }

  static HttpProcessResult.PaymentError error(HttpProcessResult result) {
    assertThat(result).isInstanceOf(HttpProcessResult.PaymentError.class);
    return (HttpProcessResult.PaymentError) result;
  }

  static HttpProcessResult.PaymentVerified verified(HttpProcessResult result) {
    assertThat(result).isInstanceOf(HttpProcessResult.PaymentVerified.class);
    return (HttpProcessResult.PaymentVerified) result;
  }

  static PaymentRequired paymentRequired(HttpProcessResult result) {
    return HeaderCodec.decodePaymentRequired(
        error(result).headers().get(X402Headers.PAYMENT_REQUIRED));
  }

  /** Pays the {@code index}-th advertised option of a fresh unpaid 402 for {@code path}. */
  static PaymentPayload pay(X402HttpResourceServer http, String path, int index) {
    PaymentRequired required = paymentRequired(
        http.processHttpRequest(TestAdapter.get(path).context()));
    PaymentRequirements accepted = required.accepts().get(index);
    return new PaymentPayload(2, ResourceInfo.of("https://api.example.com" + path), accepted,
        Map.of("signature", "sig"), null);
  }
}
