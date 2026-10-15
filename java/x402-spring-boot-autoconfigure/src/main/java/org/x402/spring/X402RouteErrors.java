package org.x402.spring;

import java.util.List;
import org.x402.http.RouteConfigurationError;
import org.x402.http.RouteValidationError;

/** Adds the offer name and option index to core route validation messages. */
public final class X402RouteErrors {

  private X402RouteErrors() {}

  /**
   * The same error with each message prefixed by {@code offer "NAME" accepts[INDEX]: }.
   *
   * @param error the core error
   * @return a new error with the same entries (retryable flags kept)
   */
  public static RouteConfigurationError withOfferNames(RouteConfigurationError error) {
    List<RouteValidationError> named = error.errors().stream().map(X402RouteErrors::name)
        .toList();
    RouteConfigurationError out = new RouteConfigurationError(named);
    out.setStackTrace(error.getStackTrace());
    return out;
  }

  private static RouteValidationError name(RouteValidationError e) {
    if (e.route() == null || e.message() == null || e.message().startsWith("offer \"")) {
      return e;
    }
    String where = "offer \"" + e.route() + "\""
        + (e.optionIndex() == null ? "" : " accepts[" + e.optionIndex() + "]");
    return new RouteValidationError(e.route(), e.scheme(), e.network(), e.reason(),
        where + ": " + e.message(), e.optionIndex(), e.facilitator(), e.retryable());
  }
}
