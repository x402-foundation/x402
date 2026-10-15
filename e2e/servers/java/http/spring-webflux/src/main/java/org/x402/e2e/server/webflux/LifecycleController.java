package org.x402.e2e.server.webflux;

import java.util.Map;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.e2e.server.E2eServerLifecycle;

/** {@code GET /health} and {@code POST /close} for the harness. */
@RestController
class LifecycleController {

  private final ConfigurableApplicationContext context;

  LifecycleController(ConfigurableApplicationContext context) {
    this.context = context;
  }

  @GetMapping("/health")
  Map<String, Object> health() {
    return E2eServerLifecycle.health();
  }

  @PostMapping("/close")
  Map<String, Object> close() {
    return E2eServerLifecycle.close(context);
  }
}
