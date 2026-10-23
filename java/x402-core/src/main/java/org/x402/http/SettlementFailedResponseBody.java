package org.x402.http;

import org.x402.core.types.SettleResponse;

/** The body of a 402 after a failed settlement. */
@FunctionalInterface
public interface SettlementFailedResponseBody {

  /**
   * Creates the body.
   *
   * @param context the request
   * @param failure the failed settlement
   * @return the body
   */
  HttpResponseBody create(HttpRequestContext context, SettleResponse failure);
}
