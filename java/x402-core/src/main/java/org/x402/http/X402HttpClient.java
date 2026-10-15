package org.x402.http;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublisher;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.BodySubscriber;
import java.net.http.HttpResponse.BodySubscribers;
import java.net.http.HttpResponse.PushPromiseHandler;
import java.net.http.HttpResponse.ResponseInfo;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import org.x402.core.client.ClientHooks.PaymentResponseContext;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.SettleResponse;

/**
 * A {@code java.net.http.HttpClient} that pays x402 402 responses.
 * {@link #wrap} keeps the caller's client type and settings: every method delegates, and
 * {@code send}/{@code sendAsync} add: on 402, decode {@code PAYMENT-REQUIRED}, select and sign
 * with the {@link X402Client}, retry once with {@code PAYMENT-SIGNATURE} (and once more if a
 * payment-response hook recovers).
 *
 * <ul>
 *   <li><b>Hosts.</b> Without a {@link HostPolicy} any host is paid (wrapping is a deliberate act).
 *       With one, a 402 from an off-list host, or whose {@code resource.url} is off-list, is
 *       returned unpaid and nothing is signed. The delegate must then have
 *       {@code followRedirects() == NEVER}: this client follows redirects itself (like {@code
 *       Redirect.NORMAL}, at most 5 hops) and never forwards a signed request to an off-list host
 *       (the redirect response is returned instead). The paid retry is sent straight to the URI
 *       that answered 402 (checked against the policy), never back to an earlier host of the
 *       redirect chain.
 *   <li><b>Empty bodies</b> ({@code contentLength() == 0}) are always replayable.
 *   <li><b>Bodies.</b> The first request's body is recorded while it is sent, up to {@code
 *       maxReplayBody} (default 1 MiB). The paid retry re-sends the recorded bytes. A body over the
 *       limit, or one that was not fully recorded, returns the 402 unpaid with a warning, decided
 *       before anything is signed.
 *   <li><b>Timeout.</b> Requests without their own timeout get {@link #DEFAULT_REQUEST_TIMEOUT}
 *       (240 s), above a typical paid request: a verify and up to two settle calls at the
 *       resource server's default facilitator timeouts (15 s and 90 s). Flows that settle more
 *       often, or longer facilitator timeouts, need a longer request timeout; the resource server
 *       warns about such routes at startup.
 *   <li><b>Errors.</b> A 402 without {@code PAYMENT-REQUIRED} is returned unchanged. A malformed
 *       header, a refused selection or a request already carrying {@code PAYMENT-SIGNATURE}
 *       throws {@link X402ClientException}.
 * </ul>
 *
 * <p>{@code sendAsync} runs the blocking flow on the client's own daemon threads, never on the
 * delegate's executor; closing or shutting down the client stops them.
 */
public final class X402HttpClient extends HttpClient implements AutoCloseable {

  /** The default request timeout. */
  public static final Duration DEFAULT_REQUEST_TIMEOUT = Duration.ofSeconds(240);

  /** The default maximum request body that can be replayed with payment: 1 MiB. */
  public static final long DEFAULT_MAX_REPLAY_BODY = 1L << 20;

  private static final int MAX_REDIRECTS = 5;
  private static final System.Logger LOG = System.getLogger(X402HttpClient.class.getName());

  private final HttpClient delegate;
  private final X402Client client;
  private final HostPolicy hostPolicy;
  private final long maxReplayBody;
  /**
   * Runs {@link #sendAsync}'s blocking flow. Not the delegate's executor: a blocking send there
   * occupies a thread the delegate needs to complete the exchange (a single-thread executor
   * deadlocks). Threads are created on demand and are daemons.
   */
  private final ExecutorService async = Executors.newCachedThreadPool(task -> {
    Thread thread = new Thread(task, "x402-http-async");
    thread.setDaemon(true);
    return thread;
  });
  private final Duration defaultTimeout;

  private X402HttpClient(Builder b) {
    this.delegate = b.delegate;
    this.client = b.client;
    this.hostPolicy = b.hostPolicy;
    this.maxReplayBody = b.maxReplayBody;
    this.defaultTimeout = b.defaultTimeout;
    if (hostPolicy != null && delegate.followRedirects() != Redirect.NEVER) {
      throw new IllegalArgumentException("With a HostPolicy the delegate HttpClient must not "
          + "follow redirects (followRedirects() == NEVER); X402HttpClient follows them itself "
          + "and checks each host before sending");
    }
  }

  /**
   * Wraps a client; pays any host.
   *
   * @param delegate the client to wrap
   * @param client signs payments
   * @return the paying client
   */
  public static X402HttpClient wrap(HttpClient delegate, X402Client client) {
    return builder(delegate, client).build();
  }

  /**
   * Wraps a client; pays only hosts the policy allows.
   *
   * @param delegate the client to wrap; must not follow redirects
   * @param client signs payments
   * @param hostPolicy the allowed hosts
   * @return the paying client
   * @throws IllegalArgumentException when the delegate follows redirects
   */
  public static X402HttpClient wrap(HttpClient delegate, X402Client client,
      HostPolicy hostPolicy) {
    return builder(delegate, client).hostPolicy(hostPolicy).build();
  }

  /**
   * Starts a builder.
   *
   * @param delegate the client to wrap
   * @param client signs payments
   * @return the builder
   */
  public static Builder builder(HttpClient delegate, X402Client client) {
    return new Builder(delegate, client);
  }

  /** Builds an {@link X402HttpClient}. */
  public static final class Builder {
    private final HttpClient delegate;
    private final X402Client client;
    private HostPolicy hostPolicy;
    private long maxReplayBody = DEFAULT_MAX_REPLAY_BODY;
    private Duration defaultTimeout = DEFAULT_REQUEST_TIMEOUT;

    private Builder(HttpClient delegate, X402Client client) {
      this.delegate = Objects.requireNonNull(delegate, "delegate");
      this.client = Objects.requireNonNull(client, "client");
    }

    /**
     * Limits payments to these hosts.
     *
     * @param value the policy, or {@code null} for any host
     * @return this builder
     */
    public Builder hostPolicy(HostPolicy value) {
      this.hostPolicy = value;
      return this;
    }

    /**
     * Sets the largest request body that can be replayed with payment.
     *
     * @param bytes the limit in bytes
     * @return this builder
     */
    public Builder maxReplayBody(long bytes) {
      this.maxReplayBody = bytes;
      return this;
    }

    /**
     * Sets the timeout for requests that have none.
     *
     * @param value the timeout
     * @return this builder
     */
    public Builder defaultRequestTimeout(Duration value) {
      this.defaultTimeout = Objects.requireNonNull(value, "timeout");
      return this;
    }

    /**
     * Builds the client.
     *
     * @return the client
     */
    public X402HttpClient build() {
      return new X402HttpClient(this);
    }
  }

  /**
   * The timeout given to requests without one.
   *
   * @return the timeout
   */
  public Duration defaultRequestTimeout() {
    return defaultTimeout;
  }

  /**
   * Returns the request with the default timeout when it has none.
   *
   * @param request the request
   * @return the request, or a copy with the default timeout
   */
  public HttpRequest withDefaultTimeout(HttpRequest request) {
    if (request.timeout().isPresent()) {
      return request;
    }
    return HttpRequest.newBuilder(request, (name, value) -> true).timeout(defaultTimeout).build();
  }

  /**
   * Decodes the {@code PAYMENT-RESPONSE} header of a response.
   *
   * @param response the response
   * @return the settlement, or empty when absent or malformed
   */
  public static Optional<SettleResponse> paymentResponse(HttpResponse<?> response) {
    return decodeSettle(response.headers());
  }

  // ---------------------------------------------------------------- delegation

  @Override
  public Optional<CookieHandler> cookieHandler() {
    return delegate.cookieHandler();
  }

  @Override
  public Optional<Duration> connectTimeout() {
    return delegate.connectTimeout();
  }

  @Override
  public Redirect followRedirects() {
    return hostPolicy != null ? Redirect.NORMAL : delegate.followRedirects();
  }

  @Override
  public Optional<ProxySelector> proxy() {
    return delegate.proxy();
  }

  @Override
  public SSLContext sslContext() {
    return delegate.sslContext();
  }

  @Override
  public SSLParameters sslParameters() {
    return delegate.sslParameters();
  }

  @Override
  public Optional<Authenticator> authenticator() {
    return delegate.authenticator();
  }

  @Override
  public Version version() {
    return delegate.version();
  }

  @Override
  public Optional<Executor> executor() {
    return delegate.executor();
  }

  @Override
  public WebSocket.Builder newWebSocketBuilder() {
    return delegate.newWebSocketBuilder();
  }

  // JDK 21 added HttpClient.close/shutdown/shutdownNow/awaitTermination/isTerminated. This module
  // targets Java 17, so the methods below (except close, which AutoCloseable declares) carry no
  // @Override and reach the delegate by reflection; on JDK 21+ they override the base methods at
  // runtime, before 21 they only stop this wrapper's own threads.

  /** Closes the delegate (JDK 21+); a no-op on older runtimes. */
  @Override
  public void close() {
    async.shutdown();
    invokeLifecycle("close");
  }

  /** Starts an orderly shutdown of the delegate (JDK 21+); a no-op on older runtimes. */
  public void shutdown() {
    async.shutdown();
    invokeLifecycle("shutdown");
  }

  /** Shuts the delegate down immediately (JDK 21+); a no-op on older runtimes. */
  public void shutdownNow() {
    async.shutdownNow();
    invokeLifecycle("shutdownNow");
  }

  /**
   * Whether the delegate has terminated (JDK 21+).
   *
   * @return the delegate's answer; {@code false} on older runtimes
   */
  public boolean isTerminated() {
    return Boolean.TRUE.equals(invokeLifecycle("isTerminated"));
  }

  /**
   * Waits for the delegate to terminate (JDK 21+).
   *
   * @param duration the longest wait
   * @return the delegate's answer; {@code false} on older runtimes
   * @throws InterruptedException when interrupted
   */
  public boolean awaitTermination(Duration duration) throws InterruptedException {
    try {
      Method method = HttpClient.class.getMethod("awaitTermination", Duration.class);
      return Boolean.TRUE.equals(method.invoke(delegate, duration));
    } catch (NoSuchMethodException e) {
      return false;
    } catch (InvocationTargetException e) {
      if (e.getCause() instanceof InterruptedException ie) {
        throw ie;
      }
      throw rethrow(e.getCause());
    } catch (IllegalAccessException e) {
      throw new IllegalStateException(e);
    }
  }

  private Object invokeLifecycle(String name) {
    try {
      return HttpClient.class.getMethod(name).invoke(delegate);
    } catch (NoSuchMethodException e) {
      return null;
    } catch (InvocationTargetException e) {
      throw rethrow(e.getCause());
    } catch (IllegalAccessException e) {
      throw new IllegalStateException(e);
    }
  }

  private static RuntimeException rethrow(Throwable cause) {
    if (cause instanceof RuntimeException re) {
      return re;
    }
    if (cause instanceof Error err) {
      throw err;
    }
    return new IllegalStateException(cause);
  }

  @Override
  public <T> CompletableFuture<HttpResponse<T>> sendAsync(
      HttpRequest request, BodyHandler<T> handler) {
    return CompletableFuture.supplyAsync(() -> {
      try {
        return send(request, handler);
      } catch (IOException e) {
        throw new CompletionException(e);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new CompletionException(e);
      }
    }, async);
  }

  @Override
  public <T> CompletableFuture<HttpResponse<T>> sendAsync(
      HttpRequest request, BodyHandler<T> handler, PushPromiseHandler<T> pushPromiseHandler) {
    return sendAsync(request, handler);
  }

  // ---------------------------------------------------------------- paying send

  @Override
  public <T> HttpResponse<T> send(HttpRequest request, BodyHandler<T> handler)
      throws IOException, InterruptedException {
    HttpRequest first = withDefaultTimeout(request);
    Recorder recorder = new Recorder(maxReplayBody);
    HttpRequest recording = first.bodyPublisher()
        .map(p -> copy(first, first.uri(), first.method(), new RecordingPublisher(p, recorder)))
        .orElse(first);
    Exchange<T> exchange = exchange(recording, handler, recorder, false, null);
    if (exchange.raw().statusCode() != 402) {
      return exchange.toResponse(handler);
    }
    return pay(first, recorder, exchange, handler);
  }

  private <T> HttpResponse<T> pay(HttpRequest first, Recorder recorder, Exchange<T> unpaid,
      BodyHandler<T> handler) throws IOException, InterruptedException {
    HttpResponse<Object> raw = unpaid.raw();
    if (hostPolicy != null && !hostPolicy.allows(raw.uri())) {
      LOG.log(System.Logger.Level.DEBUG, () -> "[x402] 402 from " + raw.uri().getHost()
          + " is not in the host policy; returned unpaid");
      return unpaid.toResponse(handler);
    }
    Optional<String> header = raw.headers().firstValue(X402Headers.PAYMENT_REQUIRED);
    if (header.isEmpty()) {
      return unpaid.toResponse(handler);
    }
    PaymentRequired required;
    try {
      required = HeaderCodec.decodePaymentRequired(header.get());
    } catch (IllegalArgumentException e) {
      throw new X402ClientException("Failed to parse payment requirements: " + e.getMessage(), e);
    }
    String resourceUrl = required.resource() == null ? null : required.resource().url();
    URI resourceUri = resourceUrl == null ? null : parseUri(resourceUrl);
    if (hostPolicy != null && (resourceUri == null || !hostPolicy.allows(resourceUri))) {
      // The resource host must also be on the list; a missing one fails closed.
      LOG.log(System.Logger.Level.DEBUG, () -> "[x402] resource.url " + resourceUrl
          + " is missing or not in the host policy; returned unpaid");
      return unpaid.toResponse(handler);
    }
    if (first.bodyPublisher().isPresent() && !replayable(first, recorder)) {
      LOG.log(System.Logger.Level.WARNING, "[x402] " + first.method() + " " + first.uri()
          + ": the request body exceeds max-replay-body (" + maxReplayBody
          + " bytes) or could not be recorded; returning the 402 unpaid");
      return unpaid.toResponse(handler);
    }
    if (first.headers().firstValue(X402Headers.PAYMENT_SIGNATURE).isPresent()
        || first.headers().firstValue(X402Headers.X_PAYMENT).isPresent()) {
      throw new X402ClientException("Payment already attempted");
    }
    // With a HostPolicy the paid retry goes to the policy-checked URI that answered 402 (the last
    // request of the redirect chain), never back to an unchecked first host.
    // Without one, the original request is retried.
    HttpRequest base = hostPolicy != null ? unpaid.last() : first;
    boolean withBody = hostPolicy != null ? unpaid.lastHasBody()
        : first.bodyPublisher().isPresent();
    HttpResponse<T> prior = hostPolicy != null
        ? new View<>(raw, null, Optional.ofNullable(unpaid.previous())) : null;
    PaymentPayload payload = create(required);
    Exchange<T> paid = exchange(signed(base, withBody, recorder, payload), handler, recorder,
        true, prior);
    if (recovered(payload, paid.raw())) {
      PaymentPayload fresh = create(required);
      Exchange<T> retry = exchange(signed(base, withBody, recorder, fresh), handler, recorder,
          true, prior);
      recovered(fresh, retry.raw());
      return retry.toResponse(handler);
    }
    return paid.toResponse(handler);
  }

  private PaymentPayload create(PaymentRequired required) {
    try {
      return client.createPaymentPayload(required);
    } catch (RuntimeException e) {
      throw new X402ClientException("Failed to create payment payload: " + e.getMessage(), e);
    }
  }

  private static HttpRequest signed(HttpRequest base, boolean withBody, Recorder recorder,
      PaymentPayload payload) {
    HttpRequest.Builder b = HttpRequest.newBuilder(base, (name, value) -> true);
    if (withBody) {
      b.method(base.method(), BodyPublishers.ofByteArray(recorder.bytes()));
    } else if (base.bodyPublisher().isPresent()) {
      b.method(base.method(), BodyPublishers.noBody());
    }
    return b.setHeader(X402Headers.PAYMENT_SIGNATURE, HeaderCodec.encodePaymentSignature(payload))
        .build();
  }

  private boolean recovered(PaymentPayload payload, HttpResponse<Object> raw) {
    SettleResponse settle = decodeSettle(raw.headers()).orElse(null);
    PaymentRequired again = null;
    if (settle == null && raw.statusCode() == 402) {
      try {
        again = raw.headers().firstValue(X402Headers.PAYMENT_REQUIRED)
            .map(HeaderCodec::decodePaymentRequired).orElse(null);
      } catch (IllegalArgumentException e) {
        again = null;
      }
    }
    return client.handlePaymentResponse(
        new PaymentResponseContext(payload, payload.accepted(), settle, again, null));
  }

  private static Optional<SettleResponse> decodeSettle(HttpHeaders headers) {
    Optional<String> value = headers.firstValue(X402Headers.PAYMENT_RESPONSE)
        .or(() -> headers.firstValue("X-PAYMENT-RESPONSE"));
    try {
      return value.map(HeaderCodec::decodePaymentResponse);
    } catch (IllegalArgumentException e) {
      return Optional.empty();
    }
  }

  // ---------------------------------------------------------------- exchanges & redirects

  private record Buffered(byte[] bytes) {}

  /**
   * One request with the redirects this client followed for it.
   *
   * @param raw the final response
   * @param previous the chain of earlier responses, or {@code null}
   * @param last the request that produced {@code raw}
   * @param lastHasBody whether {@code last} carries the original request body
   */
  private record Exchange<T>(HttpResponse<Object> raw, HttpResponse<T> previous,
      HttpRequest last, boolean lastHasBody) {

    @SuppressWarnings("unchecked")
    HttpResponse<T> toResponse(BodyHandler<T> handler) throws IOException, InterruptedException {
      T body = raw.body() instanceof Buffered b ? replay(handler, info(raw), b.bytes())
          : (T) raw.body();
      Optional<HttpResponse<T>> prev = previous != null ? Optional.of(previous)
          : raw.previousResponse().map(p -> (HttpResponse<T>) (HttpResponse<?>) p);
      return new View<>(raw, body, prev);
    }
  }

  private <T> Exchange<T> exchange(HttpRequest request, BodyHandler<T> handler,
      Recorder recorder, boolean signed, HttpResponse<T> prior)
      throws IOException, InterruptedException {
    BodyHandler<Object> wrapping = info -> buffer(info.statusCode())
        ? BodySubscribers.mapping(BodySubscribers.ofByteArray(), bytes -> (Object) new Buffered(bytes))
        : BodySubscribers.mapping(handler.apply(info), body -> (Object) body);
    HttpResponse<Object> raw = delegate.send(request, wrapping);
    boolean hasBody = request.bodyPublisher().isPresent();
    if (hostPolicy == null) {
      return new Exchange<>(raw, prior, request, hasBody);
    }
    HttpRequest current = request;
    HttpResponse<T> previous = prior;
    for (int hops = 0; hops < MAX_REDIRECTS && isRedirect(raw.statusCode()); hops++) {
      HttpRequest next = redirect(current, raw, recorder, signed);
      if (next == null) {
        break;
      }
      hasBody = hasBody && raw.statusCode() != 303 && next.method().equals(current.method());
      previous = new View<>(raw, null, Optional.ofNullable(previous));
      current = next;
      raw = delegate.send(current, wrapping);
    }
    return new Exchange<>(raw, previous, current, hasBody);
  }

  /** Whether a request's recorded body can be sent again; an empty body always can. */
  private static boolean replayable(HttpRequest request, Recorder recorder) {
    return recorder.replayable()
        || request.bodyPublisher().map(p -> p.contentLength() == 0).orElse(false);
  }

  private boolean buffer(int status) {
    return status == 402 || (hostPolicy != null && isRedirect(status));
  }

  private static boolean isRedirect(int status) {
    return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
  }

  private HttpRequest redirect(HttpRequest current, HttpResponse<Object> response,
      Recorder recorder, boolean signed) {
    Optional<String> location = response.headers().firstValue("Location");
    if (location.isEmpty()) {
      return null;
    }
    URI target = current.uri().resolve(location.get());
    String scheme = target.getScheme();
    if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))
        || ("https".equalsIgnoreCase(current.uri().getScheme())
            && "http".equalsIgnoreCase(scheme))) {
      return null;
    }
    if (signed && !hostPolicy.allows(target)) {
      LOG.log(System.Logger.Level.WARNING, "[x402] not following the redirect of a paid request "
          + "to " + target.getHost() + ": not in the host policy");
      return null;
    }
    int status = response.statusCode();
    String method = current.method();
    BodyPublisher body;
    if (status == 303 || ((status == 301 || status == 302) && "POST".equals(method))) {
      method = "GET";
      body = BodyPublishers.noBody();
    } else if (current.bodyPublisher().isEmpty()) {
      body = BodyPublishers.noBody();
    } else if (replayable(current, recorder)) {
      body = BodyPublishers.ofByteArray(recorder.bytes());
    } else {
      return null;
    }
    if (!sameOrigin(current.uri(), target)) {
      // Never carry credentials (or a payment) to another origin, as browsers' fetch does.
      return HttpRequest.newBuilder(current,
              (name, value) -> !CROSS_ORIGIN_STRIPPED.contains(name.toLowerCase(Locale.ROOT)))
          .uri(target).method(method, body).build();
    }
    return copy(current, target, method, body);
  }

  /** Headers dropped when a redirect leaves the origin (scheme, host, port). */
  private static final Set<String> CROSS_ORIGIN_STRIPPED = Set.of("authorization", "cookie",
      "proxy-authorization", "x-api-key", "payment-signature", "x-payment");

  private static boolean sameOrigin(URI a, URI b) {
    return a.getScheme() != null && a.getScheme().equalsIgnoreCase(b.getScheme())
        && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost())
        && effectivePort(a) == effectivePort(b);
  }

  private static int effectivePort(URI uri) {
    if (uri.getPort() != -1) {
      return uri.getPort();
    }
    return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
  }

  private static HttpRequest copy(HttpRequest request, URI uri, String method,
      BodyPublisher body) {
    return HttpRequest.newBuilder(request, (name, value) -> true).uri(uri).method(method, body)
        .build();
  }

  private static URI parseUri(String value) {
    try {
      return URI.create(value);
    } catch (IllegalArgumentException e) {
      return null;
    }
  }

  private static ResponseInfo info(HttpResponse<?> raw) {
    return new ResponseInfo() {
      @Override
      public int statusCode() {
        return raw.statusCode();
      }

      @Override
      public HttpHeaders headers() {
        return raw.headers();
      }

      @Override
      public Version version() {
        return raw.version();
      }
    };
  }

  private static <T> T replay(BodyHandler<T> handler, ResponseInfo info, byte[] bytes)
      throws IOException, InterruptedException {
    BodySubscriber<T> subscriber = handler.apply(info);
    subscriber.onSubscribe(new Flow.Subscription() {
      @Override
      public void request(long n) {
        // the whole body is pushed below
      }

      @Override
      public void cancel() {
        // nothing to release
      }
    });
    if (bytes.length > 0) {
      subscriber.onNext(List.of(ByteBuffer.wrap(bytes)));
    }
    subscriber.onComplete();
    try {
      return subscriber.getBody().toCompletableFuture().get();
    } catch (ExecutionException e) {
      throw new IOException(e.getCause());
    }
  }

  /** A response with a substituted body and redirect chain. */
  private static final class View<T> implements HttpResponse<T> {
    private final HttpResponse<?> raw;
    private final T body;
    private final Optional<HttpResponse<T>> previous;

    View(HttpResponse<?> raw, T body, Optional<HttpResponse<T>> previous) {
      this.raw = raw;
      this.body = body;
      this.previous = previous;
    }

    @Override
    public int statusCode() {
      return raw.statusCode();
    }

    @Override
    public HttpRequest request() {
      return raw.request();
    }

    @Override
    public Optional<HttpResponse<T>> previousResponse() {
      return previous;
    }

    @Override
    public HttpHeaders headers() {
      return raw.headers();
    }

    @Override
    public T body() {
      return body;
    }

    @Override
    public Optional<SSLSession> sslSession() {
      return raw.sslSession();
    }

    @Override
    public URI uri() {
      return raw.uri();
    }

    @Override
    public Version version() {
      return raw.version();
    }
  }

  /** Records a request body while it is sent, up to a limit. */
  private static final class Recorder {
    private final long max;
    private ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private boolean overflow;
    private boolean complete;
    private boolean failed;

    Recorder(long max) {
      this.max = max;
    }

    synchronized void start() {
      buffer = new ByteArrayOutputStream();
      overflow = false;
      complete = false;
      failed = false;
    }

    synchronized void record(ByteBuffer item) {
      if (overflow) {
        return;
      }
      int n = item.remaining();
      if (buffer.size() + (long) n > max) {
        overflow = true;
        buffer = new ByteArrayOutputStream();
        return;
      }
      byte[] chunk = new byte[n];
      item.duplicate().get(chunk);
      buffer.write(chunk, 0, n);
    }

    synchronized void complete() {
      complete = true;
    }

    synchronized void fail() {
      failed = true;
    }

    synchronized boolean replayable() {
      return complete && !overflow && !failed;
    }

    synchronized byte[] bytes() {
      return buffer.toByteArray();
    }
  }

  /** Forwards a body publisher while recording what it publishes. */
  private static final class RecordingPublisher implements BodyPublisher {
    private final BodyPublisher delegate;
    private final Recorder recorder;

    RecordingPublisher(BodyPublisher delegate, Recorder recorder) {
      this.delegate = delegate;
      this.recorder = recorder;
    }

    @Override
    public long contentLength() {
      return delegate.contentLength();
    }

    @Override
    public void subscribe(Flow.Subscriber<? super ByteBuffer> subscriber) {
      recorder.start();
      delegate.subscribe(new Flow.Subscriber<ByteBuffer>() {
        @Override
        public void onSubscribe(Flow.Subscription subscription) {
          subscriber.onSubscribe(subscription);
        }

        @Override
        public void onNext(ByteBuffer item) {
          recorder.record(item);
          subscriber.onNext(item);
        }

        @Override
        public void onError(Throwable throwable) {
          recorder.fail();
          subscriber.onError(throwable);
        }

        @Override
        public void onComplete() {
          recorder.complete();
          subscriber.onComplete();
        }
      });
    }
  }
}
