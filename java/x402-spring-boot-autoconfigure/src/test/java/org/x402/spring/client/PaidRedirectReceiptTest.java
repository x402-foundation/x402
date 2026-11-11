package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.client.reactive.MockClientHttpRequest;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.client.reactive.X402ExchangeFilterFunction;
import reactor.core.publisher.Mono;

/**
 * A paid redirect that already settled the payment (it carries PAYMENT-RESPONSE) is returned with
 * its receipt, never re-sent; and the caller's own request customiser runs once per request.
 */
class PaidRedirectReceiptTest {

  private static final String HTTP = "http://api.example.com/x";
  private static final String HTTPS = "https://api.example.com/x";
  private static final HostPolicy HOSTS = HostPolicy.of(List.of("api.example.com"));

  private final X402Client client =
      new X402Client().register(HookRecorder.NET, new TestClientScheme());

  private static String required() {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(HTTPS), List.of(new PaymentRequirements("exact", HookRecorder.NET,
            "USDM", "10000", "addr", 300, Map.of())), null));
  }

  @Test
  void aRedirectCarryingAReceiptIsNotAReSendTarget() {
    HttpHeaders settled = new HttpHeaders();
    settled.set(HttpHeaders.LOCATION, HTTPS);
    settled.set(X402Headers.PAYMENT_RESPONSE, "e30=");
    assertThat(TransportRedirects.paidRedirectTarget(URI.create(HTTP), 301, settled, HOSTS))
        .isNull();

    HttpHeaders plain = new HttpHeaders();
    plain.set(HttpHeaders.LOCATION, HTTPS);
    assertThat(TransportRedirects.paidRedirectTarget(URI.create(HTTP), 301, plain, HOSTS))
        .isEqualTo(URI.create(HTTPS));
  }

  @Test
  void theReactiveClientReturnsTheSettledRedirectWithItsReceipt() {
    List<String> seen = new ArrayList<>();
    ExchangeFunction transport = request -> {
      boolean signed = request.headers().containsKey(X402Headers.PAYMENT_SIGNATURE);
      seen.add(request.url() + "|" + signed);
      if (!signed) {
        return Mono.just(ClientResponse.create(HttpStatus.PAYMENT_REQUIRED)
            .header(X402Headers.PAYMENT_REQUIRED, required()).build());
      }
      return Mono.just(ClientResponse.create(HttpStatus.MOVED_PERMANENTLY)
          .header(HttpHeaders.LOCATION, HTTPS).header(X402Headers.PAYMENT_RESPONSE, "e30=")
          .build());
    };
    X402ExchangeFilterFunction filter = new X402ExchangeFilterFunction(client, HOSTS, 1024)
        .forTransport(TransportRedirects.Safety.SAFE);

    ClientResponse response = filter.filter(
        ClientRequest.create(HttpMethod.GET, URI.create(HTTP)).build(), transport).block();

    assertThat(response.statusCode().value()).isEqualTo(301);
    assertThat(response.headers().asHttpHeaders().getFirst(X402Headers.PAYMENT_RESPONSE))
        .isEqualTo("e30=");
    assertThat(seen).containsExactly(HTTP + "|false", HTTP + "|true");
  }

  @Test
  void theCallersRequestCustomiserRunsOncePerRequest() {
    AtomicInteger runs = new AtomicInteger();
    List<Integer> perRequest = new ArrayList<>();
    ExchangeFunction transport = request -> {
      int before = runs.get();
      request.httpRequest().accept(new MockClientHttpRequest(request.method(), request.url()));
      perRequest.add(runs.get() - before);
      boolean signed = request.headers().containsKey(X402Headers.PAYMENT_SIGNATURE);
      return Mono.just(signed ? ClientResponse.create(HttpStatus.OK).build()
          : ClientResponse.create(HttpStatus.PAYMENT_REQUIRED)
              .header(X402Headers.PAYMENT_REQUIRED, required()).build());
    };
    X402ExchangeFilterFunction filter = new X402ExchangeFilterFunction(client, HOSTS, 1024)
        .forTransport(TransportRedirects.Safety.SAFE);

    filter.filter(ClientRequest.create(HttpMethod.GET, URI.create(HTTPS))
        .httpRequest(r -> runs.incrementAndGet()).build(), transport).block();

    assertThat(perRequest).containsExactly(1, 1);
  }
}
