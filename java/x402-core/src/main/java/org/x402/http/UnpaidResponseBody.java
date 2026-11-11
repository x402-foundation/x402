package org.x402.http;

/** The body of an unpaid 402 for non-browser clients. */
@FunctionalInterface
public interface UnpaidResponseBody {

  /**
   * Creates the body.
   *
   * @param context the request
   * @return the body
   */
  HttpResponseBody create(HttpRequestContext context);
}
