package org.x402.e2e.server.webflux;

import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.x402.e2e.server.E2eServerLifecycle;

/** x402 e2e resource server on Spring WebFlux (Reactor Netty), using the x402 Spring Boot starter. */
@SpringBootApplication
public class WebFluxServerApplication {

  /**
   * Starts the server.
   *
   * @param args the arguments
   */
  public static void main(String[] args) {
    E2eServerLifecycle.run(WebFluxServerApplication.class, "x402 Spring WebFlux e2e server", args);
  }
}
