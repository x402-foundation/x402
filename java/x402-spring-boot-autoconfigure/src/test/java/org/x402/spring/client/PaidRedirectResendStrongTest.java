package org.x402.spring.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.client.ClientHttpRequest;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.springframework.web.reactive.function.client.ExchangeStrategies;
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
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Pins the paid-leg redirect rules beyond {@code PaidRedirectResendTest}: the exact method and body
 * of the re-send for each status, which redirects are not re-sent (http to http, relative, missing
 * Location, non-redirect 3xx, a redirect on the unpaid leg), that any second redirect throws, that
 * both paid legs carry one payment, and that every superseded response is released.
 */
class PaidRedirectResendStrongTest {

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
  private record Seen(String method, String url, String signature, String contentType,
      String body) {
    boolean signed() {
      return signature != null;
    }
  }

  /** Scripted answers keyed by url and whether the request was signed. */
  private static final class Script {
    final Map<String, int[]> status = new LinkedHashMap<>();
    final Map<String, String> location = new LinkedHashMap<>();
    final List<Seen> seen = new ArrayList<>();
    final List<String> released = new ArrayList<>();

    Script reply(String url, boolean signed, int code, String loc) {
      status.put(url + "|" + signed, new int[] {code});
      if (loc != null) {
        location.put(url + "|" + signed, loc);
      }
      return this;
    }

    int codeFor(String url, boolean signed) {
      int[] row = status.get(url + "|" + signed);
      return row == null ? 500 : row[0];
    }

    Map<String, String> headersFor(String url, boolean signed) {
      Map<String, String> headers = new LinkedHashMap<>();
      if (codeFor(url, signed) == 402) {
        headers.put(X402Headers.PAYMENT_REQUIRED, required());
      }
      String loc = location.get(url + "|" + signed);
      if (loc != null) {
        headers.put("Location", loc);
      }
      return headers;
    }
  }

  // ---------------------------------------------------------------- RestClient transport

  private static final class Response implements ClientHttpResponse {
    private final HttpStatusCode status;
    private final HttpHeaders headers = new HttpHeaders();
    private final Runnable onClose;

    Response(int status, Map<String, String> headers, Runnable onClose) {
      this.status = HttpStatusCode.valueOf(status);
      headers.forEach(this.headers::add);
      this.onClose = onClose;
    }

    @Override
    public HttpStatusCode getStatusCode() {
      return status;
    }

    @Override
    public String getStatusText() {
      return "";
    }

    @Override
    public void close() {
      onClose.run();
    }

    @Override
    public InputStream getBody() {
      return new ByteArrayInputStream(new byte[0]);
    }

    @Override
    public HttpHeaders getHeaders() {
      return headers;
    }
  }

  private ClientHttpRequestFactory servletTransport(Script script) {
    return (uri, method) -> new MockClientHttpRequest(method, uri) {
      @Override
      protected ClientHttpResponse executeInternal() {
        boolean signed = getHeaders().containsKey(X402Headers.PAYMENT_SIGNATURE);
        script.seen.add(new Seen(method.name(), uri.toString(),
            getHeaders().getFirst(X402Headers.PAYMENT_SIGNATURE),
            getHeaders().getFirst("Content-Type"), getBodyAsString()));
        return new Response(script.codeFor(uri.toString(), signed),
            script.headersFor(uri.toString(), signed),
            () -> script.released.add(uri + "|" + signed));
      }
    };
  }

  private ClientHttpResponse servletSend(Script script, HttpMethod method, String url,
      String body) throws IOException {
    ClientHttpRequest request = X402ClientHttpRequestFactory
        .wrap(servletTransport(script), client, HOSTS).createRequest(URI.create(url), method);
    if (body != null) {
      request.getHeaders().set("Content-Type", "application/json");
      request.getBody().write(body.getBytes(StandardCharsets.UTF_8));
    }
    return request.execute();
  }

  private static Script paidRedirect(String from, int status, String location, String to,
      int toStatus, String toLocation) {
    return new Script().reply(from, false, 402, null).reply(from, true, status, location)
        .reply(to, true, toStatus, toLocation);
  }

  @ParameterizedTest
  @ValueSource(ints = {307, 308})
  void servletKeepsMethodAndBodyOnA307Or308(int status) throws IOException {
    Script script = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);

    try (ClientHttpResponse response = servletSend(script, HttpMethod.POST, HTTP, "{\"a\":1}")) {
      assertThat(response.getStatusCode().value()).isEqualTo(200);
    }

    Seen last = script.seen.get(2);
    assertThat(last.method()).isEqualTo("POST");
    assertThat(last.url()).isEqualTo(HTTPS);
    assertThat(last.body()).isEqualTo("{\"a\":1}");
    assertThat(last.contentType()).isEqualTo("application/json");
    assertThat(last.signed()).isTrue();
  }

  @ParameterizedTest
  @ValueSource(ints = {301, 302, 303})
  void servletResendsAPostAsABodylessGetOn301302303(int status) throws IOException {
    Script script = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);

    servletSend(script, HttpMethod.POST, HTTP, "{\"a\":1}").close();

    Seen last = script.seen.get(2);
    assertThat(last.method()).isEqualTo("GET");
    assertThat(last.body()).isEmpty();
    assertThat(last.contentType()).isNull();
    assertThat(last.signed()).isTrue();
  }

  @ParameterizedTest
  @ValueSource(ints = {301, 302})
  void servletKeepsAGetAndAPutOn301Or302(int status) throws IOException {
    Script get = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);
    servletSend(get, HttpMethod.GET, HTTP, null).close();
    assertThat(get.seen.get(2).method()).isEqualTo("GET");

    Script put = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);
    servletSend(put, HttpMethod.PUT, HTTP, "{\"a\":1}").close();
    assertThat(put.seen.get(2).method()).isEqualTo("PUT");
    assertThat(put.seen.get(2).body()).isEqualTo("{\"a\":1}");
  }

  @ParameterizedTest
  @ValueSource(ints = {301, 302, 303, 307, 308})
  void servletThrowsOnAnyKindOfSecondRedirect(int second) {
    Script script = paidRedirect(HTTP, 301, HTTPS, HTTPS, second, "https://api.example.com/z");

    assertThatThrownBy(() -> servletSend(script, HttpMethod.GET, HTTP, null))
        .isInstanceOf(X402ClientException.class).hasMessageContaining("redirected again");

    assertThat(script.seen).hasSize(3);
    assertThat(script.released).contains(HTTPS + "|true");
  }

  @Test
  void servletDoesNotResendAnHttpToHttpOrRelativeRedirect() throws IOException {
    for (String location : new String[] {"http://api.example.com/other", "/other",
        "//api.example.com/other"}) {
      Script script = new Script().reply(HTTP, false, 402, null)
          .reply(HTTP, true, 302, location);

      try (ClientHttpResponse response = servletSend(script, HttpMethod.GET, HTTP, null)) {
        assertThat(response.getStatusCode().value()).isEqualTo(302);
      }

      assertThat(script.seen).as(location).hasSize(2);
    }
  }

  @Test
  void servletReturnsARedirectWithoutAUsableLocationAndANonRedirect3xx() throws IOException {
    for (Object[] row : new Object[][] {{302, null}, {302, " "}, {304, HTTPS}, {300, HTTPS}}) {
      Script script = new Script().reply(HTTP, false, 402, null)
          .reply(HTTP, true, (int) row[0], (String) row[1]);

      try (ClientHttpResponse response = servletSend(script, HttpMethod.GET, HTTP, null)) {
        assertThat(response.getStatusCode().value()).isEqualTo(row[0]);
      }

      assertThat(script.seen).hasSize(2);
    }
  }

  @Test
  void servletNeverFollowsARedirectOnTheUnpaidLeg() throws IOException {
    Script script = new Script().reply(HTTP, false, 301, HTTPS).reply(HTTPS, false, 200, null);

    try (ClientHttpResponse response = servletSend(script, HttpMethod.GET, HTTP, null)) {
      assertThat(response.getStatusCode().value()).isEqualTo(301);
    }

    assertThat(script.seen).hasSize(1);
    assertThat(scheme.signed).isEmpty();
  }

  @Test
  void servletMatchesTheHostCaseInsensitivelyAndSendsTheSameSignatureOnBothPaidLegs()
      throws IOException {
    Script script = paidRedirect(HTTP, 301, "https://API.Example.COM/x", "https://API.Example.COM/x",
        200, null);

    servletSend(script, HttpMethod.GET, HTTP, null).close();

    assertThat(script.seen).hasSize(3);
    assertThat(script.seen.get(2).url()).isEqualTo("https://API.Example.COM/x");
    assertThat(script.seen.get(2).signature()).isNotBlank()
        .isEqualTo(script.seen.get(1).signature());
    assertThat(scheme.signed).hasSize(1);
  }

  @Test
  void servletReleasesTheSupersededResponses() throws IOException {
    Script script = paidRedirect(HTTP, 301, HTTPS, HTTPS, 200, null);

    servletSend(script, HttpMethod.GET, HTTP, null).close();

    assertThat(script.released).contains(HTTP + "|false", HTTP + "|true");
  }

  // ---------------------------------------------------------------- WebClient filter

  private ExchangeFunction reactiveTransport(Script script) {
    return request -> {
      boolean signed = request.headers().containsKey(X402Headers.PAYMENT_SIGNATURE);
      org.springframework.mock.http.client.reactive.MockClientHttpRequest mock =
          new org.springframework.mock.http.client.reactive.MockClientHttpRequest(request.method(),
              request.url());
      return request.writeTo(mock, ExchangeStrategies.withDefaults())
          .then(Mono.defer(() -> mock.getBodyAsString().defaultIfEmpty("")))
          .map(body -> {
            script.seen.add(new Seen(request.method().name(), request.url().toString(),
                request.headers().getFirst(X402Headers.PAYMENT_SIGNATURE),
                request.headers().getFirst("Content-Type"), body));
            String url = request.url().toString();
            ClientResponse.Builder builder = ClientResponse.create(
                HttpStatus.valueOf(script.codeFor(url, signed)))
                .body(Flux.<DataBuffer>empty()
                    .doOnSubscribe(s -> script.released.add(url + "|" + signed)));
            script.headersFor(url, signed).forEach(builder::header);
            return builder.build();
          });
    };
  }

  private ClientResponse reactiveSend(Script script, HttpMethod method, String url,
      String body) {
    X402ExchangeFilterFunction filter = new X402ExchangeFilterFunction(client, HOSTS, 1024)
        .forTransport(TransportRedirects.Safety.SAFE);
    ClientRequest.Builder request = ClientRequest.create(method, URI.create(url));
    if (body != null) {
      request.header("Content-Type", "application/json").body(BodyInserters.fromValue(body));
    }
    return filter.filter(request.build(), reactiveTransport(script)).block();
  }

  @ParameterizedTest
  @ValueSource(ints = {307, 308})
  void reactiveKeepsMethodAndBodyOnA307Or308(int status) {
    Script script = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);

    ClientResponse response = reactiveSend(script, HttpMethod.POST, HTTP, "{\"a\":1}");

    assertThat(response.statusCode().value()).isEqualTo(200);
    Seen last = script.seen.get(2);
    assertThat(last.method()).isEqualTo("POST");
    assertThat(last.url()).isEqualTo(HTTPS);
    assertThat(last.body()).contains("{\"a\":1}");
    assertThat(last.contentType()).startsWith("application/json");
    assertThat(last.signed()).isTrue();
  }

  @ParameterizedTest
  @ValueSource(ints = {301, 302, 303})
  void reactiveResendsAPostAsABodylessGetOn301302303(int status) {
    Script script = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);

    reactiveSend(script, HttpMethod.POST, HTTP, "{\"a\":1}");

    Seen last = script.seen.get(2);
    assertThat(last.method()).isEqualTo("GET");
    assertThat(last.body()).isEmpty();
    assertThat(last.contentType()).isNull();
    assertThat(last.signed()).isTrue();
  }

  @ParameterizedTest
  @ValueSource(ints = {301, 302})
  void reactiveKeepsAGetAndAPutOn301Or302(int status) {
    Script get = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);
    reactiveSend(get, HttpMethod.GET, HTTP, null);
    assertThat(get.seen.get(2).method()).isEqualTo("GET");

    Script put = paidRedirect(HTTP, status, HTTPS, HTTPS, 200, null);
    reactiveSend(put, HttpMethod.PUT, HTTP, "{\"a\":1}");
    assertThat(put.seen.get(2).method()).isEqualTo("PUT");
    assertThat(put.seen.get(2).body()).contains("{\"a\":1}");
  }

  @ParameterizedTest
  @ValueSource(ints = {301, 302, 303, 307, 308})
  void reactiveThrowsOnAnyKindOfSecondRedirect(int second) {
    Script script = paidRedirect(HTTP, 301, HTTPS, HTTPS, second, "https://api.example.com/z");

    assertThatThrownBy(() -> reactiveSend(script, HttpMethod.GET, HTTP, null))
        .isInstanceOf(X402ClientException.class).hasMessageContaining("redirected again");

    assertThat(script.seen).hasSize(3);
    assertThat(script.released).contains(HTTPS + "|true");
  }

  @Test
  void reactiveDoesNotResendAnHttpToHttpOrRelativeRedirect() {
    for (String location : new String[] {"http://api.example.com/other", "/other",
        "//api.example.com/other"}) {
      Script script = new Script().reply(HTTP, false, 402, null)
          .reply(HTTP, true, 302, location);

      ClientResponse response = reactiveSend(script, HttpMethod.GET, HTTP, null);

      assertThat(response.statusCode().value()).as(location).isEqualTo(302);
      assertThat(script.seen).as(location).hasSize(2);
    }
  }

  @Test
  void reactiveReturnsARedirectWithoutAUsableLocationAndANonRedirect3xx() {
    for (Object[] row : new Object[][] {{302, null}, {302, " "}, {304, HTTPS}, {300, HTTPS}}) {
      Script script = new Script().reply(HTTP, false, 402, null)
          .reply(HTTP, true, (int) row[0], (String) row[1]);

      ClientResponse response = reactiveSend(script, HttpMethod.GET, HTTP, null);

      assertThat(response.statusCode().value()).isEqualTo(row[0]);
      assertThat(script.seen).hasSize(2);
    }
  }

  @Test
  void reactiveNeverFollowsARedirectOnTheUnpaidLeg() {
    Script script = new Script().reply(HTTP, false, 301, HTTPS).reply(HTTPS, false, 200, null);

    ClientResponse response = reactiveSend(script, HttpMethod.GET, HTTP, null);

    assertThat(response.statusCode().value()).isEqualTo(301);
    assertThat(script.seen).hasSize(1);
    assertThat(scheme.signed).isEmpty();
  }

  @Test
  void reactiveMatchesTheHostCaseInsensitivelyAndSendsTheSameSignatureOnBothPaidLegs() {
    Script script = paidRedirect(HTTP, 301, "https://API.Example.COM/x", "https://API.Example.COM/x",
        200, null);

    reactiveSend(script, HttpMethod.GET, HTTP, null);

    assertThat(script.seen).hasSize(3);
    assertThat(script.seen.get(2).url()).isEqualTo("https://API.Example.COM/x");
    assertThat(script.seen.get(2).signature()).isNotBlank()
        .isEqualTo(script.seen.get(1).signature());
    assertThat(scheme.signed).hasSize(1);
  }

  @Test
  void reactiveReleasesTheSupersededResponses() {
    Script script = paidRedirect(HTTP, 301, HTTPS, HTTPS, 200, null);

    reactiveSend(script, HttpMethod.GET, HTTP, null);

    assertThat(script.released).contains(HTTP + "|false", HTTP + "|true");
  }
}
