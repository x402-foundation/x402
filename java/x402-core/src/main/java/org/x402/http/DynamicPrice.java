package org.x402.http;

import org.x402.core.types.Price;

/** Resolves a price per request. */
@FunctionalInterface
public interface DynamicPrice {

  /**
   * Resolves the price.
   *
   * @param context the request
   * @return the price
   */
  Price resolve(HttpRequestContext context);
}
