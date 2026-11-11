package org.x402.http;

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
import java.util.function.Function;
import java.util.stream.Collectors;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;

/** A transport that answers scripted replies and streams their bodies in 64 KB chunks. */
class ScriptedTransport extends HttpClient {

  static final int CHUNK = 64 * 1024;

  /**
   * What the transport answers.
   *
   * @param status the status
   * @param headers the headers
   * @param size a body of this many zero bytes
   * @param answered the request the response claims to answer (as after the delegate's own
   *     redirects), or {@code null} for the request that was sent
   */
  record Reply(int status, Map<String, String> headers, long size, HttpRequest answered) {
    Reply(int status, Map<String, String> headers, long size) {
      this(status, headers, size, null);
    }
  }

  final List<HttpRequest> requests = new ArrayList<>();
  /** Per request: the bytes pushed so far (pushing follows the subscriber's demand). */
  final List<AtomicLong> pushed = new ArrayList<>();
  /** Per request: whether the subscriber cancelled. */
  final List<AtomicBoolean> cancelled = new ArrayList<>();
  private final Function<HttpRequest, Reply> script;
  private final Redirect redirect;

  ScriptedTransport(Function<HttpRequest, Reply> script, Redirect redirect) {
    this.script = script;
    this.redirect = redirect;
  }

  @Override
  public <T> HttpResponse<T> send(HttpRequest request, BodyHandler<T> handler)
      throws IOException, InterruptedException {
    requests.add(request);
    Reply reply = script.apply(request);
    HttpHeaders headers = HttpHeaders.of(reply.headers().entrySet().stream()
        .collect(Collectors.toMap(Map.Entry::getKey, e -> List.of(e.getValue()))),
        (a, b) -> true);
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
    Pusher pusher = new Pusher(subscriber, reply.size());
    pushed.add(pusher.sent);
    cancelled.add(pusher.cancelled);
    subscriber.onSubscribe(pusher);
    pusher.startIfEmpty();
    T body = subscriber.getBody().toCompletableFuture().join();
    HttpRequest answered = reply.answered() != null ? reply.answered() : request;
    return new Answer<>(answered, reply.status(), headers, body);
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
    return redirect;
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

  /**
   * Pushes a body of zeros in 64 KB chunks only as the subscriber requests them, on the
   * requesting thread, and stops on cancel, as the JDK client does.
   */
  private static final class Pusher implements Flow.Subscription {
    private final BodySubscriber<?> subscriber;
    private long remaining;
    private long demand;
    private boolean pushing;
    private boolean done;
    final AtomicLong sent = new AtomicLong();
    final AtomicBoolean cancelled = new AtomicBoolean();

    Pusher(BodySubscriber<?> subscriber, long size) {
      this.subscriber = subscriber;
      this.remaining = size;
    }

    synchronized void startIfEmpty() {
      if (remaining == 0 && !done && !cancelled.get()) {
        done = true;
        subscriber.onComplete();
      }
    }

    @Override
    public synchronized void request(long n) {
      demand += n;
      if (pushing) {
        return; // the loop below picks the new demand up
      }
      pushing = true;
      try {
        while (!cancelled.get() && !done && demand > 0) {
          if (remaining == 0) {
            done = true;
            subscriber.onComplete();
            break;
          }
          int chunk = (int) Math.min(CHUNK, remaining);
          remaining -= chunk;
          demand--;
          sent.addAndGet(chunk);
          subscriber.onNext(List.of(ByteBuffer.allocate(chunk)));
        }
        if (!cancelled.get() && !done && remaining == 0) {
          done = true;
          subscriber.onComplete();
        }
      } finally {
        pushing = false;
      }
    }

    @Override
    public void cancel() {
      cancelled.set(true);
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

  /** A handler that counts the bytes it is given. */
  static BodyHandler<Long> counting(AtomicLong delivered) {
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
}
