package org.x402.examples.facilitator;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * A Cardano x402 facilitator. The facilitator itself comes from YAML ({@code
 * x402.facilitator-server.*}); {@link SecurityConfig} adds authentication, which the SDK leaves
 * to Spring Security.
 */
@SpringBootApplication
public class FacilitatorApplication {

  public static void main(String[] args) {
    SpringApplication.run(FacilitatorApplication.class, args);
  }
}
