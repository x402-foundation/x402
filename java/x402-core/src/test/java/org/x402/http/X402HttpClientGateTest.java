package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;

import java.net.URI;
import java.net.http.HttpClient.Redirect;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.ResourceInfo;
import org.x402.http.ScriptedTransport.Reply;

/**
 * The paid answer's body is never left waiting and never read for nothing: a handler or hook that
 * fails, and a retried answer, cancel it; the gating needs no thread of the client's own, so a
 * closed client still pays; and a POST turned into a GET never gets its bytes or body headers
 * back on a later redirect.
 */
class X402HttpClientGateTest {

  private static final String URL = "http://localhost/paid";
  private static final HostPolicy LOCAL = HostPolicy.of(List.of("localhost"));

  private static String required(String url) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(url), List.of(Fixtures.requirements()), null));
  }

  private static boolean paid(HttpRequest r) {
    return r.headers().firstValue("PAYMENT-SIGNATURE").isPresent();
  }

  private static ScriptedTransport paywall(long paidBody) {
    return new ScriptedTransport(r -> paid(r) ? new Reply(200, Map.of(), paidBody)
        : new Reply(402, Map.of("PAYMENT-REQUIRED", required(URL)), 10), Redirect.NEVER);
  }

  private static X402Client x402() {
    return new X402Client().register(PREPROD, new FakeClientScheme());
  }

  @Test
  void aHandlerThatFailsOnThePaidAnswerCancelsItsBody() {
    ScriptedTransport transport = paywall(10L * 1024 * 1024);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, x402(), LOCAL);

    assertThatThrownBy(() -> client.send(HttpRequest.newBuilder(URI.create(URL)).build(), info -> {
      throw new IllegalStateException("cannot open the download file");
    })).hasMessageContaining("download file");
    assertThat(transport.cancelled.get(1).get()).isTrue();
    assertThat(transport.pushed.get(1).get()).isZero();
  }

  @Test
  void aHookThatThrowsCancelsThePaidBody() {
    ScriptedTransport transport = paywall(10L * 1024 * 1024);
    X402Client failing = x402().onPaymentResponse(c -> {
      throw new IllegalStateException("hook broke");
    });
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, failing, LOCAL);

    assertThatThrownBy(() -> client.send(HttpRequest.newBuilder(URI.create(URL)).build(),
        HttpResponse.BodyHandlers.ofString())).hasMessage("hook broke");
    assertThat(transport.pushed.get(1).get()).isZero();
  }

  @Test
  void aRetriedAnswerIsCancelledNotRead() throws Exception {
    AtomicInteger paidCalls = new AtomicInteger();
    ScriptedTransport transport = new ScriptedTransport(r -> {
      if (!paid(r)) {
        return new Reply(402, Map.of("PAYMENT-REQUIRED", required(URL)), 10);
      }
      return paidCalls.incrementAndGet() == 1 ? new Reply(402, Map.of(), 10L * 1024 * 1024)
          : new Reply(200, Map.of(), 7);
    }, Redirect.NEVER);
    AtomicInteger hooks = new AtomicInteger();
    X402Client recovering = x402().onPaymentResponse(c -> hooks.incrementAndGet() == 1);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, recovering, LOCAL);

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(URI.create(URL)).build(),
        HttpResponse.BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(transport.pushed.get(1).get()).isZero();
  }

  @Test
  void aClosedClientStillPaysWithoutThreadsOfItsOwn() throws Exception {
    ScriptedTransport transport = paywall(2);
    X402HttpClient client = X402HttpClient.wrap(transport, x402(), LOCAL);
    client.close();

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(URI.create(URL)).build(),
        HttpResponse.BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
  }

  @Test
  void aPostTurnedIntoAGetNeverGetsItsBytesOrBodyHeadersBack() throws Exception {
    ScriptedTransport transport = new ScriptedTransport(r -> switch (r.uri().getPath()) {
      case "/a" -> new Reply(303, Map.of("Location", "/b"), 0);
      case "/b" -> new Reply(302, Map.of("Location", "/c"), 0);
      default -> new Reply(200, Map.of(), 2);
    }, Redirect.NEVER);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, x402(), LOCAL);

    client.send(HttpRequest.newBuilder(URI.create("http://localhost/a"))
        .header("Content-Type", "application/json")
        .POST(BodyPublishers.ofString("{\"card\":\"4111-1111\"}")).build(),
        HttpResponse.BodyHandlers.ofString());

    for (HttpRequest followed : transport.requests.subList(1, 3)) {
      assertThat(followed.method()).as(followed.uri().getPath()).isEqualTo("GET");
      assertThat(followed.bodyPublisher().map(p -> p.contentLength()).orElse(0L))
          .as(followed.uri().getPath()).isZero();
      assertThat(followed.headers().firstValue("Content-Type")).as(followed.uri().getPath())
          .isEmpty();
    }
  }
}
