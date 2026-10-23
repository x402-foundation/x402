package org.x402.spring.client.servlet;

import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.x402.core.client.X402Client;
import org.x402.http.HostPolicy;
import org.x402.spring.client.TransportRedirects;

/**
 * Decorates request factories with the configured payment client and {@code x402.client.hosts}.
 * Inject it to build a self-built {@code RestClient} or {@code RestTemplate} that pays: {@code
 * RestClient.builder().requestFactory(x402Decorator.decorate(factory, noRedirects)).build()}.
 */
public final class X402ClientHttpRequestFactoryDecorator {

  private static final Log LOG = LogFactory.getLog(X402ClientHttpRequestFactoryDecorator.class);

  private final X402Client client;
  private final HostPolicy hostPolicy;
  private final long maxReplayBody;

  /**
   * Creates the decorator with the default replay limit (1 MB).
   *
   * @param client the payment client
   * @param hostPolicy the hosts allowed to trigger a payment
   */
  public X402ClientHttpRequestFactoryDecorator(X402Client client, HostPolicy hostPolicy) {
    this(client, hostPolicy, X402ClientHttpRequestFactory.DEFAULT_MAX_REPLAY_BODY);
  }

  /**
   * Creates the decorator.
   *
   * @param client the payment client
   * @param hostPolicy the hosts allowed to trigger a payment
   * @param maxReplayBody the largest request body, in bytes, kept for re-sending with payment;
   *     a larger body is streamed and its 402 returned unpaid
   */
  public X402ClientHttpRequestFactoryDecorator(X402Client client, HostPolicy hostPolicy,
      long maxReplayBody) {
    this.client = client;
    this.hostPolicy = hostPolicy;
    this.maxReplayBody = maxReplayBody;
  }

  /**
   * Decorates a factory (idempotent). Paid requests go through the same factory, so it must be
   * verifiably non-redirecting: a JDK client with {@code Redirect.NEVER}, a Reactor Netty client
   * without redirect following, or {@code SimpleClientHttpRequestFactory} (redirects are switched
   * off on the paid connection). Over a factory known to follow redirects a payment is refused;
   * over one that cannot be verified the 402 is returned unpaid. Both are logged at startup.
   * Prefer {@link #decorate(ClientHttpRequestFactory, ClientHttpRequestFactory)}.
   *
   * @param factory the transport
   * @return the paying factory
   */
  public ClientHttpRequestFactory decorate(ClientHttpRequestFactory factory) {
    return warn(X402ClientHttpRequestFactory.checked(factory, factory, client, hostPolicy,
        X402ClientHttpRequestFactory.Check.STRICT, maxReplayBody));
  }

  /**
   * Decorates a factory; paid requests go through {@code nonRedirectingFactory}, and a 3xx answer
   * to them is returned to the caller unfollowed. A paid factory known to follow redirects
   * refuses payments.
   *
   * @param factory the transport for the first request
   * @param nonRedirectingFactory the same transport configured not to follow redirects
   * @return the paying factory
   */
  public ClientHttpRequestFactory decorate(ClientHttpRequestFactory factory,
      ClientHttpRequestFactory nonRedirectingFactory) {
    return warn(X402ClientHttpRequestFactory.checked(factory, nonRedirectingFactory, client,
        hostPolicy, X402ClientHttpRequestFactory.Check.LENIENT, maxReplayBody));
  }

  private static ClientHttpRequestFactory warn(ClientHttpRequestFactory decorated) {
    if (decorated instanceof X402ClientHttpRequestFactory x402 && x402.refusesPayment()) {
      LOG.warn("x402: " + (x402.paidTransportSafety() == TransportRedirects.Safety.FOLLOWS
          ? "the transport for paid requests follows redirects; payments are refused"
          : "cannot verify that the transport for paid requests does not follow redirects; "
              + "402s are returned unpaid")
          + ". Use x402Decorator.decorate(factory, nonRedirectingFactory) with the same "
          + "transport configured not to follow redirects.");
    }
    return decorated;
  }
}
