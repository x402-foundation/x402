package org.x402.spring.actuate;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.actuate.health.AbstractHealthIndicator;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.x402.http.HttpServerState;
import org.x402.spring.X402ServerLifecycle;

/**
 * The {@code x402} health component: {@code UP} when every route can be served, {@code
 * OUT_OF_SERVICE} while waiting for a failed facilitator, {@code DOWN} when routes stay invalid
 * after a re-sync. Each facilitator's state is a detail; a facilitator no route needs never makes
 * the component DOWN.
 */
public final class X402HealthIndicator extends AbstractHealthIndicator {

  private final X402ServerLifecycle lifecycle;

  /**
   * Creates the indicator.
   *
   * @param lifecycle the sync lifecycle
   */
  public X402HealthIndicator(X402ServerLifecycle lifecycle) {
    super("x402 health check failed");
    this.lifecycle = lifecycle;
  }

  @Override
  protected void doHealthCheck(Health.Builder builder) {
    builder.status(switch (lifecycle.status()) {
      case READY -> Status.UP;
      case AWAITING_FACILITATORS -> Status.OUT_OF_SERVICE;
      case INVALID -> Status.DOWN;
    });
    HttpServerState state = lifecycle.state();
    Map<String, Object> facilitators = new LinkedHashMap<>();
    for (String id : lifecycle.facilitators()) {
      Map<String, Object> detail = new LinkedHashMap<>();
      if (state == null) {
        detail.put("status", lifecycle.synced() ? "UNKNOWN" : "NOT_SYNCED");
      } else if (state.snapshot().failures().containsKey(id)) {
        detail.put("status", "DOWN");
        detail.put("error", String.valueOf(state.snapshot().failures().get(id)));
      } else {
        detail.put("status", "UP");
      }
      facilitators.put(id, detail);
    }
    builder.withDetail("facilitators", facilitators);
    if (state != null) {
      builder.withDetail("affectedRoutes", state.affectedRoutes());
      if (!state.warnings().isEmpty()) {
        builder.withDetail("warnings", state.warnings());
      }
    }
  }
}
