package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.servlet.TestServers.route;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.ServletRequestWrapper;
import jakarta.servlet.ServletResponseWrapper;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.http.RouteConfig;
import org.x402.http.X402HttpResourceServer;

/** The filter's pass-through and error branches, without a container. */
class PaymentFilterUnitTest {

  private final FakeFacilitatorClient facilitator =
      new FakeFacilitatorClient("f", Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));

  private X402HttpResourceServer http() {
    Map<String, RouteConfig> routes = new LinkedHashMap<>();
    routes.put("/weather", route("$0.01"));
    return TestServers.http(new FakeServerScheme(), facilitator, routes,
        new CopyOnWriteArrayList<>());
  }

  private static MockHttpServletRequest get(String method, String path) {
    MockHttpServletRequest request = new MockHttpServletRequest(method, path);
    request.setServletPath(path);
    return request;
  }

  private static boolean passedThrough(PaymentFilter filter, MockHttpServletRequest request)
      throws Exception {
    MockFilterChain chain = new MockFilterChain();
    filter.doFilter(request, new MockHttpServletResponse(), chain);
    return chain.getRequest() != null;
  }

  @Test
  void requestsTheFilterMustNotChargePassThrough() throws Exception {
    PaymentFilter filter = new PaymentFilter(http(), null, false);
    filter.init(null);

    MockFilterChain nonHttp = new MockFilterChain();
    filter.doFilter(new ServletRequestWrapper(get("GET", "/weather")),
        new ServletResponseWrapper(new MockHttpServletResponse()), nonHttp);
    assertThat(nonHttp.getRequest()).isNotNull();

    MockHttpServletRequest include = get("GET", "/weather");
    include.setDispatcherType(DispatcherType.INCLUDE);
    assertThat(passedThrough(filter, include)).isTrue();

    MockHttpServletRequest charged = get("GET", "/weather");
    charged.setAttribute(PaymentFilter.PAYMENT_ATTRIBUTE, "verified");
    assertThat(passedThrough(filter, charged)).isTrue();

    MockHttpServletRequest preflight = get("OPTIONS", "/weather");
    preflight.addHeader("Origin", "https://shop.example");
    preflight.addHeader("Access-Control-Request-Method", "GET");
    assertThat(passedThrough(filter, preflight)).isTrue();

    // Not a preflight: OPTIONS on a route without a verb is free anyway (TS #3738).
    MockHttpServletRequest noMethodHeader = get("OPTIONS", "/weather");
    noMethodHeader.addHeader("Origin", "https://shop.example");
    assertThat(passedThrough(filter, noMethodHeader)).isTrue();
    assertThat(passedThrough(filter, get("OPTIONS", "/weather"))).isTrue();

    assertThat(passedThrough(filter, get("GET", "/free"))).isTrue();
    assertThat(passedThrough(filter, get("GET", "/weather"))).isFalse();
    filter.destroy();
  }

  @Test
  void aRouterThatStripsSemicolonsButKeepsDotSegmentsIsCharged() throws Exception {
    Map<String, RouteConfig> routes = new LinkedHashMap<>();
    routes.put("GET /reports/*", route("$0.50"));
    PaymentFilter filter = new PaymentFilter(TestServers.http(new FakeServerScheme(),
        facilitator, routes, new CopyOnWriteArrayList<>()), null, false);
    filter.init(null);
    // A router on the raw URI with ';' stripped and dots kept (Spring PathPattern) reaches
    // /reports/** here; the container's own path is /x.
    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/reports;/../x");
    request.setServletPath("/x");
    MockHttpServletResponse response = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();
    filter.doFilter(request, response, chain);
    assertThat(response.getStatus()).isEqualTo(402);
    assertThat(chain.getRequest()).isNull();
    filter.destroy();
  }

  @Test
  void aSessionIdOnTheLastSegmentSelectsTheSpecificRouteNotA400() throws Exception {
    Map<String, RouteConfig> routes = new LinkedHashMap<>();
    routes.put("GET /api/premium", route("$0.90"));
    routes.put("GET /api/*", route("$0.01"));
    PaymentFilter filter = new PaymentFilter(TestServers.http(new FakeServerScheme(),
        facilitator, routes, new CopyOnWriteArrayList<>()), null, false);
    filter.init(null);
    MockHttpServletRequest request = new MockHttpServletRequest("GET",
        "/api/premium;jsessionid=X");
    request.setServletPath("/api/premium");
    MockHttpServletResponse response = new MockHttpServletResponse();
    filter.doFilter(request, response, new MockFilterChain());
    assertThat(response.getStatus()).isEqualTo(402);
    assertThat(org.x402.http.HeaderCodec.decodePaymentRequired(
        response.getHeader("PAYMENT-REQUIRED")).accepts().get(0).amount())
        .isEqualTo(org.x402.http.HeaderCodec.decodePaymentRequired(
            unpaid(filter, "/api/premium").getHeader("PAYMENT-REQUIRED")).accepts().get(0)
            .amount());
    filter.destroy();
  }

  private static MockHttpServletResponse unpaid(PaymentFilter filter, String path)
      throws Exception {
    MockHttpServletRequest request = new MockHttpServletRequest("GET", path);
    request.setServletPath(path);
    MockHttpServletResponse response = new MockHttpServletResponse();
    filter.doFilter(request, response, new MockFilterChain());
    return response;
  }

  @Test
  void aServerNobodySyncedAnswers500() throws Exception {
    PaymentFilter filter = new PaymentFilter(http(), null, false);
    MockHttpServletResponse response = new MockHttpServletResponse();
    filter.doFilter(get("GET", "/weather"), response, new MockFilterChain());
    assertThat(response.getStatus()).isEqualTo(500);
    assertThat(response.getContentAsString()).contains("Internal Server Error");
  }

  @Test
  void aFacilitatorTransportFailureDuringVerifyAnswers502() throws Exception {
    X402HttpResourceServer http = http();
    PaymentFilter filter = new PaymentFilter(http, null, false);
    filter.init(null);
    MockHttpServletResponse unpaid = new MockHttpServletResponse();
    filter.doFilter(get("GET", "/weather"), unpaid, new MockFilterChain());
    assertThat(unpaid.getStatus()).isEqualTo(402);

    facilitator.verifyAlways((p, r) -> {
      throw new FacilitatorResponseException("facilitator unreachable", 0, null);
    });
    MockHttpServletRequest paid = get("GET", "/weather");
    paid.addHeader("PAYMENT-SIGNATURE", TestServers.paymentFor(
        new RawHttp.Response(402, "HTTP/1.1 402\r\nPAYMENT-REQUIRED: "
            + unpaid.getHeader("PAYMENT-REQUIRED") + "\r\n\r\n"))
        .substring("PAYMENT-SIGNATURE: ".length()));
    MockHttpServletResponse response = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();
    filter.doFilter(paid, response, chain);
    assertThat(response.getStatus()).isEqualTo(502);
    assertThat(chain.getRequest()).isNull();
    filter.destroy();
  }
}
