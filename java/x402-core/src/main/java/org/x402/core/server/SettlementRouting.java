package org.x402.core.server;

import java.util.Objects;

/**
 * Where a settle (and its pending retry, and a settle-on-cancel) goes: {@code verifiedBy}, else the
 * pin, else the build facilitator. Settle never moves to another facilitator.
 *
 * @param route the option's route
 * @param verifiedBy the facilitator that verified, or {@code null}
 * @param snapshot the routing snapshot the request was served with, or {@code null} for the
 *     current one
 */
public record SettlementRouting(FacilitatorRoute route, String verifiedBy, RoutingSnapshot snapshot) {

  /** Validates. */
  public SettlementRouting {
    Objects.requireNonNull(route, "route");
  }

  /**
   * Route by kind with the current snapshot.
   *
   * @return the routing
   */
  public static SettlementRouting auto() {
    return new SettlementRouting(FacilitatorRoute.auto(), null, null);
  }
}
