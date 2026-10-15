package org.x402.spring.client.reactive;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.reactivestreams.Publisher;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.reactive.ClientHttpRequest;
import org.springframework.http.client.reactive.ClientHttpRequestDecorator;
import org.springframework.util.ClassUtils;
import org.springframework.web.reactive.function.BodyInserter;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.x402.core.client.ClientHooks.PaymentResponseContext;
import org.x402.core.client.X402Client;
import org.x402.core.client.X402ClientException;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.SettleResponse;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.client.TransportRedirects;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Pays x402 402s for a {@code WebClient}. The request body is recorded while
 * the first request is sent, up to {@code maxReplayBody}; a body that was larger or could not be
 * recorded gets the 402 back unpaid. Only hosts allowed by the {@link HostPolicy} trigger a payment
 * (request URI and {@code PAYMENT-REQUIRED.resource.url}). Signing runs on {@code
 * boundedElastic}; the first response is released before the retry. The paid request is marked in
 * the Reactor context so {@link X402ClientHttpConnector} sends it without following redirects, and
 * it is refused when a Reactor Netty connector would follow a redirect.
 */
public final class X402ExchangeFilterFunction implements ExchangeFilterFunction {

  /** Request attribute set by {@link X402ClientHttpConnector}: paid exchanges use its twin. */
  public static final String TWIN_CONNECTOR =
      X402ExchangeFilterFunction.class.getName() + ".TWIN";

  /** Reactor context key marking the paid exchange. */
  public static final String PAID_REQUEST = X402ExchangeFilterFunction.class.getName() + ".PAID";

  private static final Log LOG = LogFactory.getLog(X402ExchangeFilterFunction.class);
  private static final List<String> BODY_HEADERS = List.of(HttpHeaders.CONTENT_TYPE,
      HttpHeaders.CONTENT_ENCODING, HttpHeaders.CONTENT_LANGUAGE);
  private static final boolean REACTOR_NETTY = ClassUtils.isPresent(
      "reactor.netty.http.client.HttpClientRequest",
      X402ExchangeFilterFunction.class.getClassLoader());

  private final X402Client client;
  private final HostPolicy hostPolicy;
  private final long maxReplayBody;
  private final TransportRedirects.Safety declared;

  /**
   * Creates the filter.
   *
   * @param client the payment client
   * @param hostPolicy the hosts that may trigger a payment
   * @param maxReplayBody the largest body that can be re-sent with payment, in bytes
   */
  public X402ExchangeFilterFunction(X402Client client, HostPolicy hostPolicy,
      long maxReplayBody) {
    this(client, hostPolicy, maxReplayBody, TransportRedirects.Safety.UNKNOWN);
  }

  private X402ExchangeFilterFunction(X402Client client, HostPolicy hostPolicy,
      long maxReplayBody, TransportRedirects.Safety declared) {
    this.client = Objects.requireNonNull(client, "client");
    this.hostPolicy = Objects.requireNonNull(hostPolicy, "hostPolicy");
    this.maxReplayBody = maxReplayBody;
    this.declared = declared;
  }

  /**
   * The same filter for a WebClient whose connector was inspected.
   *
   * @param safety what is known about the connector's redirect handling
   * @return a filter that trusts that knowledge
   */
  public X402ExchangeFilterFunction forTransport(TransportRedirects.Safety safety) {
    return new X402ExchangeFilterFunction(client, hostPolicy, maxReplayBody, safety);
  }

  @Override
  public Mono<ClientResponse> filter(ClientRequest request, ExchangeFunction next) {
    if (!hostPolicy.allows(request.url())) {
      // Never paid, so never re-sent: no body recording, no probe.
      return next.exchange(request);
    }
    Recorder recorder = new Recorder(maxReplayBody);
    Probe probe = new Probe();
    Consumer<ClientHttpRequest> existing = request.httpRequest();
    ClientRequest first = ClientRequest.from(request).body(recording(request.body(), recorder))
        .httpRequest(existing == null ? probe : existing.andThen(probe))
        .build();
    return next.exchange(first).flatMap(response -> response.statusCode().value() == 402
        ? paymentRequired(request, recorder, probe, response, next) : Mono.just(response));
  }

  private TransportRedirects.Safety safety(Probe probe) {
    TransportRedirects.Safety seen = probe.safety;
    if (declared == TransportRedirects.Safety.FOLLOWS || seen == TransportRedirects.Safety.FOLLOWS) {
      return TransportRedirects.Safety.FOLLOWS;
    }
    if (declared == TransportRedirects.Safety.SAFE || seen == TransportRedirects.Safety.SAFE) {
      return TransportRedirects.Safety.SAFE;
    }
    return TransportRedirects.Safety.UNKNOWN;
  }

  private Mono<ClientResponse> paymentRequired(ClientRequest request, Recorder recorder,
      Probe probe, ClientResponse unpaid, ExchangeFunction next) {
    if (!hostPolicy.allows(request.url())) {
      LOG.debug("x402: 402 from " + request.url().getHost() + " is not in x402.client.hosts; "
          + "returned unpaid");
      return Mono.just(unpaid);
    }
    String header = unpaid.headers().asHttpHeaders().getFirst(X402Headers.PAYMENT_REQUIRED);
    if (header == null || header.isEmpty()) {
      return Mono.just(unpaid);
    }
    PaymentRequired required;
    try {
      required = HeaderCodec.decodePaymentRequired(header);
    } catch (IllegalArgumentException e) {
      return unpaid.releaseBody().then(Mono.error(new X402ClientException(
          "Failed to parse payment requirements: " + e.getMessage(), e)));
    }
    if (required.resource() == null || required.resource().url() == null
        || !hostPolicy.allows(parse(required.resource().url()))) {
      LOG.debug("x402: resource.url " + (required.resource() == null ? null
          : required.resource().url()) + " is absent or not in "
          + "x402.client.hosts; returned unpaid");
      return Mono.just(unpaid);
    }
    if (!recorder.replayable()) {
      LOG.warn("x402: " + request.method() + " " + request.url() + ": the request body exceeds "
          + "x402.client.max-replay-body (" + maxReplayBody + " bytes) or could not be "
          + "recorded; returning the 402 unpaid");
      return Mono.just(unpaid);
    }
    TransportRedirects.Safety safety = safety(probe);
    if (safety == TransportRedirects.Safety.FOLLOWS) {
      return unpaid.releaseBody().then(Mono.error(new X402ClientException(
          "x402: payment refused", new X402ClientException("the WebClient connector follows "
          + "redirects, which would forward PAYMENT-SIGNATURE to the redirect target; nothing "
          + "was signed. Configure the connector not to follow redirects, or build the "
          + "WebClient from Boot's WebClient.Builder."))));
    }
    if (safety == TransportRedirects.Safety.UNKNOWN) {
      LOG.warn("x402: cannot verify that the WebClient connector does not follow redirects; "
          + "returning the 402 from " + request.url().getHost() + " unpaid. Use a Reactor "
          + "Netty or JDK connector with redirects off, or Boot's WebClient.Builder.");
      return Mono.just(unpaid);
    }
    if (request.headers().containsKey(X402Headers.PAYMENT_SIGNATURE)
        || request.headers().containsKey(X402Headers.X_PAYMENT)) {
      return unpaid.releaseBody().then(Mono.error(
          new X402ClientException("Payment already attempted")));
    }
    return create(required)
        .onErrorResume(e -> unpaid.releaseBody().then(Mono.error(e)))
        .doOnCancel(() -> unpaid.releaseBody().subscribe())
        .flatMap(payload -> unpaid.releaseBody()
            .then(sendPaid(request, recorder, payload, next))
            .flatMap(paid -> recovered(payload, paid)
                .onErrorResume(e -> paid.releaseBody().then(Mono.error(e)))
                .flatMap(again -> again
                    ? paid.releaseBody().then(create(required))
                        .flatMap(fresh -> sendPaid(request, recorder, fresh, next)
                            .flatMap(retry -> recovered(fresh, retry)
                                .onErrorResume(e -> retry.releaseBody().then(Mono.error(e)))
                                .thenReturn(retry)))
                    : Mono.just(paid))));
  }

  private Mono<PaymentPayload> create(PaymentRequired required) {
    return Mono.fromCallable(() -> {
      try {
        return client.createPaymentPayload(required);
      } catch (RuntimeException e) {
        throw new X402ClientException("Failed to create payment payload: " + e.getMessage(), e);
      }
    }).subscribeOn(Schedulers.boundedElastic());
  }

  private Mono<ClientResponse> sendPaid(ClientRequest request, Recorder recorder,
      PaymentPayload payload, ExchangeFunction next) {
    Consumer<ClientHttpRequest> existing = request.httpRequest();
    Consumer<ClientHttpRequest> guard = X402ExchangeFilterFunction::refuseRedirectingTransport;
    BodyInserter<?, ? super ClientHttpRequest> body = request.body();
    if (recorder.hasBody()) {
      body = replay(recorder.bytes(), recorder.headers());
    }
    ClientRequest paid = ClientRequest.from(request)
        .header(X402Headers.PAYMENT_SIGNATURE, HeaderCodec.encodePaymentSignature(payload))
        .body(body)
        .httpRequest(existing == null ? guard : existing.andThen(guard))
        .build();
    return next.exchange(paid).contextWrite(ctx -> ctx.put(PAID_REQUEST, Boolean.TRUE));
  }

  private Mono<Boolean> recovered(PaymentPayload payload, ClientResponse response) {
    return Mono.fromCallable(() -> {
      SettleResponse settle = null;
      PaymentRequired again = null;
      String receipt = response.headers().asHttpHeaders().getFirst(X402Headers.PAYMENT_RESPONSE);
      try {
        settle = receipt == null ? null : HeaderCodec.decodePaymentResponse(receipt);
      } catch (IllegalArgumentException e) {
        settle = null;
      }
      if (settle == null && response.statusCode().value() == 402) {
        String header = response.headers().asHttpHeaders()
            .getFirst(X402Headers.PAYMENT_REQUIRED);
        try {
          again = header == null ? null : HeaderCodec.decodePaymentRequired(header);
        } catch (IllegalArgumentException e) {
          again = null;
        }
      }
      return client.handlePaymentResponse(
          new PaymentResponseContext(payload, payload.accepted(), settle, again, null));
    }).subscribeOn(Schedulers.boundedElastic());
  }

  /** A paid request must never travel over a transport that follows redirects. */
  static void refuseRedirectingTransport(ClientHttpRequest request) {
    if (REACTOR_NETTY && ReactorNetty.followsRedirects(request.getNativeRequest())) {
      throw new X402ClientException("x402: the WebClient connector follows redirects, which "
          + "would forward PAYMENT-SIGNATURE to the redirect target; the paid request is not "
          + "sent. Configure the connector not to follow redirects, or build the WebClient from "
          + "Boot's WebClient.Builder.");
    }
  }

  /** Records what the first request's transport revealed. */
  static final class Probe implements Consumer<ClientHttpRequest> {
    private volatile TransportRedirects.Safety safety = TransportRedirects.Safety.UNKNOWN;

    @Override
    public void accept(ClientHttpRequest request) {
      if (Boolean.TRUE.equals(request.getAttributes().get(TWIN_CONNECTOR))) {
        safety = TransportRedirects.Safety.SAFE;
      } else if (REACTOR_NETTY && ReactorNetty.isRequest(request.getNativeRequest())) {
        safety = ReactorNetty.followsRedirects(request.getNativeRequest())
            ? TransportRedirects.Safety.FOLLOWS : TransportRedirects.Safety.SAFE;
      }
    }
  }

  /** Isolates the optional Reactor Netty types. */
  static final class ReactorNetty {
    private ReactorNetty() {}

    static boolean isRequest(Object nativeRequest) {
      return nativeRequest instanceof reactor.netty.http.client.HttpClientRequest;
    }

    static boolean followsRedirects(Object nativeRequest) {
      return nativeRequest instanceof reactor.netty.http.client.HttpClientRequest r
          && r.isFollowRedirect();
    }
  }

  private static BodyInserter<Object, ClientHttpRequest> replay(byte[] bytes,
      HttpHeaders writerHeaders) {
    return (ClientHttpRequest message, BodyInserter.Context context) -> {
      writerHeaders.forEach((name, values) -> {
        if (!message.getHeaders().containsKey(name)) {
          message.getHeaders().put(name, values);
        }
      });
      return message.writeWith(Mono.fromSupplier(() -> message.bufferFactory().wrap(bytes)));
    };
  }

  private static BodyInserter<?, ? super ClientHttpRequest> recording(
      BodyInserter<?, ? super ClientHttpRequest> original, Recorder recorder) {
    return (ClientHttpRequest message, BodyInserter.Context context) ->
        original.insert(new ClientHttpRequestDecorator(message) {
          @Override
          public Mono<Void> writeWith(Publisher<? extends DataBuffer> body) {
            recorder.start();
            recorder.headers(getHeaders());
            return super.writeWith(Flux.from(body).doOnNext(recorder::record)
                .doOnComplete(recorder::complete));
          }

          @Override
          public Mono<Void> writeAndFlushWith(
              Publisher<? extends Publisher<? extends DataBuffer>> body) {
            recorder.start();
            recorder.headers(getHeaders());
            return super.writeAndFlushWith(Flux.from(body)
                .map(part -> Flux.from(part).doOnNext(recorder::record))
                .doOnComplete(recorder::complete));
          }
        }, context);
  }

  private static URI parse(String url) {
    try {
      return URI.create(url);
    } catch (IllegalArgumentException e) {
      return null;
    }
  }

  /** Records the bytes of the first send. */
  static final class Recorder {
    private final long max;
    private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    private boolean started;
    private boolean complete;
    private boolean overflow;
    private final HttpHeaders headers = new HttpHeaders();

    Recorder(long max) {
      this.max = max;
    }

    synchronized void start() {
      started = true;
      complete = false;
      overflow = false;
      bytes.reset();
    }

    synchronized void record(DataBuffer buffer) {
      if (overflow) {
        return;
      }
      int length = buffer.readableByteCount();
      if (bytes.size() + (long) length > max) {
        overflow = true;
        bytes.reset();
        return;
      }
      byte[] copy = new byte[length];
      int position = buffer.readPosition();
      buffer.read(copy);
      buffer.readPosition(position);
      bytes.write(copy, 0, copy.length);
    }

    synchronized void complete() {
      complete = true;
    }

    synchronized boolean replayable() {
      return !started || (complete && !overflow);
    }

    /** The body-related headers the body writer set (Content-Type with boundary, …). */
    synchronized void headers(HttpHeaders written) {
      headers.clear();
      for (String name : BODY_HEADERS) {
        List<String> values = written.get(name);
        if (values != null) {
          headers.put(name, List.copyOf(values));
        }
      }
    }

    synchronized HttpHeaders headers() {
      HttpHeaders copy = new HttpHeaders();
      copy.putAll(headers);
      return copy;
    }

    synchronized boolean hasBody() {
      return started;
    }

    synchronized byte[] bytes() {
      return bytes.toByteArray();
    }
  }
}
