package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpRequest;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
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
import org.x402.spring.client.reactive.X402ExchangeFilterFunction;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactory;
import reactor.core.publisher.Mono;

/**
 * Decision D1(B): a paid request never follows redirects on its own, but one http to https
 * redirect on the caller's host is re-sent once with the payment. Any other redirect is returned
 * as is (see {@code PaidRedirectTest}, {@code FailClosedTransportTest}), and a second redirect
 * of the paid leg is an error.
 */
class PaidRedirectResendTest {

  private static final String HTTP = "http://api.example.com/x";
  private static final String HTTPS = "https://api.example.com/x";
  private static final HostPolicy HOSTS = HostPolicy.of(List.of("api.example.com"));

  private final TestClientScheme scheme = new TestClientScheme();
  private final X402Client client = new X402Client().register(HookRecorder.NET, scheme);

  private static String required() {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(HTTPS), List.of(new PaymentRequirements("exact", HookRecorder.NET,
            "USDM", "10000", "addr", 300, Map.of())), null));
  }

  /** One request as the transport saw it. */
  private record Seen(String method, String url, boolean signed, String contentType) {}

  /** Answers by (url, signed): the unpaid leg is a 402 (as if its redirect was followed). */
  private static Map<String, Object[]> script(Object[]... rows) {
    Map<String, Object[]> map = new LinkedHashMap<>();
    for (Object[] row : rows) {
      map.put(row[0] + "|" + row[1], row);
    }
    return map;
  }

  private static Object[] reply(String url, boolean signed, int status, String location) {
    return new Object[] {url, signed, status, location};
  }

  private ClientHttpRequestFactory servletTransport(Map<String, Object[]> script,
      List<Seen> seen) {
    return (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        boolean signed = getHeaders().containsKey(X402Headers.PAYMENT_SIGNATURE);
        seen.add(new Seen(method.name(), uri.toString(), signed,
            getHeaders().getFirst("Content-Type")));
        Object[] row = script.get(uri + "|" + signed);
        int status = row == null ? 500 : (int) row[2];
        Map<String, String> headers = new LinkedHashMap<>();
        if (status == 402) {
          headers.put(X402Headers.PAYMENT_REQUIRED, required());
        }
        if (row != null && row[3] != null) {
          headers.put("Location", (String) row[3]);
        }
        return new X402ClientStarterTest.RecordingResponse(HttpStatus.valueOf(status), headers,
            () -> { });
      }
    };
  }

  private ClientHttpResponse servletSend(ClientHttpRequestFactory transport, HttpMethod method,
      String url, byte[] body) throws IOException {
    ClientHttpRequestFactory factory = X402ClientHttpRequestFactory.wrap(transport, client,
        HOSTS);
    ClientHttpRequest request = factory.createRequest(URI.create(url), method);
    if (body != null) {
      request.getHeaders().set("Content-Type", "application/json");
      request.getBody().write(body);
    }
    return request.execute();
  }

  // ---------------------------------------------------------------- RestClient transport

  @Test
  void servletPaysTheHttpsUriExactlyOnceAfterAnHttpToHttpsRedirect() throws IOException {
    List<Seen> seen = new ArrayList<>();
    ClientHttpRequestFactory transport = servletTransport(script(
        reply(HTTP, false, 402, null), reply(HTTP, true, 301, HTTPS),
        reply(HTTPS, true, 200, null)), seen);

    try (ClientHttpResponse response = servletSend(transport, HttpMethod.GET, HTTP, null)) {
      assertThat(response.getStatusCode().value()).isEqualTo(200);
    }

    assertThat(seen).containsExactly(new Seen("GET", HTTP, false, null),
        new Seen("GET", HTTP, true, null), new Seen("GET", HTTPS, true, null));
    assertThat(scheme.signed).hasSize(1);
  }

  @Test
  void servletThrowsOnASecondRedirectOfThePaidLeg() {
    List<Seen> seen = new ArrayList<>();
    ClientHttpRequestFactory transport = servletTransport(script(
        reply(HTTP, false, 402, null), reply(HTTP, true, 301, HTTPS),
        reply(HTTPS, true, 302, "https://api.example.com/elsewhere")), seen);

    assertThatThrownBy(() -> servletSend(transport, HttpMethod.GET, HTTP, null))
        .isInstanceOf(X402ClientException.class)
        .hasMessageContaining("https://api.example.com/elsewhere");

    assertThat(seen).hasSize(3);
  }

  @Test
  void servletReturnsARedirectToAnotherHostAndNeverSendsItTheSignature() throws IOException {
    List<Seen> seen = new ArrayList<>();
    ClientHttpRequestFactory transport = servletTransport(script(
        reply(HTTP, false, 402, null),
        reply(HTTP, true, 302, "https://evil.example.org/steal")), seen);

    try (ClientHttpResponse response = servletSend(transport, HttpMethod.GET, HTTP, null)) {
      assertThat(response.getStatusCode().value()).isEqualTo(302);
    }

    assertThat(seen).extracting(Seen::url).doesNotContain("https://evil.example.org/steal");
  }

  @Test
  void servletNeverDowngradesAPaidRequestToHttp() throws IOException {
    List<Seen> seen = new ArrayList<>();
    ClientHttpRequestFactory transport = servletTransport(script(
        reply(HTTPS, false, 402, null), reply(HTTPS, true, 302, HTTP)), seen);

    try (ClientHttpResponse response = servletSend(transport, HttpMethod.GET, HTTPS, null)) {
      assertThat(response.getStatusCode().value()).isEqualTo(302);
    }

    assertThat(seen).extracting(Seen::url).doesNotContain(HTTP);
  }

  @Test
  void servletResendsAPostRedirectedWith303AsABodylessGet() throws IOException {
    List<Seen> seen = new ArrayList<>();
    ClientHttpRequestFactory transport = servletTransport(script(
        reply(HTTP, false, 402, null), reply(HTTP, true, 303, HTTPS),
        reply(HTTPS, true, 200, null)), seen);

    try (ClientHttpResponse response = servletSend(transport, HttpMethod.POST, HTTP,
        "{}".getBytes(StandardCharsets.UTF_8))) {
      assertThat(response.getStatusCode().value()).isEqualTo(200);
    }

    assertThat(seen.get(2)).isEqualTo(new Seen("GET", HTTPS, true, null));
  }

  // ---------------------------------------------------------------- WebClient filter

  private ExchangeFunction reactiveTransport(Map<String, Object[]> script, List<Seen> seen) {
    return request -> {
      boolean signed = request.headers().containsKey(X402Headers.PAYMENT_SIGNATURE);
      seen.add(new Seen(request.method().name(), request.url().toString(), signed,
          request.headers().getFirst("Content-Type")));
      Object[] row = script.get(request.url() + "|" + signed);
      int status = row == null ? 500 : (int) row[2];
      ClientResponse.Builder builder = ClientResponse.create(HttpStatus.valueOf(status));
      if (status == 402) {
        builder.header(X402Headers.PAYMENT_REQUIRED, required());
      }
      if (row != null && row[3] != null) {
        builder.header("Location", (String) row[3]);
      }
      return Mono.just(builder.build());
    };
  }

  private ClientResponse reactiveSend(ExchangeFunction transport, HttpMethod method, String url) {
    X402ExchangeFilterFunction filter = new X402ExchangeFilterFunction(client, HOSTS, 1024)
        .forTransport(TransportRedirects.Safety.SAFE);
    return filter.filter(ClientRequest.create(method, URI.create(url)).build(), transport)
        .block();
  }

  @Test
  void reactivePaysTheHttpsUriExactlyOnceAfterAnHttpToHttpsRedirect() {
    List<Seen> seen = new ArrayList<>();
    ExchangeFunction transport = reactiveTransport(script(
        reply(HTTP, false, 402, null), reply(HTTP, true, 301, HTTPS),
        reply(HTTPS, true, 200, null)), seen);

    ClientResponse response = reactiveSend(transport, HttpMethod.GET, HTTP);

    assertThat(response.statusCode().value()).isEqualTo(200);
    assertThat(seen).containsExactly(new Seen("GET", HTTP, false, null),
        new Seen("GET", HTTP, true, null), new Seen("GET", HTTPS, true, null));
    assertThat(scheme.signed).hasSize(1);
  }

  @Test
  void reactiveThrowsOnASecondRedirectOfThePaidLeg() {
    List<Seen> seen = new ArrayList<>();
    ExchangeFunction transport = reactiveTransport(script(
        reply(HTTP, false, 402, null), reply(HTTP, true, 301, HTTPS),
        reply(HTTPS, true, 302, "https://api.example.com/elsewhere")), seen);

    assertThatThrownBy(() -> reactiveSend(transport, HttpMethod.GET, HTTP))
        .isInstanceOf(X402ClientException.class)
        .hasMessageContaining("https://api.example.com/elsewhere");

    assertThat(seen).hasSize(3);
  }

  @Test
  void reactiveReturnsARedirectToAnotherHostAndNeverSendsItTheSignature() {
    List<Seen> seen = new ArrayList<>();
    ExchangeFunction transport = reactiveTransport(script(
        reply(HTTP, false, 402, null),
        reply(HTTP, true, 302, "https://evil.example.org/steal")), seen);

    ClientResponse response = reactiveSend(transport, HttpMethod.GET, HTTP);

    assertThat(response.statusCode().value()).isEqualTo(302);
    assertThat(seen).extracting(Seen::url).doesNotContain("https://evil.example.org/steal");
  }

  @Test
  void reactiveResendsAPostRedirectedWith303AsAGet() {
    List<Seen> seen = new ArrayList<>();
    ExchangeFunction transport = reactiveTransport(script(
        reply(HTTP, false, 402, null), reply(HTTP, true, 303, HTTPS),
        reply(HTTPS, true, 200, null)), seen);

    ClientResponse response = reactiveSend(transport, HttpMethod.POST, HTTP);

    assertThat(response.statusCode().value()).isEqualTo(200);
    assertThat(seen.get(2)).isEqualTo(new Seen("GET", HTTPS, true, null));
  }
}
