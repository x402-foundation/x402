package org.x402.http;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import org.x402.core.server.RoutingSnapshot;

/**
 * One immutable result of {@link X402HttpResourceServer#initialize()}: the routing snapshot and the
 * route validation computed against it, published together with one atomic swap.
 *
 * @param snapshot the routing snapshot
 * @param errors every validation error
 * @param warnings startup warnings (timeout budget, wildcard + bazaar)
 */
public record HttpServerState(
    RoutingSnapshot snapshot, List<RouteValidationError> errors, List<String> warnings) {

  /** Copies the lists. */
  public HttpServerState {
    Objects.requireNonNull(snapshot, "snapshot");
    errors = List.copyOf(errors);
    warnings = List.copyOf(warnings);
  }

  /**
   * The errors of one route.
   *
   * @param routeKey the route key
   * @return the errors, empty when the route is fine
   */
  public List<RouteValidationError> errorsFor(String routeKey) {
    return errors.stream().filter(e -> routeKey.equals(e.route())).toList();
  }

  /**
   * Routes with at least one error, in route order.
   *
   * @return the route keys
   */
  public Set<String> affectedRoutes() {
    Set<String> out = new LinkedHashSet<>();
    errors.stream().map(RouteValidationError::route).filter(Objects::nonNull).forEach(out::add);
    return out;
  }

  /**
   * Facilitators whose {@code /supported} failed in this sync.
   *
   * @return the identifiers in declaration order
   */
  public List<String> failedFacilitators() {
    return List.copyOf(snapshot.failures().keySet());
  }
}
