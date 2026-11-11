package org.x402.e2e.server;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ConfigurableApplicationContext;
import org.x402.spring.X402ServerLifecycle;

/** Start-up and shutdown shared by the Java e2e servers. */
public final class E2eServerLifecycle {

  private static volatile E2eServerConfig config;

  private E2eServerLifecycle() {}

  /**
   * Builds the x402 properties from the catalog and starts the application. Prints {@code Server
   * listening} (the harness ready line) once the application is ready, i.e. after the x402
   * facilitator sync and with the web server accepting connections.
   *
   * @param application the Spring Boot application class
   * @param title the banner title
   * @param args the arguments
   */
  public static void run(Class<?> application, String title, String[] args) {
    E2eServerConfig cfg = E2eServerConfig.fromEnvironment();
    config = cfg;
    System.out.println(title + ": paid routes " + cfg.mountedPaths());
    cfg.skipped().forEach(s -> System.out.println(title + ": skipped " + s));
    SpringApplication app = new SpringApplication(application);
    app.setDefaultProperties(cfg.properties());
    app.addListeners((ApplicationReadyEvent event) -> {
      // A degraded start (facilitator down → paid routes 503, or invalid routes → 500) must not
      // look ready: the harness would then pass unpaid scenarios. Fail the process instead.
      X402ServerLifecycle lifecycle =
          event.getApplicationContext().getBeanProvider(X402ServerLifecycle.class).getIfAvailable();
      if (lifecycle != null && lifecycle.status() != X402ServerLifecycle.Status.READY) {
        System.err.println(title + ": x402 is " + lifecycle.status() + " (facilitators "
            + lifecycle.facilitators() + "); paid routes cannot be served, exiting");
        System.err.flush();
        System.exit(1);
      }
      String port = event.getApplicationContext().getEnvironment()
          .getProperty("local.server.port", String.valueOf(cfg.properties().get("server.port")));
      System.out.println("Server listening on http://localhost:" + port);
      System.out.flush();
    });
    app.run(args);
  }

  /**
   * The {@code GET /health} body.
   *
   * @return the body
   */
  public static Map<String, Object> health() {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("status", "ok");
    body.put("version", "2.0.0");
    body.put("routes", config == null ? java.util.List.of() : config.mountedPaths());
    return body;
  }

  /**
   * Answers {@code POST /close} and stops the application shortly after the response is sent.
   *
   * @param context the application context
   * @return the body
   */
  public static Map<String, Object> close(ConfigurableApplicationContext context) {
    System.out.println("Received shutdown request");
    Thread stopper = new Thread(() -> {
      try {
        Thread.sleep(100);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      System.exit(SpringApplication.exit(context, () -> 0));
    }, "e2e-close");
    stopper.setDaemon(false);
    stopper.start();
    return Map.of("message", "Server shutting down gracefully");
  }
}
