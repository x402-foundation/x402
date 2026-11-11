package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DefaultDataBufferFactory;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.web.client.RestClient;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.springframework.web.reactive.function.client.WebClient;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.client.reactive.X402ExchangeFilterFunction;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactory;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * A {@code PAYMENT-REQUIRED} header whose JSON is {@code null} (base64 {@code bnVsbA==}) is a
 * parse failure like any other: {@link X402ClientException}, nothing signed, and the 402 response
 * is closed (RestClient) or released (WebClient).
 */
class NullPaymentRequiredHeaderTest {

  private static final String NULL_JSON = "bnVsbA==";
  private static final String URL = "https://api.example.com/x";
  private static final HostPolicy HOSTS = HostPolicy.of(List.of("api.example.com"));

  private final TestClientScheme scheme = new TestClientScheme();
  private final X402Client client = new X402Client().register(HookRecorder.NET, scheme);

  @Test
  void restClientThrowsX402ClientExceptionAndClosesTheResponse() {
    List<String> closed = new ArrayList<>();
    ClientHttpRequestFactory transport = (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        return new X402ClientStarterTest.RecordingResponse(HttpStatus.PAYMENT_REQUIRED,
            Map.of(X402Headers.PAYMENT_REQUIRED, NULL_JSON), () -> closed.add("402"));
      }
    };
    RestClient rest = RestClient.builder()
        .requestFactory(X402ClientHttpRequestFactory.wrap(transport, client, HOSTS)).build();

    assertThatThrownBy(() -> rest.get().uri(URL).retrieve().toBodilessEntity())
        .isInstanceOf(X402ClientException.class)
        .hasMessageContaining("Failed to parse payment requirements");

    assertThat(closed).containsExactly("402");
    assertThat(scheme.signed).isEmpty();
  }

  @Test
  void webClientThrowsX402ClientExceptionAndReleasesTheResponse() {
    AtomicInteger released = new AtomicInteger();
    ExchangeFunction transport = request -> Mono.just(ClientResponse
        .create(HttpStatus.PAYMENT_REQUIRED)
        .header(X402Headers.PAYMENT_REQUIRED, NULL_JSON)
        .body(Flux.<DataBuffer>just(new DefaultDataBufferFactory().wrap(new byte[] {1}))
            .doOnSubscribe(s -> released.incrementAndGet()))
        .build());
    WebClient web = WebClient.builder().exchangeFunction(transport)
        .filter(new X402ExchangeFilterFunction(client, HOSTS, 1024)
            .forTransport(TransportRedirects.Safety.SAFE))
        .build();

    assertThatThrownBy(() -> web.get().uri(URI.create(URL)).retrieve().toBodilessEntity().block())
        .isInstanceOf(X402ClientException.class)
        .hasMessageContaining("Failed to parse payment requirements");

    assertThat(released.get()).isEqualTo(1);
    assertThat(scheme.signed).isEmpty();
  }

  @Test
  void theFilterIsGivenTheRequestItReleases() {
    // Guards the fixture: the filter really saw the 402 (it is the only ExchangeFunction call).
    AtomicInteger calls = new AtomicInteger();
    ExchangeFunction transport = request -> {
      calls.incrementAndGet();
      return Mono.just(ClientResponse.create(HttpStatus.PAYMENT_REQUIRED)
          .header(X402Headers.PAYMENT_REQUIRED, NULL_JSON).build());
    };
    X402ExchangeFilterFunction filter = new X402ExchangeFilterFunction(client, HOSTS, 1024)
        .forTransport(TransportRedirects.Safety.SAFE);

    assertThatThrownBy(() -> filter.filter(ClientRequest.create(HttpMethod.GET, URI.create(URL))
        .build(), transport).block()).isInstanceOf(X402ClientException.class);
    assertThat(calls.get()).isEqualTo(1);
  }
}
