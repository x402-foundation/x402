package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpRequest;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactoryDecorator;

/**
 * The blocking client buffers a request body only when it may have to re-send it with payment:
 * never for hosts outside {@code x402.client.hosts}, and never beyond {@code max-replay-body}.
 */
class ClientBufferingTest {

  private static final HostPolicy HOSTS = HostPolicy.of(List.of("api.example.com"));

  private final TestClientScheme scheme = new TestClientScheme();
  private final X402Client client = new X402Client().register(HookRecorder.NET, scheme);
  private final List<MockClientHttpRequest> created = new ArrayList<>();

  private static String required(String resource) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(resource), List.of(new PaymentRequirements("exact", HookRecorder.NET,
            "USDM", "10000", "addr", 300, Map.of())), null));
  }

  /** A transport that answers every request with a 402 offer for {@code uri}. */
  private ClientHttpRequestFactory paywalled() {
    return (uri, method) -> {
      MockClientHttpRequest request = new MockClientHttpRequest(method, uri) {
        @Override
        protected ClientHttpResponse executeInternal() {
          return new X402ClientStarterTest.RecordingResponse(HttpStatus.PAYMENT_REQUIRED,
              Map.of(X402Headers.PAYMENT_REQUIRED, required(uri.toString())), () -> { });
        }
      };
      created.add(request);
      return request;
    };
  }

  private static ClientHttpResponse post(ClientHttpRequestFactory factory, URI uri, byte[] body)
      throws IOException {
    ClientHttpRequest request = factory.createRequest(uri, HttpMethod.POST);
    request.getBody().write(body);
    return request.execute();
  }

  @Test
  void requestsToOtherHostsGoStraightToTheTransport() throws IOException {
    ClientHttpRequestFactory transport = paywalled();
    ClientHttpRequestFactory paying =
        new X402ClientHttpRequestFactoryDecorator(client, HOSTS).decorate(transport, transport);

    ClientHttpRequest request = paying.createRequest(URI.create("https://other.example.org/x"),
        HttpMethod.POST);

    assertThat(created).hasSize(1);
    assertThat(request).isSameAs(created.get(0));
  }

  @Test
  void webClientRequestsToOtherHostsAreNotRecorded() {
    var filter = new org.x402.spring.client.reactive.X402ExchangeFilterFunction(client, HOSTS, 1024);
    var request = org.springframework.web.reactive.function.client.ClientRequest
        .create(HttpMethod.POST, URI.create("https://other.example.org/x")).build();
    List<org.springframework.web.reactive.function.client.ClientRequest> sent = new ArrayList<>();

    filter.filter(request, r -> {
      sent.add(r);
      return reactor.core.publisher.Mono.just(
          org.springframework.web.reactive.function.client.ClientResponse.create(HttpStatus.OK).build());
    }).block();

    assertThat(sent).containsExactly(request);
  }

  @Test
  void bodiesAboveTheReplayCapAreStreamedAndReturnedUnpaid() throws IOException {
    ClientHttpRequestFactory transport = paywalled();
    ClientHttpRequestFactory paying =
        new X402ClientHttpRequestFactoryDecorator(client, HOSTS, 8).decorate(transport, transport);
    byte[] body = "0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    try (ClientHttpResponse response = post(paying, URI.create("https://api.example.com/upload"),
        body)) {
      assertThat(response.getStatusCode().value()).isEqualTo(402);
    }

    assertThat(scheme.signed).isEmpty();
    assertThat(created).hasSize(1);
    assertThat(created.get(0).getBodyAsBytes()).isEqualTo(body);
  }

  @Test
  void bodiesWithinTheCapAreStillPaid() throws IOException {
    ClientHttpRequestFactory transport = paywalled();
    ClientHttpRequestFactory paying =
        new X402ClientHttpRequestFactoryDecorator(client, HOSTS, 64).decorate(transport, transport);

    post(paying, URI.create("https://api.example.com/upload"), "small".getBytes(StandardCharsets.UTF_8))
        .close();

    assertThat(scheme.signed).hasSize(1);
    assertThat(created).hasSize(2);
    assertThat(created.get(1).getBodyAsBytes()).isEqualTo("small".getBytes(StandardCharsets.UTF_8));
  }
}
