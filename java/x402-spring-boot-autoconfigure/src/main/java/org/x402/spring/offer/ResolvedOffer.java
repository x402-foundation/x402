package org.x402.spring.offer;

import java.util.Objects;
import org.x402.http.RouteConfig;

/**
 * One offer after resolution.
 *
 * @param name the offer name ({@code x402.routes.<name>})
 * @param path its route pattern, or {@code null} when only annotations use it
 * @param route the core route
 */
public record ResolvedOffer(String name, String path, RouteConfig route) {

  /** Validates. */
  public ResolvedOffer {
    Objects.requireNonNull(name, "name");
    Objects.requireNonNull(route, "route");
  }
}
