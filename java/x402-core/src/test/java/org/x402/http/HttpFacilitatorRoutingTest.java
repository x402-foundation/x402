package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;
import static org.x402.http.HttpTestSupport.core;
import static org.x402.http.HttpTestSupport.http;
import static org.x402.http.HttpTestSupport.option;
import static org.x402.http.HttpTestSupport.pay;
import static org.x402.http.HttpTestSupport.paymentRequired;
import static org.x402.http.HttpTestSupport.routes;
import static org.x402.http.HttpTestSupport.verified;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorStatusException;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.Fixtures;
import org.x402.core.server.FacilitatorRoute;
import org.x402.core.types.PaymentPayload;

/**
 * Facilitator routing through the HTTP flow: {@code RouteConfig.failover} and {@code
 * PaymentOption.facilitator} pick the route; {@code PaymentVerified} carries {@code verifiedBy};
 * settle and its pending retry go to that facilitator.
 */
class HttpFacilitatorRoutingTest {

  private static final Map<String, Object> SAME = map("feePayer", "same");

  private final FakeFacilitatorClient a = new FakeFacilitatorClient("A",
      supported(kind(PREPROD, SAME)));
  private final FakeFacilitatorClient b = new FakeFacilitatorClient("B",
      supported(kind(PREPROD, SAME)));

  private X402HttpResourceServer server(RouteConfig config) {
    X402HttpResourceServer http = http(core(a, b), routes("/r", config));
    http.initialize();
    return http;
  }

  private HttpProcessResult.PaymentVerified verify(X402HttpResourceServer http, int option) {
    PaymentPayload payload = pay(http, "/r", option);
    return verified(http.processHttpRequest(TestAdapter.get("/r").paying(payload).context()));
  }

  private static HttpTransportContext transport() {
    return new HttpTransportContext(TestAdapter.get("/r").context(), null, null);
  }

  @Test
  void failoverRoutesVerifyToTheBackupAndSettleFollowsWithItsPendingRetry() {
    a.verifyAlways((p, r) -> {
      throw new FacilitatorStatusException("Facilitator verify failed (503): busy", 503);
    });
    b.thenSettle((p, r) -> Fixtures.pending(PREPROD, "tx1"));
    X402HttpResourceServer http = server(RouteConfig.builder().failover(true)
        .accepts(List.of(option("$0.01").build())).build());
    HttpProcessResult.PaymentVerified v = verify(http, 0);
    assertThat(v.verifiedBy()).isEqualTo("B");
    assertThat(v.routing().route()).isEqualTo(FacilitatorRoute.autoWithVerifyFailover());
    assertThat(v.routing().verifiedBy()).isEqualTo("B");

    ProcessSettleResult settled = http.processSettlement(v, transport());
    assertThat(settled).isInstanceOf(ProcessSettleResult.Success.class);
    assertThat(b.settleCalls).hasValue(2);
    assertThat(a.settleCalls).hasValue(0);
  }

  @Test
  void withoutFailoverA503IsA402() {
    a.verifyAlways((p, r) -> {
      throw new FacilitatorStatusException("Facilitator verify failed (503): busy", 503);
    });
    X402HttpResourceServer http = server(RouteConfig.builder()
        .accepts(List.of(option("$0.01").build())).build());
    PaymentPayload payload = pay(http, "/r", 0);
    assertThat(paymentRequired(http.processHttpRequest(TestAdapter.get("/r").paying(payload)
        .context())).error()).isEqualTo("Facilitator verify failed (503): busy");
    assertThat(b.verifyCalls).hasValue(0);
  }

  @Test
  void aPinnedOptionVerifiesAndSettlesOnlyAtItsFacilitator() {
    X402HttpResourceServer http = server(RouteConfig.builder().failover(true).accepts(List.of(
        option("$0.01").build(),
        option("$0.02").facilitator("B").build())).build());
    HttpProcessResult.PaymentVerified pinned = verify(http, 1);
    assertThat(pinned.verifiedBy()).isEqualTo("B");
    assertThat(pinned.routing().route()).isEqualTo(FacilitatorRoute.pinned("B"));
    http.processSettlement(pinned, transport());
    assertThat(b.verifyCalls).hasValue(1);
    assertThat(b.settleCalls).hasValue(1);
    assertThat(a.calls()).isZero();

    HttpProcessResult.PaymentVerified unpinned = verify(http, 0);
    assertThat(unpinned.verifiedBy()).isEqualTo("A");
    http.processSettlement(unpinned, transport());
    assertThat(a.settleCalls).hasValue(1);
  }

  @Test
  void theSettleTargetSurvivesAReSync() {
    X402HttpResourceServer http = server(RouteConfig.builder()
        .accepts(List.of(option("$0.01").build())).build());
    HttpProcessResult.PaymentVerified v = verify(http, 0);
    a.supported(() -> supported(kind("eip155:1")));
    http.initialize();
    assertThat(http.state().snapshot().owner(2, PREPROD, "exact")).isEqualTo("B");
    http.processSettlement(v, transport());
    assertThat(a.settleCalls).hasValue(1);
    assertThat(b.settleCalls).hasValue(0);
  }
}
