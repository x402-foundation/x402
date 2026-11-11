package org.x402.spring.client.reactive;

import java.net.URI;
import java.util.function.Function;
import org.springframework.http.HttpMethod;
import org.springframework.http.client.reactive.ClientHttpConnector;
import org.springframework.http.client.reactive.ClientHttpRequest;
import org.springframework.http.client.reactive.ClientHttpResponse;
import reactor.core.publisher.Mono;

/**
 * Two connectors built from the same settings: the paid exchange (marked by {@link
 * X402ExchangeFilterFunction#PAID_REQUEST} in the Reactor context) goes through the one that never
 * follows redirects, everything else through the configured one, so {@code PAYMENT-SIGNATURE}
 * never reaches a redirect target.
 */
public final class X402ClientHttpConnector implements ClientHttpConnector {

  private final ClientHttpConnector delegate;
  private final ClientHttpConnector paid;

  /**
   * Creates the connector.
   *
   * @param delegate the configured connector
   * @param paid the same connector without redirect following
   */
  public X402ClientHttpConnector(ClientHttpConnector delegate, ClientHttpConnector paid) {
    this.delegate = delegate;
    this.paid = paid;
  }

  /**
   * The configured connector.
   *
   * @return the delegate
   */
  public ClientHttpConnector delegate() {
    return delegate;
  }

  /**
   * The connector for paid requests.
   *
   * @return the non-redirecting connector
   */
  public ClientHttpConnector paid() {
    return paid;
  }

  @Override
  public Mono<ClientHttpResponse> connect(HttpMethod method, URI uri,
      Function<? super ClientHttpRequest, Mono<Void>> requestCallback) {
    Function<? super ClientHttpRequest, Mono<Void>> marking = request -> {
      request.getAttributes().put(X402ExchangeFilterFunction.TWIN_CONNECTOR, Boolean.TRUE);
      return requestCallback.apply(request);
    };
    return Mono.deferContextual(ctx -> (ctx.getOrDefault(X402ExchangeFilterFunction.PAID_REQUEST,
        Boolean.FALSE) ? paid : delegate).connect(method, uri, marking));
  }
}
