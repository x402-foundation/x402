package org.x402.http;

/** Resolves a receiving address per request. */
@FunctionalInterface
public interface DynamicPayTo {

  /**
   * Resolves the address.
   *
   * @param context the request
   * @return the address
   */
  String resolve(HttpRequestContext context);
}
