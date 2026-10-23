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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.function.Predicate;
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

  /**
   * The most of an unpaid 402 body the wrapper holds while it decides whether to pay:
   * 64 KB. Any other response, a paid one included, streams into the caller's own handler.
   */
  static final int BODY_BUFFER_CAP = 64 * 1024;
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
    Exchange<T> exchange = exchange(recording, handler, recorder, false, null, null);
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
    // With a HostPolicy the paid retry goes to the policy-checked URI that answered 402 (the last
    // request of the redirect chain), never back to an unchecked first host.
    // Without one, the paid retry still targets the URI that answered 402 (after the delegate's
    // own redirects), with the method and body of the request that was answered: a 303 POST-to-GET
    // is not re-sent as a POST, and the caller's headers are not carried across origins.
    HttpRequest answered = raw.request();
    HttpRequest base = hostPolicy != null ? unpaid.last() : answeredBase(first, raw);
    boolean withBody = hostPolicy != null ? unpaid.lastHasBody()
        : answered == null ? first.bodyPublisher().isPresent()
            : answered.bodyPublisher().isPresent();
    // Only a retry that re-sends the body needs it recorded: after a 303 the paid GET has none.
    if (withBody && !replayable(first, recorder)) {
      LOG.log(System.Logger.Level.WARNING, "[x402] " + first.method() + " " + first.uri()
          + ": the request body exceeds max-replay-body (" + maxReplayBody
          + " bytes) or could not be recorded; returning the 402 unpaid");
      return unpaid.toResponse(handler);
    }
    if (first.headers().firstValue(X402Headers.PAYMENT_SIGNATURE).isPresent()
        || first.headers().firstValue(X402Headers.X_PAYMENT).isPresent()) {
      throw new X402ClientException("Payment already attempted");
    }
    HttpResponse<T> prior = hostPolicy != null
        ? new View<>(raw, null, Optional.ofNullable(unpaid.previous())) : null;
    PaymentPayload payload = create(required);
    // The retry decision is made from the paid response's headers, before its body is read, so
    // a response that is retried is drained and never reaches the caller's handler.
    Exchange<T> paid = exchange(signed(base, withBody, recorder, payload), handler, recorder,
        true, prior, info -> recovered(payload, info));
    if (paid.retry()) {
      PaymentPayload fresh = create(required);
      Exchange<T> retry = exchange(signed(base, withBody, recorder, fresh), handler, recorder,
          true, prior, info -> {
            recovered(fresh, info);
            return false;
          });
      return retry.toResponse(handler);
    }
    return paid.toResponse(handler);
  }

  /** The caller's request retargeted at the URI and method of the response that answered. */
  private static HttpRequest answeredBase(HttpRequest first, HttpResponse<?> raw) {
    HttpRequest answered = raw.request();
    if (answered == null) {
      return first;
    }
    URI target = raw.uri() != null ? raw.uri() : first.uri();
    boolean withBody = answered.bodyPublisher().isPresent();
    BodyPublisher body = withBody && first.bodyPublisher().isPresent()
        ? first.bodyPublisher().get() : BodyPublishers.noBody();
    boolean dropBodyHeaders = !withBody && first.bodyPublisher().isPresent();
    // The JDK forwards the caller's headers on a same-host http-to-https upgrade, so the unpaid
    // leg already carried them there; the paid retry keeps them too.
    boolean crossOrigin = !sameOrigin(first.uri(), target) && !secureUpgrade(first.uri(), target);
    return HttpRequest.newBuilder(first, (name, value) -> {
      String lower = name.toLowerCase(Locale.ROOT);
      return !(crossOrigin && CROSS_ORIGIN_STRIPPED.contains(lower))
          && !(dropBodyHeaders && BODY_HEADERS.contains(lower));
    }).uri(target).method(answered.method(), body).build();
  }

  private static final Set<String> BODY_HEADERS = Set.of("content-type", "content-encoding",
      "content-language");

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

  private boolean recovered(PaymentPayload payload, ResponseInfo info) {
    SettleResponse settle = decodeSettle(info.headers()).orElse(null);
    PaymentRequired again = null;
    if (settle == null && info.statusCode() == 402) {
      try {
        again = info.headers().firstValue(X402Headers.PAYMENT_REQUIRED)
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

  /**
   * One request with the redirects this client followed for it.
   *
   * @param raw the final response
   * @param previous the chain of earlier responses, or {@code null}
   * @param last the request that produced {@code raw}
   * @param lastHasBody whether {@code last} carries the original request body
   * @param retry whether the paid response asked for a fresh payment (its body was drained)
   */
  private record Exchange<T>(HttpResponse<Object> raw, HttpResponse<T> previous,
      HttpRequest last, boolean lastHasBody, boolean retry) {

    @SuppressWarnings("unchecked")
    HttpResponse<T> toResponse(BodyHandler<T> handler) throws IOException, InterruptedException {
      if (raw.body() instanceof X402HttpClientBoundedBody.Result b && b.overflow()) {
        throw new IOException("x402: the " + raw.statusCode() + " response from " + raw.uri()
            + " has a body over the " + BODY_BUFFER_CAP + "-byte buffer cap and is not returned "
            + "unpaid; it is only buffered while the client decides whether to pay");
      }
      T body = raw.body() instanceof X402HttpClientBoundedBody.Result b
          ? replay(handler, info(raw), b.bytes()) : (T) raw.body();
      Optional<HttpResponse<T>> prev = previous != null ? Optional.of(previous)
          : raw.previousResponse().map(p -> (HttpResponse<T>) (HttpResponse<?>) p);
      return new View<>(raw, body, prev);
    }
  }

  /**
   * Sends one request and, under a HostPolicy, the redirects this client follows for it.
   *
   * @param retryIf on a paid request, decides from the final response's headers whether to pay
   *     again; it runs on the calling thread (the payment hooks it calls may block or rely on the
   *     caller's context), while the response body waits unrequested
   */
  private <T> Exchange<T> exchange(HttpRequest request, BodyHandler<T> handler,
      Recorder recorder, boolean signed, HttpResponse<T> prior, Predicate<ResponseInfo> retryIf)
      throws IOException, InterruptedException {
    HttpRequest current = request;
    HttpResponse<T> previous = prior;
    boolean hasBody = carriesBody(request);
    for (int hops = 0; ; hops++) {
      Hop<T> hop = new Hop<>(current, handler, recorder, signed,
          hostPolicy != null && hops < MAX_REDIRECTS, retryIf != null);
      HttpResponse<Object> raw = delegate.send(current, hop);
      if (hop.gateUsed) {
        raw = openGate(raw, hop, retryIf);
      }
      HttpRequest next = hop.next;
      if (next == null) {
        return new Exchange<>(raw, previous, current, hasBody, hop.retry);
      }
      hasBody = hasBody && raw.statusCode() != 303 && next.method().equals(current.method());
      previous = new View<>(raw, null, Optional.ofNullable(previous));
      current = next;
    }
  }

  /**
   * Decides on the calling thread, from the final paid response's headers, where its body goes:
   * the payment hooks run here, never on the delegate's response thread. Until then the body is
   * not requested. A retried response, a failing hook or handler, and an interrupt cancel the
   * body instead of reading it.
   */
  private <T> HttpResponse<Object> openGate(HttpResponse<Object> raw, Hop<T> hop,
      Predicate<ResponseInfo> retryIf) throws IOException, InterruptedException {
    Gate gate = hop.gate;
    ResponseInfo info = info(raw);
    BodySubscriber<Object> target;
    try {
      hop.retry = retryIf.test(info);
      if (hop.retry) {
        gate.cancel(); // never read and never returned: the request is paid again
        return raw;
      }
      target = BodySubscribers.mapping(hop.handler.apply(info), body -> (Object) body);
    } catch (RuntimeException | Error e) {
      gate.cancel();
      throw e;
    }
    gate.open(target);
    Object body;
    try {
      body = target.getBody().toCompletableFuture().get();
    } catch (InterruptedException e) {
      gate.cancel();
      throw e;
    } catch (ExecutionException e) {
      Throwable cause = e.getCause();
      if (cause instanceof IOException io) {
        throw io;
      }
      throw new IOException(cause);
    }
    return new View<>(raw, body, raw.previousResponse());
  }

  /**
   * A body subscriber whose target is chosen later: it holds the subscription (requesting
   * nothing) and any signal that arrives early, and hands them over when opened. Its own body is
   * ready at once, as {@code BodyHandlers.ofInputStream()}'s is, so {@code send} returns with the
   * headers while the body waits.
   */
  private static final class Gate implements BodySubscriber<Object> {
    private final List<List<ByteBuffer>> early = new ArrayList<>();
    private BodySubscriber<Object> target;
    private Flow.Subscription subscription;
    private Throwable error;
    private boolean completed;
    private boolean cancelled;

    @Override
    public CompletionStage<Object> getBody() {
      return CompletableFuture.completedFuture(this);
    }

    @Override
    public synchronized void onSubscribe(Flow.Subscription s) {
      subscription = s;
      if (cancelled) {
        s.cancel();
      } else if (target != null) {
        target.onSubscribe(s);
      }
    }

    /** Stops the body: nothing more is read, and the connection is not kept for it. */
    synchronized void cancel() {
      cancelled = true;
      early.clear();
      if (subscription != null) {
        subscription.cancel();
      }
    }

    @Override
    public synchronized void onNext(List<ByteBuffer> items) {
      if (target != null) {
        target.onNext(items);
      } else {
        early.add(items); // only from a publisher that ignores demand
      }
    }

    @Override
    public synchronized void onError(Throwable t) {
      if (target != null) {
        target.onError(t);
      } else {
        error = t;
      }
    }

    @Override
    public synchronized void onComplete() {
      if (target != null) {
        target.onComplete();
      } else {
        completed = true;
      }
    }

    synchronized void open(BodySubscriber<Object> chosen) {
      target = chosen;
      if (subscription != null) {
        chosen.onSubscribe(subscription);
      }
      early.forEach(chosen::onNext);
      early.clear();
      if (error != null) {
        chosen.onError(error);
      } else if (completed) {
        chosen.onComplete();
      }
    }
  }

  /** Whether a request has a body to send: a publisher that is not known to be empty. */
  private static boolean carriesBody(HttpRequest request) {
    return request.bodyPublisher().map(p -> p.contentLength() != 0).orElse(false);
  }

  /** Whether a request's recorded body can be sent again; an empty body always can. */
  private static boolean replayable(HttpRequest request, Recorder recorder) {
    return recorder.replayable()
        || request.bodyPublisher().map(p -> p.contentLength() == 0).orElse(false);
  }

  /**
   * Decides what happens to one response's body from its status and headers, before any of it
   * is read:
   *
   * <ul>
   *   <li>a redirect this client will follow is drained (only its headers matter);
   *   <li>an unpaid 402 that can be paid (PAYMENT-REQUIRED, host on the policy) is held in memory
   *       up to the cap, because it is returned if the client then declines to pay;
   *   <li>the final paid response waits behind a {@link Gate} until the calling thread has run
   *       the payment hooks: drained when they ask for a fresh payment, else the caller's handler;
   *   <li>everything else streams into the caller's handler.
   * </ul>
   *
   * <p>The fields are written on the delegate's response thread and read after {@code send}
   * returns.
   */
  private final class Hop<T> implements BodyHandler<Object> {
    private final HttpRequest request;
    private final BodyHandler<T> handler;
    private final Recorder recorder;
    private final boolean signed;
    private final boolean mayRedirect;
    private final boolean gated;
    final Gate gate = new Gate();
    /** Whether the final response went behind {@link #gate}. */
    volatile boolean gateUsed;
    volatile HttpRequest next;
    volatile boolean retry;

    Hop(HttpRequest request, BodyHandler<T> handler, Recorder recorder, boolean signed,
        boolean mayRedirect, boolean gated) {
      this.request = request;
      this.handler = handler;
      this.recorder = recorder;
      this.signed = signed;
      this.mayRedirect = mayRedirect;
      this.gated = gated;
    }

    @Override
    public BodySubscriber<Object> apply(ResponseInfo info) {
      int status = info.statusCode();
      if (mayRedirect && isRedirect(status)) {
        next = redirect(request, status, info.headers(), recorder, signed);
        if (next != null) {
          return BodySubscribers.replacing(null);
        }
      }
      if (!signed && status == 402
          && info.headers().firstValue(X402Headers.PAYMENT_REQUIRED).isPresent()
          && (hostPolicy == null || hostPolicy.allows(request.uri()))) {
        return BodySubscribers.mapping(new X402HttpClientBoundedBody(BODY_BUFFER_CAP),
            result -> (Object) result);
      }
      if (gated) {
        gateUsed = true;
        return gate;
      }
      return BodySubscribers.mapping(handler.apply(info), body -> (Object) body);
    }
  }

  private static boolean isRedirect(int status) {
    return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
  }

  private HttpRequest redirect(HttpRequest current, int status, HttpHeaders headers,
      Recorder recorder, boolean signed) {
    Optional<String> location = headers.firstValue("Location");
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
    String method = current.method();
    BodyPublisher body;
    boolean toGet = status == 303 || ((status == 301 || status == 302) && "POST".equals(method));
    if (toGet) {
      method = "GET";
      body = BodyPublishers.noBody();
    } else if (!carriesBody(current)) {
      // Also a GET this client already made from a POST: its bytes never come back.
      body = BodyPublishers.noBody();
    } else if (recorder.replayable()) {
      body = BodyPublishers.ofByteArray(recorder.bytes());
    } else {
      return null;
    }
    boolean crossOrigin = !sameOrigin(current.uri(), target);
    // Never carry credentials (or a payment) to another origin, as browsers' fetch does; a body
    // dropped on the way to a GET takes its body headers with it, as in answeredBase().
    return HttpRequest.newBuilder(current, (name, value) -> {
      String lower = name.toLowerCase(Locale.ROOT);
      return !(crossOrigin && CROSS_ORIGIN_STRIPPED.contains(lower))
          && !(toGet && BODY_HEADERS.contains(lower));
    }).uri(target).method(method, body).build();
  }

  /** Headers dropped when a redirect leaves the origin (scheme, host, port). */
  private static final Set<String> CROSS_ORIGIN_STRIPPED = Set.of("authorization", "cookie",
      "proxy-authorization", "x-api-key", "payment-signature", "x-payment");

  private static boolean sameOrigin(URI a, URI b) {
    return a.getScheme() != null && a.getScheme().equalsIgnoreCase(b.getScheme())
        && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost())
        && effectivePort(a) == effectivePort(b);
  }

  /** A same-host upgrade from http on its default port to https on its default port. */
  private static boolean secureUpgrade(URI from, URI to) {
    return "http".equalsIgnoreCase(from.getScheme()) && "https".equalsIgnoreCase(to.getScheme())
        && from.getHost() != null && from.getHost().equalsIgnoreCase(to.getHost())
        && effectivePort(from) == 80 && effectivePort(to) == 443;
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
    // The body is one item: it goes out on the first request, as the subscriber's demand allows.
    subscriber.onSubscribe(new Flow.Subscription() {
      private boolean done;

      @Override
      public synchronized void request(long n) {
        if (done) {
          return;
        }
        done = true;
        if (n <= 0) {
          subscriber.onError(new IllegalArgumentException("non-positive request: " + n));
          return;
        }
        if (bytes.length > 0) {
          subscriber.onNext(List.of(ByteBuffer.wrap(bytes)));
        }
        subscriber.onComplete();
      }

      @Override
      public synchronized void cancel() {
        done = true;
      }
    });
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
