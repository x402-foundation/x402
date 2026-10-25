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
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.ResourceInfo;
import org.x402.http.ScriptedTransport.Reply;

/**
 * Only the unpaid 402 is held in memory. The paid answer and a redirect that is not followed reach
 * the caller as they are, whatever their size; a paid answer that is retried never reaches the
 * caller's handler; and a body is only required to be replayable when the paid retry re-sends it.
 */
class X402HttpClientPaidLegTest {

  private static final long LARGE = 100 * 1024;
  private static final HostPolicy LOCAL = HostPolicy.of(List.of("localhost"));

  private final X402Client x402 = new X402Client().register(PREPROD, new FakeClientScheme());

  private static String required(String url) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(url), List.of(Fixtures.requirements()), null));
  }

  private static boolean paid(HttpRequest r) {
    return r.headers().firstValue("PAYMENT-SIGNATURE").isPresent();
  }

  @Test
  void aLargeRejectionOfThePaidRequestIsReturnedNotThrown() throws Exception {
    String url = "http://localhost/paid";
    for (HostPolicy policy : new HostPolicy[] {null, LOCAL}) {
      ScriptedTransport transport = new ScriptedTransport(r -> new Reply(402,
          Map.of("PAYMENT-REQUIRED", required(url)), paid(r) ? LARGE : 10), Redirect.NEVER);
      java.net.http.HttpClient client = policy == null ? X402HttpClient.wrap(transport, x402)
          : X402HttpClient.wrap(transport, x402, policy);

      HttpResponse<byte[]> response = client.send(HttpRequest.newBuilder(URI.create(url)).build(),
          HttpResponse.BodyHandlers.ofByteArray());

      assertThat(response.statusCode()).isEqualTo(402);
      assertThat(response.body()).hasSize((int) LARGE);
      assertThat(transport.requests).hasSize(2);
    }
  }

  @Test
  void aLargeRedirectThatIsNotFollowedIsReturnedNotThrown() throws Exception {
    // No Location: under a HostPolicy the 302 is not followed and goes back to the caller.
    ScriptedTransport transport = new ScriptedTransport(r -> new Reply(302, Map.of(), LARGE),
        Redirect.NEVER);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, x402, LOCAL);

    HttpResponse<byte[]> response = client.send(
        HttpRequest.newBuilder(URI.create("http://localhost/moved")).build(),
        HttpResponse.BodyHandlers.ofByteArray());

    assertThat(response.statusCode()).isEqualTo(302);
    assertThat(response.body()).hasSize((int) LARGE);
  }

  @Test
  void aLargePostRedirectedToAGetIsPaidWithoutItsBody() throws Exception {
    // 2 MiB is over max-replay-body, but the paid retry after a 303 is a bodyless GET.
    ScriptedTransport transport = new ScriptedTransport(r -> {
      if (r.uri().getPath().equals("/submit")) {
        return new Reply(303, Map.of("Location", "/result"), 0);
      }
      return paid(r) ? new Reply(200, Map.of(), 2)
          : new Reply(402, Map.of("PAYMENT-REQUIRED", required("http://localhost/result")), 10);
    }, Redirect.NEVER);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, x402, LOCAL);

    HttpResponse<String> response = client.send(
        HttpRequest.newBuilder(URI.create("http://localhost/submit"))
            .POST(BodyPublishers.ofByteArray(new byte[2 << 20])).build(),
        HttpResponse.BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    HttpRequest retry = transport.requests.get(transport.requests.size() - 1);
    assertThat(paid(retry)).isTrue();
    assertThat(retry.method()).isEqualTo("GET");
    assertThat(retry.uri().getPath()).isEqualTo("/result");
  }

  @Test
  void aLargePostRedirectedToAGetIsPaidWithoutAHostPolicyToo() throws Exception {
    HttpRequest answered = HttpRequest.newBuilder(URI.create("http://localhost/result")).build();
    ScriptedTransport transport = new ScriptedTransport(r -> paid(r)
        ? new Reply(200, Map.of(), 2)
        : new Reply(402, Map.of("PAYMENT-REQUIRED", required("http://localhost/result")), 10,
            answered), Redirect.NORMAL);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, x402);

    HttpResponse<String> response = client.send(
        HttpRequest.newBuilder(URI.create("http://localhost/submit"))
            .POST(BodyPublishers.ofByteArray(new byte[2 << 20])).build(),
        HttpResponse.BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(transport.requests.get(1).method()).isEqualTo("GET");
  }

  @Test
  void aSameHostUpgradeToHttpsKeepsTheCallersCredentialsOnThePaidRetry() throws Exception {
    HttpRequest answered = HttpRequest.newBuilder(URI.create("https://api.example.com/x"))
        .header("Authorization", "Bearer t").build();
    ScriptedTransport transport = new ScriptedTransport(r -> paid(r)
        ? new Reply(200, Map.of(), 2)
        : new Reply(402, Map.of("PAYMENT-REQUIRED", required("https://api.example.com/x")), 10,
            answered), Redirect.NORMAL);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, x402);

    client.send(HttpRequest.newBuilder(URI.create("http://api.example.com/x"))
        .header("Authorization", "Bearer t").header("Cookie", "s=1").build(),
        HttpResponse.BodyHandlers.ofString());

    HttpRequest retry = transport.requests.get(1);
    assertThat(retry.uri()).isEqualTo(URI.create("https://api.example.com/x"));
    assertThat(retry.headers().firstValue("Authorization")).contains("Bearer t");
    assertThat(retry.headers().firstValue("Cookie")).contains("s=1");
  }

  @Test
  void anotherHostStillLosesTheCallersCredentials() throws Exception {
    HttpRequest answered = HttpRequest.newBuilder(URI.create("https://cdn.example.com/x")).build();
    ScriptedTransport transport = new ScriptedTransport(r -> paid(r)
        ? new Reply(200, Map.of(), 2)
        : new Reply(402, Map.of("PAYMENT-REQUIRED", required("https://cdn.example.com/x")), 10,
            answered), Redirect.NORMAL);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, x402);

    client.send(HttpRequest.newBuilder(URI.create("http://api.example.com/x"))
        .header("Authorization", "Bearer t").build(), HttpResponse.BodyHandlers.ofString());

    assertThat(transport.requests.get(1).headers().firstValue("Authorization")).isEmpty();
  }

  @Test
  void aPaidAnswerThatIsRetriedNeverReachesTheCallersHandler() throws Exception {
    String url = "http://localhost/paid";
    AtomicInteger paidCalls = new AtomicInteger();
    ScriptedTransport transport = new ScriptedTransport(r -> {
      if (!paid(r)) {
        return new Reply(402, Map.of("PAYMENT-REQUIRED", required(url)), 10);
      }
      // The first paid answer is a settle failure with a 1000-byte body, the second succeeds.
      return paidCalls.incrementAndGet() == 1 ? new Reply(402, Map.of(), 1000)
          : new Reply(200, Map.of(), 7);
    }, Redirect.NEVER);
    AtomicInteger hookCalls = new AtomicInteger();
    X402Client recovering = new X402Client().register(PREPROD, new FakeClientScheme())
        .onPaymentResponse(c -> hookCalls.incrementAndGet() == 1);
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, recovering, LOCAL);
    AtomicLong delivered = new AtomicLong();

    HttpResponse<Long> response = client.send(
        HttpRequest.newBuilder(URI.create(url)).build(), ScriptedTransport.counting(delivered));

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(delivered.get()).isEqualTo(7);
    assertThat(transport.requests).hasSize(3);
    assertThat(hookCalls.get()).isEqualTo(2);
  }

  @Test
  void aHookThatThrowsOnThePaidAnswerStillFailsTheSend() {
    String url = "http://localhost/paid";
    ScriptedTransport transport = new ScriptedTransport(r -> paid(r)
        ? new Reply(500, Map.of(), 1000)
        : new Reply(402, Map.of("PAYMENT-REQUIRED", required(url)), 10), Redirect.NEVER);
    X402Client failing = new X402Client().register(PREPROD, new FakeClientScheme())
        .onPaymentResponse(c -> {
          throw new IllegalStateException("hook broke");
        });
    java.net.http.HttpClient client = X402HttpClient.wrap(transport, failing, LOCAL);

    assertThatThrownBy(() -> client.send(HttpRequest.newBuilder(URI.create(url)).build(),
        HttpResponse.BodyHandlers.ofString())).isInstanceOf(IllegalStateException.class)
        .hasMessage("hook broke");
  }
}
