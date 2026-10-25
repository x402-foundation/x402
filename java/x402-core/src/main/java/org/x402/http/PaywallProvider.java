package org.x402.http;

import org.x402.core.types.PaymentRequired;

/**
 * Renders the HTML 402 for browsers. Without one, a static page
 * without any request-derived content is served.
 */
@FunctionalInterface
public interface PaywallProvider {

  /**
   * Renders the page.
   *
   * @param paymentRequired the 402
   * @param config options, may be {@code null}
   * @return the HTML
   */
  String generateHtml(PaymentRequired paymentRequired, PaywallConfig config);
}
