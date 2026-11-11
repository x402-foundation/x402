package org.x402.spring.web.servlet;

import jakarta.servlet.http.HttpServletRequest;
import org.x402.http.HttpAdapter;
import org.x402.spring.offer.OfferSelection;

/** The x402 view of a servlet request, carrying the offer Spring's handler lookup selected. */
final class ServletRequestAdapter implements HttpAdapter, OfferSelection {

  private final HttpServletRequest request;
  private final String rawPath;
  private final String offer;
  private final String pattern;
  private final boolean paywall;

  ServletRequestAdapter(HttpServletRequest request, String rawPath, String offer, String pattern,
      boolean paywall) {
    this.request = request;
    this.rawPath = rawPath;
    this.offer = offer;
    this.pattern = pattern;
    this.paywall = paywall;
  }

  @Override
  public String getHeader(String name) {
    return request.getHeader(name);
  }

  @Override
  public String getMethod() {
    return request.getMethod();
  }

  @Override
  public String getPath() {
    return rawPath;
  }

  @Override
  public String getUrl() {
    String query = request.getQueryString();
    return request.getRequestURL() + (query == null ? "" : "?" + query);
  }

  @Override
  public String getUserAgent() {
    // x402.paywall.enabled=false: never detected as a browser, so 402s stay JSON.
    if (!paywall) {
      return "";
    }
    return HttpAdapter.super.getUserAgent();
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
