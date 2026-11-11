package org.x402.e2e.facilitator;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /health} and {@code POST /close} for the harness. */
@RestController
class LifecycleController {

  private final ConfigurableApplicationContext context;
  private final Environment environment;

  LifecycleController(ConfigurableApplicationContext context, Environment environment) {
    this.context = context;
    this.environment = environment;
  }

  @GetMapping("/health")
  Map<String, Object> health() {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("status", "ok");
    body.put("cardanoNetwork", environment.getProperty(
        "x402.facilitator-server.cardano.networks[0].network", "(not configured)"));
    return body;
  }

  @PostMapping("/close")
  Map<String, Object> close() {
    System.out.println("Received shutdown request");
    Thread stopper = new Thread(() -> {
      try {
        Thread.sleep(100);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      System.exit(SpringApplication.exit(context, () -> 0));
    }, "e2e-close");
    stopper.start();
    return Map.of("message", "Facilitator shutting down gracefully");
  }
}
