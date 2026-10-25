package org.x402.spring.web.reactive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.client.reactive.X402ClientHttpConnector;
import org.x402.spring.client.reactive.X402ExchangeFilterFunction;
import reactor.core.publisher.Mono;

import static org.x402.spring.client.TransportRedirects.Safety.SAFE;

/** Edge paths of the reactive adapter and the WebClient filter. */
class ReactiveEdgeTest {

  private static final URI URL = URI.create("https://api.example.com/x");
  private final TestClientScheme scheme = new TestClientScheme();
  private final X402ExchangeFilterFunction filter = new X402ExchangeFilterFunction(
      new X402Client().register(HookRecorder.NET, scheme),
      HostPolicy.of(List.of("api.example.com")), 1024).forTransport(SAFE);

  private static String required(String resource) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(resource), List.of(new PaymentRequirements("exact", HookRecorder.NET,
            "USDM", "10000", "addr", 300, Map.of())), null));
  }

  private static ClientResponse status(HttpStatus status, String... headers) {
    ClientResponse.Builder b = ClientResponse.create(status);
    for (int i = 0; i < headers.length; i += 2) {
      b.header(headers[i], headers[i + 1]);
    }
    return b.build();
  }

  @Test
  void pathsStripMatrixParametersAndDecode() {
    MockServerHttpRequest request = MockServerHttpRequest.method(HttpMethod.GET,
        URI.create("/report/q1;jsessionid=a/a%20b"))
        .build();
    String[] paths = X402WebFilter.paths(request);
    assertThat(paths[0]).isEqualTo("/report/q1/a%20b");
    assertThat(paths[1]).isEqualTo("/report/q1/a b");
    assertThat(X402WebFilter.paths(MockServerHttpRequest.get("").build())[0]).isEqualTo("/");
  }

  @Test
  void adapterExposesTheRequestAndHidesTheUserAgentWhenThePaywallIsOff() {
    MockServerHttpRequest request = MockServerHttpRequest.get("https://api.example.com/w?x=1")
        .header("User-Agent", "Mozilla/5.0").build();
    ReactiveRequestAdapter on = new ReactiveRequestAdapter(request, "/w", "w", "/w", true);
    ReactiveRequestAdapter off = new ReactiveRequestAdapter(request, "/w", "w", null, false);
    assertThat(on.getUrl()).isEqualTo("https://api.example.com/w?x=1");
    assertThat(on.getUserAgent()).isEqualTo("Mozilla/5.0");
    assertThat(off.getUserAgent()).isEmpty();
    assertThat(on.getMethod()).isEqualTo("GET");
    assertThat(on.getPath()).isEqualTo("/w");
    assertThat(on.getHeader("user-agent")).isEqualTo("Mozilla/5.0");
    assertThat(on.selectedOffer()).isEqualTo("w");
    assertThat(on.selectedPattern()).isEqualTo("/w");
  }

  @Test
  void aThrowingOrAbsentHandlerMappingMeansNoHandler() {
    MockServerWebExchange exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/x"));
    HandlerMapping throwing = e -> Mono.error(new IllegalStateException("415"));
    assertThat(new ReactiveHandlerResolver(() -> List.of(throwing)).resolve(exchange).block())
        .isEqualTo(ReactiveHandlerResolver.NONE);
    assertThat(new ReactiveHandlerResolver(() -> null).resolve(exchange).block())
        .isEqualTo(ReactiveHandlerResolver.NONE);
    HandlerMapping writing = e -> {
      e.getAttributes().put("leak", "x");
      e.getResponse().getHeaders().set("Vary", "Origin");
      return Mono.just("handler");
    };
    assertThat(new ReactiveHandlerResolver(() -> List.of(writing)).resolve(exchange).block()
        .handler()).isEqualTo("handler");
    assertThat(exchange.getAttributes()).doesNotContainKey("leak");
    assertThat(exchange.getResponse().getHeaders().containsKey("Vary")).isFalse();
  }

  @Test
  void webClientFilterPassesNon402sAndUnusable402sThrough() {
    ClientRequest request = ClientRequest.create(HttpMethod.GET, URL).build();
    assertThat(filter.filter(request, r -> Mono.just(status(HttpStatus.OK))).block()
        .statusCode().value()).isEqualTo(200);
    assertThat(filter.filter(request, r -> Mono.just(status(HttpStatus.PAYMENT_REQUIRED)))
        .block().statusCode().value()).isEqualTo(402);
    assertThat(filter.filter(request, r -> Mono.just(status(HttpStatus.PAYMENT_REQUIRED,
        X402Headers.PAYMENT_REQUIRED, required("not a uri")))).block().statusCode().value())
        .isEqualTo(402);
    assertThat(scheme.signed).isEmpty();
  }

  @Test
  void webClientFilterRefusesMalformedOrRepeatedPayments() {
    ClientRequest request = ClientRequest.create(HttpMethod.GET, URL).build();
    assertThatThrownBy(() -> filter.filter(request, r -> Mono.just(status(
        HttpStatus.PAYMENT_REQUIRED, X402Headers.PAYMENT_REQUIRED, "%%"))).block())
        .isInstanceOf(X402ClientException.class);
    ClientRequest paid = ClientRequest.create(HttpMethod.GET, URL)
        .header(X402Headers.PAYMENT_SIGNATURE, "x").build();
    assertThatThrownBy(() -> filter.filter(paid, r -> Mono.just(status(
        HttpStatus.PAYMENT_REQUIRED, X402Headers.PAYMENT_REQUIRED, required(URL.toString()))))
        .block()).isInstanceOf(X402ClientException.class).hasMessageContaining("already");
  }

  @Test
  void webClientFilterRecoversOnceThroughThePaymentResponseHook() {
    X402Client client = new X402Client().register(HookRecorder.NET, scheme);
    List<Boolean> calls = new ArrayList<>();
    client.onPaymentResponse(ctx -> {
      calls.add(ctx.paymentRequired() != null);
      return calls.size() == 1;
    });
    X402ExchangeFilterFunction recovering = new X402ExchangeFilterFunction(client,
        HostPolicy.of(List.of("api.example.com")), 1024).forTransport(SAFE);
    ClientRequest request = ClientRequest.create(HttpMethod.GET, URL).build();
    List<Boolean> paidFlags = new ArrayList<>();
    ClientResponse last = recovering.filter(request, r -> {
      boolean paid = r.headers().containsKey(X402Headers.PAYMENT_SIGNATURE);
      paidFlags.add(paid);
      return Mono.just(paidFlags.size() == 2
          ? status(HttpStatus.PAYMENT_REQUIRED, X402Headers.PAYMENT_REQUIRED,
              required(URL.toString()))
          : paid ? status(HttpStatus.OK, X402Headers.PAYMENT_RESPONSE, "%%")
          : status(HttpStatus.PAYMENT_REQUIRED, X402Headers.PAYMENT_REQUIRED,
              required(URL.toString())));
    }).block();
    assertThat(paidFlags).containsExactly(false, true, true);
    assertThat(calls).containsExactly(true, false);
    assertThat(last.statusCode().value()).isEqualTo(200);
    assertThat(scheme.signed).hasSize(2);
  }

  @Test
  void theDualConnectorExposesBothConnectors() {
    X402ClientHttpConnector connector = new X402ClientHttpConnector(
        (m, u, cb) -> Mono.empty(), (m, u, cb) -> Mono.empty());
    assertThat(connector.delegate()).isNotSameAs(connector.paid());
    assertThat(connector.connect(HttpMethod.GET, URL, r -> Mono.empty()).block()).isNull();
  }
}
