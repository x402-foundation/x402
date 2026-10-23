package org.x402.e2e.server.mvc;

import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.x402.e2e.server.E2eServerLifecycle;

/** x402 e2e resource server on Spring MVC (servlet), using the x402 Spring Boot starter. */
@SpringBootApplication
public class MvcServerApplication {

  /**
   * Starts the server.
   *
   * @param args the arguments
   */
  public static void main(String[] args) {
    E2eServerLifecycle.run(MvcServerApplication.class, "x402 Spring MVC e2e server", args);
  }
}
