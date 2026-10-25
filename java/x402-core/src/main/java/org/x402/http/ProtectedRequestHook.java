package org.x402.http;

import java.util.Objects;

/**
 * Runs before any payment processing of a protected route: it
 * may grant access without payment or abort with 403.
 */
@FunctionalInterface
public interface ProtectedRequestHook {

  /**
   * Runs the hook.
   *
   * @param context the request
   * @param routeConfig the matched route
   * @return proceed, grant access or abort
   */
  Result apply(HttpRequestContext context, RouteConfig routeConfig);

  /** The hook's decision. */
  sealed interface Result permits Proceed, GrantAccess, Abort {

    /**
     * Continue with payment processing.
     *
     * @return the result
     */
    static Result proceed() {
      return Proceed.INSTANCE;
    }

    /**
     * Serve without payment.
     *
     * @return the result
     */
    static Result grantAccess() {
      return GrantAccess.INSTANCE;
    }

    /**
     * Answer 403 with {@code {"error": reason}}.
     *
     * @param reason the reason
     * @return the result
     */
    static Result abort(String reason) {
      return new Abort(reason);
    }
  }

  /** Continue. */
  final class Proceed implements Result {
    static final Proceed INSTANCE = new Proceed();

    private Proceed() {}
  }

  /** Grant access. */
  final class GrantAccess implements Result {
    static final GrantAccess INSTANCE = new GrantAccess();

    private GrantAccess() {}
  }

  /**
   * Abort with 403.
   *
   * @param reason the reason
   */
  record Abort(String reason) implements Result {

    /** Validates. */
    public Abort {
      Objects.requireNonNull(reason, "reason");
    }
  }
}
