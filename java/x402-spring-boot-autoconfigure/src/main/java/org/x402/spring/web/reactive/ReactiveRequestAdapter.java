package org.x402.spring.web.reactive;

import org.springframework.http.server.reactive.ServerHttpRequest;
import org.x402.http.HttpAdapter;
import org.x402.spring.offer.OfferSelection;

/** The x402 view of a reactive request, carrying the offer Spring's handler lookup selected. */
final class ReactiveRequestAdapter implements HttpAdapter, OfferSelection {

  private final ServerHttpRequest request;
  private final String rawPath;
  private final String offer;
  private final String pattern;
  private final boolean paywall;

  ReactiveRequestAdapter(ServerHttpRequest request, String rawPath, String offer, String pattern,
      boolean paywall) {
    this.request = request;
    this.rawPath = rawPath;
    this.offer = offer;
    this.pattern = pattern;
    this.paywall = paywall;
  }

  @Override
  public String getHeader(String name) {
    return request.getHeaders().getFirst(name);
  }

  @Override
  public String getMethod() {
    return request.getMethod().name();
  }

  @Override
  public String getPath() {
    return rawPath;
  }

  @Override
  public String getUrl() {
    return request.getURI().toString();
  }

  @Override
  public String getUserAgent() {
    return paywall ? HttpAdapter.super.getUserAgent() : "";
  }

  @Override
  public String selectedOffer() {
    return offer;
  }

  @Override
  public String selectedPattern() {
    return pattern;
  }
}
