package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;

import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.BodySubscriber;
import java.net.http.HttpResponse.PushPromiseHandler;
import java.net.http.HttpResponse.ResponseInfo;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executor;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.ResourceInfo;

/**
 * A 402 is held in memory (up to 64 KB) only while the client may still pay it. One it cannot pay
 * streams into the caller's handler; one it declines and that did not fit is an error, never a
 * silently truncated body.
 */
class X402HttpClientBodyCapTest {

  private static final int CHUNK = 64 * 1024;
  private static final long TEN_MB = 10L * 1024 * 1024;
  private static final HostPolicy LOCAL = HostPolicy.of(List.of("localhost"));

  private final X402Client x402 = new X402Client().register(PREPROD, new FakeClientScheme());

  private static String required(String url) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(url), List.of(Fixtures.requirements()), null));
  }

  /** What the scripted transport answers: a status, headers and a body of {@code size} zeros. */
  private record Reply(int status, Map<String, String> headers, long size) {}

  /** A transport that streams scripted bodies chunk by chunk and stops when cancelled. */
  private static final class Scripted extends HttpClient {
    final List<HttpRequest> requests = new ArrayList<>();
    final List<Long> pushed = new ArrayList<>();
    final List<Boolean> cancelled = new ArrayList<>();
    /** Set by a test: how many bytes its own handler had received after each pushed chunk. */
    AtomicLong delivered;
    final List<Long> deliveredWhileStreaming = new ArrayList<>();
    private final java.util.function.Function<HttpRequest, Reply> script;

    Scripted(java.util.function.Function<HttpRequest, Reply> script) {
      this.script = script;
    }

    @Override
    @SuppressWarnings("unchecked")
    public <T> HttpResponse<T> send(HttpRequest request, BodyHandler<T> handler)
        throws IOException, InterruptedException {
      requests.add(request);
      Reply reply = script.apply(request);
      HttpHeaders headers = HttpHeaders.of(
          reply.headers().entrySet().stream().collect(java.util.stream.Collectors.toMap(
              Map.Entry::getKey, e -> List.of(e.getValue()))), (a, b) -> true);
      BodySubscriber<T> subscriber = handler.apply(new ResponseInfo() {
        @Override
        public int statusCode() {
          return reply.status();
        }

        @Override
        public HttpHeaders headers() {
          return headers;
        }

        @Override
        public Version version() {
          return Version.HTTP_1_1;
        }
      });
      AtomicBoolean stop = new AtomicBoolean();
      subscriber.onSubscribe(new Flow.Subscription() {
        @Override
        public void request(long n) {
          // pushed below
        }

        @Override
        public void cancel() {
          stop.set(true);
        }
      });
      long sent = 0;
      while (sent < reply.size() && !stop.get()) {
        int n = (int) Math.min(CHUNK, reply.size() - sent);
        subscriber.onNext(List.of(ByteBuffer.allocate(n)));
        sent += n;
        if (delivered != null) {
          deliveredWhileStreaming.add(delivered.get());
        }
      }
      subscriber.onComplete();
      pushed.add(sent);
      cancelled.add(stop.get());
      T body = subscriber.getBody().toCompletableFuture().join();
      return new Answer<>(request, reply.status(), headers, body);
    }

    @Override
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request,
        BodyHandler<T> handler) {
      throw new UnsupportedOperationException();
    }

    @Override
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request,
        BodyHandler<T> handler, PushPromiseHandler<T> push) {
      throw new UnsupportedOperationException();
    }

    @Override
    public Optional<CookieHandler> cookieHandler() {
      return Optional.empty();
    }

    @Override
    public Optional<Duration> connectTimeout() {
      return Optional.empty();
    }

    @Override
    public Redirect followRedirects() {
      return Redirect.NEVER;
    }

    @Override
    public Optional<ProxySelector> proxy() {
      return Optional.empty();
    }

    @Override
    public SSLContext sslContext() {
      return null;
    }

    @Override
    public SSLParameters sslParameters() {
      return null;
    }

    @Override
    public Optional<Authenticator> authenticator() {
      return Optional.empty();
    }

    @Override
    public Version version() {
      return Version.HTTP_1_1;
    }

    @Override
    public Optional<Executor> executor() {
      return Optional.empty();
    }
  }

  private record Answer<T>(HttpRequest request, int statusCode, HttpHeaders headers, T body)
      implements HttpResponse<T> {
    @Override
    public Optional<HttpResponse<T>> previousResponse() {
      return Optional.empty();
    }

    @Override
    public Optional<SSLSession> sslSession() {
      return Optional.empty();
    }

    @Override
    public URI uri() {
      return request.uri();
    }

    @Override
    public HttpClient.Version version() {
      return HttpClient.Version.HTTP_1_1;
    }
  }

  /** A handler that counts the bytes it is given, as they arrive. */
  private static BodyHandler<Long> counting(AtomicLong delivered) {
    return info -> new BodySubscriber<Long>() {
      private final CompletableFuture<Long> done = new CompletableFuture<>();

      @Override
      public CompletionStage<Long> getBody() {
        return done;
      }

      @Override
      public void onSubscribe(Flow.Subscription s) {
        s.request(Long.MAX_VALUE);
      }

      @Override
      public void onNext(List<ByteBuffer> items) {
        items.forEach(b -> delivered.addAndGet(b.remaining()));
      }

      @Override
      public void onError(Throwable t) {
        done.completeExceptionally(t);
      }

      @Override
      public void onComplete() {
        done.complete(delivered.get());
      }
    };
  }

  private static HttpRequest get(String url) {
    return HttpRequest.newBuilder(URI.create(url)).build();
  }

  @Test
  void aLargeUnpayable402WithoutTheHeaderStreamsIntoTheCallersHandlerIntact() throws Exception {
    Scripted transport = new Scripted(r -> new Reply(402, Map.of(), TEN_MB));
    AtomicLong delivered = new AtomicLong();
    transport.delivered = delivered;
    HttpClient client = X402HttpClient.wrap(transport, x402, LOCAL);

    HttpResponse<Long> response = client.send(get("http://localhost/big"), counting(delivered));

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(response.body()).isEqualTo(TEN_MB);
    // The handler was fed while the transport was still streaming, not replayed afterwards.
    assertThat(transport.deliveredWhileStreaming.get(0)).isEqualTo((long) CHUNK);
    assertThat(transport.requests).hasSize(1);
  }

  @Test
  void a402FromAHostOutsideThePolicyStreamsIntoTheCallersHandler() throws Exception {
    Scripted transport = new Scripted(r -> new Reply(402,
        Map.of("PAYMENT-REQUIRED", required("http://other.example/x")), TEN_MB));
    AtomicLong delivered = new AtomicLong();
    transport.delivered = delivered;
    HttpClient client = X402HttpClient.wrap(transport, x402, LOCAL);

    HttpResponse<Long> response = client.send(get("http://other.example/x"), counting(delivered));

    assertThat(response.body()).isEqualTo(TEN_MB);
    assertThat(transport.deliveredWhileStreaming.get(0)).isEqualTo((long) CHUNK);
  }

  @Test
  void aPayable402IsNeverBufferedBeyondTheCapWhenItIsPaid() throws Exception {
    String url = "http://localhost/paid";
    Scripted transport = new Scripted(r -> r.headers().firstValue("PAYMENT-SIGNATURE").isPresent()
        ? new Reply(200, Map.of(), 2) : new Reply(402, Map.of("PAYMENT-REQUIRED", required(url)),
            TEN_MB));
    HttpClient client = X402HttpClient.wrap(transport, x402, LOCAL);

    HttpResponse<String> response = client.send(get(url), HttpResponse.BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(transport.requests).hasSize(2);
    // The 10 MB 402 was cut off at the cap instead of being read to its end.
    assertThat(transport.cancelled.get(0)).isTrue();
    assertThat(transport.pushed.get(0)).isLessThanOrEqualTo(2L * CHUNK);
  }

  @Test
  void aPayable402ThatIsDeclinedAndDidNotFitThrowsAnIoExceptionNamingTheCap() {
    // resource.url names a host outside the policy, so the 402 is declined and returned.
    Scripted transport = new Scripted(r -> new Reply(402,
        Map.of("PAYMENT-REQUIRED", required("http://other.example/x")), TEN_MB));
    // The request host is allowed (so the body is held) but the offer is for another host.
    HttpClient client = X402HttpClient.wrap(transport, x402, LOCAL);

    assertThatThrownBy(() -> client.send(get("http://localhost/big"),
        HttpResponse.BodyHandlers.ofString())).isInstanceOf(IOException.class)
        .hasMessageContaining("65536");
    assertThat(transport.requests).hasSize(1);
  }

  @Test
  void aSmallDeclined402IsStillReturnedIntact() throws Exception {
    Scripted transport = new Scripted(r -> new Reply(402,
        Map.of("PAYMENT-REQUIRED", required("http://other.example/x")), 1000));
    HttpClient client = X402HttpClient.wrap(transport, x402, LOCAL);

    HttpResponse<byte[]> response = client.send(get("http://localhost/small"),
        HttpResponse.BodyHandlers.ofByteArray());

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(response.body()).hasSize(1000);
  }
}
