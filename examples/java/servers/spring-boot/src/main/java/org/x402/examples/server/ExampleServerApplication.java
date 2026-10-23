package org.x402.examples.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** The example resource server: x402 comes from the starter, the offers from application.yml. */
@SpringBootApplication
public class ExampleServerApplication {

  public static void main(String[] args) {
    SpringApplication.run(ExampleServerApplication.class, args);
  }
}
