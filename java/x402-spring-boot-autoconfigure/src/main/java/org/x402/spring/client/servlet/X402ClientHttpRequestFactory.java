package org.x402.spring.client.servlet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.URI;
import java.util.Objects;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.client.AbstractClientHttpRequest;
import org.springframework.http.client.ClientHttpRequest;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
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

/**
 * A {@link ClientHttpRequestFactory} decorator that pays x402 402s. It sits below
 * every interceptor: the paid retry re-sends the request as the interceptors prepared it, plus
 * {@code PAYMENT-SIGNATURE}; interceptors do not run again (a step that signs all headers cannot
 * cover {@code PAYMENT-SIGNATURE}). Only hosts allowed by the {@link HostPolicy} can trigger a
 * payment, checked on the request URI and on {@code PAYMENT-REQUIRED.resource.url}; anything else
 * returns the 402 unchanged, with nothing signed. The first 402 is closed before the retry. The
 * paid request does not follow redirects; the one exception is an http to https redirect on the
 * same host (allowed by the policy), which is re-sent once with the payment. A second redirect
 * of the paid leg throws {@link X402ClientException}; any other redirect is returned as is.
 */
public final class X402ClientHttpRequestFactory implements ClientHttpRequestFactory {

  private static final Log LOG = LogFactory.getLog(X402ClientHttpRequestFactory.class);

  /** The default {@code x402.client.max-replay-body}: 1 MB. */
  static final long DEFAULT_MAX_REPLAY_BODY = 1024L * 1024L;

  /** How the paid transport is checked before signing. */
  enum Check {
    /** The caller asserts a non-redirecting paid transport (static {@code wrap}). */
    TRUSTED,
    /** Pay only over a transport verified not to follow redirects. */
    STRICT,
    /** Refuse only a transport known to follow redirects. */
    LENIENT
  }

  private final ClientHttpRequestFactory delegate;
  private final ClientHttpRequestFactory paidDelegate;
  private final X402Client client;
  private final HostPolicy hostPolicy;
  private final Check check;
  private final TransportRedirects.Safety safety;
  private final long maxReplayBody;

  private X402ClientHttpRequestFactory(ClientHttpRequestFactory delegate,
      ClientHttpRequestFactory paidDelegate, X402Client client, HostPolicy hostPolicy,
      Check check, long maxReplayBody) {
    this.maxReplayBody = maxReplayBody;
    this.delegate = Objects.requireNonNull(delegate, "delegate");
    this.paidDelegate = Objects.requireNonNull(paidDelegate, "paidDelegate");
    this.client = Objects.requireNonNull(client, "client");
    this.hostPolicy = Objects.requireNonNull(hostPolicy, "hostPolicy");
    this.check = check;
    this.safety = check == Check.TRUSTED ? TransportRedirects.Safety.SAFE
        : TransportRedirects.of(paidDelegate);
  }

  static ClientHttpRequestFactory checked(ClientHttpRequestFactory factory,
      ClientHttpRequestFactory paidFactory, X402Client client, HostPolicy hostPolicy,
      Check check, long maxReplayBody) {
    if (factory instanceof X402ClientHttpRequestFactory) {
      return factory;
    }
    return new X402ClientHttpRequestFactory(factory, paidFactory, client, hostPolicy, check,
        maxReplayBody);
  }

  /**
   * What is known about the paid transport's redirect handling.
   *
   * @return the safety ({@code SAFE} for the trusting static {@code wrap})
   */
  public TransportRedirects.Safety paidTransportSafety() {
    return safety;
  }

  /**
   * Whether this factory refuses to sign over its paid transport.
   *
   * @return {@code true} when payments are refused or returned unpaid
   */
  boolean refusesPayment() {
    return check == Check.STRICT ? safety != TransportRedirects.Safety.SAFE
        : safety == TransportRedirects.Safety.FOLLOWS;
  }

  /**
   * Decorates a factory that also sends the paid request; an already decorated factory is
   * returned as is. The caller asserts that {@code factory} does not follow redirects; nothing
   * is checked, and a redirect would forward {@code PAYMENT-SIGNATURE}. The Spring-facing {@link
   * X402ClientHttpRequestFactoryDecorator} checks the transport and fails closed.
   *
   * @param factory the transport (keeps its TLS, proxy and timeout settings)
   * @param client the payment client
   * @param hostPolicy the hosts that may trigger a payment
   * @return the paying factory
   */
  public static ClientHttpRequestFactory wrap(ClientHttpRequestFactory factory, X402Client client,
      HostPolicy hostPolicy) {
    return wrap(factory, factory, client, hostPolicy);
  }

  /**
   * Decorates a factory; the request carrying {@code PAYMENT-SIGNATURE} goes through {@code
   * paidFactory}, which the caller asserts does not follow redirects (a 3xx answer to a paid
   * request is then returned to the caller as is). Nothing is checked.
   *
   * @param factory the transport for the first (unpaid) request
   * @param paidFactory the same transport configured not to follow redirects
   * @param client the payment client
   * @param hostPolicy the hosts that may trigger a payment
   * @return the paying factory
   */
  public static ClientHttpRequestFactory wrap(ClientHttpRequestFactory factory,
      ClientHttpRequestFactory paidFactory, X402Client client, HostPolicy hostPolicy) {
    return checked(factory, paidFactory, client, hostPolicy, Check.TRUSTED, DEFAULT_MAX_REPLAY_BODY);
  }

  /**
   * The transport of paid requests.
   *
   * @return the paid delegate
   */
  public ClientHttpRequestFactory paidDelegate() {
    return paidDelegate;
  }

  /**
   * The decorated transport.
   *
   * @return the delegate
   */
  public ClientHttpRequestFactory delegate() {
    return delegate;
  }

  /**
   * The host allowlist.
   *
   * @return the policy
   */
  public HostPolicy hostPolicy() {
    return hostPolicy;
  }

  /**
   * A request to a host outside {@code x402.client.hosts} can never be paid, so it goes to the
   * transport unchanged and its body is streamed; others are buffered to be re-sent with payment.
   */
  @Override
  public ClientHttpRequest createRequest(URI uri, HttpMethod httpMethod) throws IOException {
    if (!hostPolicy.allows(uri)) {
      return delegate.createRequest(uri, httpMethod);
    }
    return new PayingRequest(uri, httpMethod);
  }

  /**
   * Buffers the body, sends, and pays a 402 once. A body larger than {@code maxReplayBody} cannot
   * be re-sent: it switches to a plain transport request and its answer is returned unpaid.
   */
  private final class PayingRequest extends AbstractClientHttpRequest {
    private final URI uri;
    private final HttpMethod method;
    private final ByteArrayOutputStream body = new ByteArrayOutputStream(256);
    private ClientHttpRequest streamed;

    PayingRequest(URI uri, HttpMethod method) {
      this.uri = uri;
      this.method = method;
    }

    @Override
    public HttpMethod getMethod() {
      return method;
    }

    @Override
    public URI getURI() {
      return uri;
    }

    @Override
    protected OutputStream getBodyInternal(HttpHeaders headers) {
      return new OutputStream() {
        @Override
        public void write(int b) throws IOException {
          write(new byte[] {(byte) b}, 0, 1);
        }

        @Override
        public void write(byte[] bytes, int off, int len) throws IOException {
          if (streamed == null && body.size() + (long) len > maxReplayBody) {
            streamed = delegate.createRequest(uri, method);
            streamed.getHeaders().putAll(headers);
            body.writeTo(streamed.getBody());
          }
          if (streamed != null) {
            streamed.getBody().write(bytes, off, len);
          } else {
            body.write(bytes, off, len);
          }
        }
      };
    }

    @Override
    protected ClientHttpResponse executeInternal(HttpHeaders headers) throws IOException {
      if (streamed != null) {
        LOG.debug("x402: request body to " + uri.getHost() + " exceeds x402.client.max-replay-body;"
            + " sent without payment");
        return streamed.execute();
      }
      byte[] bytes = body.toByteArray();
      ClientHttpResponse first = send(headers, bytes, null);
      if (first.getStatusCode().value() != 402) {
        return first;
      }
      if (!hostPolicy.allows(uri)) {
        LOG.debug("x402: 402 from " + uri.getHost() + " is not in x402.client.hosts; returned "
            + "unpaid");
        return first;
      }
      String header = first.getHeaders().getFirst(X402Headers.PAYMENT_REQUIRED);
      if (header == null || header.isEmpty()) {
        return first;
      }
      PaymentRequired required;
      try {
        required = HeaderCodec.decodePaymentRequired(header);
      } catch (IllegalArgumentException e) {
        first.close();
        throw new X402ClientException("Failed to parse payment requirements: " + e.getMessage(),
            e);
      }
      if (required.resource() == null || required.resource().url() == null
          || !hostPolicy.allows(parse(required.resource().url()))) {
        LOG.debug("x402: resource.url " + (required.resource() == null ? null
            : required.resource().url()) + " is absent or not in "
            + "x402.client.hosts; returned unpaid");
        return first;
      }
      if (refusesPayment()) {
        if (safety == TransportRedirects.Safety.FOLLOWS) {
          first.close();
          throw new X402ClientException("x402: payment refused", new X402ClientException(
              "the transport for paid requests follows redirects, which would forward "
              + "PAYMENT-SIGNATURE; nothing was signed. Use "
              + "x402Decorator.decorate(factory, nonRedirectingFactory)."));
        }
        LOG.warn("x402: cannot verify that the transport for paid requests does not follow "
            + "redirects; returning the 402 unpaid. Use "
            + "x402Decorator.decorate(factory, nonRedirectingFactory).");
        return first;
      }
      if (headers.containsKey(X402Headers.PAYMENT_SIGNATURE)
          || headers.containsKey(X402Headers.X_PAYMENT)) {
        first.close();
        throw new X402ClientException("Payment already attempted");
      }
      PaymentPayload payload = create(required, first);
      first.close();
      ClientHttpResponse paid = send(headers, bytes, payload);
      boolean again;
      try {
        again = recovered(payload, paid);
      } catch (IOException | RuntimeException e) {
        paid.close();
        throw e;
      }
      if (again) {
        paid.close();
        PaymentPayload fresh = create(required, null);
        ClientHttpResponse retry = send(headers, bytes, fresh);
        try {
          recovered(fresh, retry);
        } catch (IOException | RuntimeException e) {
          retry.close();
          throw e;
        }
        return retry;
      }
      return paid;
    }

    private PaymentPayload create(PaymentRequired required, ClientHttpResponse toClose) {
      try {
        return client.createPaymentPayload(required);
      } catch (RuntimeException e) {
        if (toClose != null) {
          toClose.close();
        }
        throw new X402ClientException("Failed to create payment payload: " + e.getMessage(), e);
      }
    }

    private ClientHttpResponse send(HttpHeaders headers, byte[] bytes, PaymentPayload payload)
        throws IOException {
      ClientHttpResponse response = sendTo(uri, method, headers, bytes, payload);
      if (payload == null) {
        return response;
      }
      // The paid request never follows redirects. One http to https redirect on the host the
      // caller chose is re-sent once with the payment: that is how an http URL that redirects to
      // https can be bought. Any other redirect is returned as is.
      URI target = TransportRedirects.paidRedirectTarget(uri, response.getStatusCode().value(),
          response.getHeaders(), hostPolicy);
      if (target == null) {
        return response;
      }
      int status = response.getStatusCode().value();
      response.close();
      boolean toGet = TransportRedirects.toGet(status, method);
      HttpHeaders next = new HttpHeaders();
      next.putAll(headers);
      if (toGet) {
        TransportRedirects.BODY_HEADERS.forEach(next::remove);
      }
      ClientHttpResponse second = sendTo(target, toGet ? HttpMethod.GET : method, next,
          toGet ? new byte[0] : bytes, payload);
      if (TransportRedirects.isRedirect(second.getStatusCode().value())) {
        String location = second.getHeaders().getFirst(HttpHeaders.LOCATION);
        second.close();
        throw TransportRedirects.redirectedAgain(target, location);
      }
      return second;
    }

    private ClientHttpResponse sendTo(URI to, HttpMethod verb, HttpHeaders headers, byte[] bytes,
        PaymentPayload payload) throws IOException {
      ClientHttpRequest request = (payload == null ? delegate : paidDelegate)
          .createRequest(to, verb);
      request.getHeaders().putAll(headers);
      request.getAttributes().putAll(getAttributes());
      if (payload != null) {
        if (!TransportRedirects.disableOnPaidRequest(request) && check != Check.TRUSTED
            && paidDelegate instanceof SimpleClientHttpRequestFactory) {
          throw new X402ClientException("x402: payment refused", new X402ClientException(
              "redirects could not be switched off on the paid connection"));
        }
        request.getHeaders().set(X402Headers.PAYMENT_SIGNATURE,
            HeaderCodec.encodePaymentSignature(payload));
      }
      if (bytes.length > 0) {
        request.getBody().write(bytes);
      }
      return request.execute();
    }

    private boolean recovered(PaymentPayload payload, ClientHttpResponse response)
        throws IOException {
      SettleResponse settle = null;
      PaymentRequired again = null;
      String receipt = response.getHeaders().getFirst(X402Headers.PAYMENT_RESPONSE);
      try {
        settle = receipt == null ? null : HeaderCodec.decodePaymentResponse(receipt);
      } catch (IllegalArgumentException e) {
        settle = null;
      }
      if (settle == null && response.getStatusCode().value() == 402) {
        String header = response.getHeaders().getFirst(X402Headers.PAYMENT_REQUIRED);
        try {
          again = header == null ? null : HeaderCodec.decodePaymentRequired(header);
        } catch (IllegalArgumentException e) {
          again = null;
        }
      }
      return client.handlePaymentResponse(
          new PaymentResponseContext(payload, payload.accepted(), settle, again, null));
    }
  }

  private static URI parse(String url) {
    try {
      return URI.create(url);
    } catch (IllegalArgumentException e) {
      return null;
    }
  }
}
