package org.x402.spring.facilitator;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.actuate.health.AbstractHealthIndicator;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.Status;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;

/**
 * The {@code x402-facilitator} health component: one detail per configured Cardano
 * network saying whether its chain backend answers (a protocol-parameter lookup, which the
 * Blockfrost backend caches for ten minutes). {@code DOWN} when any backend fails.
 */
public final class X402FacilitatorHealthIndicator extends AbstractHealthIndicator {

  private final CardanoFacilitatorSchemes schemes;

  /**
   * Creates the indicator.
   *
   * @param schemes the Cardano facilitator schemes
   */
  public X402FacilitatorHealthIndicator(CardanoFacilitatorSchemes schemes) {
    super("x402 facilitator health check failed");
    this.schemes = schemes;
  }

  @Override
  protected void doHealthCheck(Health.Builder builder) {
    Status status = Status.UP;
    Map<String, Object> networks = new LinkedHashMap<>();
    for (String network : schemes.networks()) {
      CardanoChainBackend backend = schemes.backend(network);
      Map<String, Object> detail = new LinkedHashMap<>();
      try {
        backend.checkHealth(network);
        detail.put("status", "UP");
      } catch (RuntimeException e) {
        detail.put("status", "DOWN");
        detail.put("error", String.valueOf(e.getMessage()));
        status = Status.DOWN;
      }
      networks.put(network, detail);
    }
    builder.status(status).withDetail("networks", networks);
  }
}
