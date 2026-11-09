package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.servlet.TestServers.route;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.core.server.X402ResourceServer;
import org.x402.http.PatternRouteResolver;
import org.x402.http.RouteConfig;
import org.x402.http.X402HttpResourceServer;

/** Startup sync and the background re-sync with backoff. */
class ResourceServerSyncTest {

  private static final ResourceServerSync.Settings FAST = new ResourceServerSync.Settings(
      Duration.ofSeconds(2), Duration.ofMillis(10), Duration.ofMillis(40));

  private static X402HttpResourceServer http(FakeFacilitatorClient... facilitators) {
    X402ResourceServer core = X402ResourceServer.builder()
        .facilitators(List.of(facilitators)).build();
    core.register(Fixtures.PREPROD, new FakeServerScheme());
    Map<String, RouteConfig> routes = new LinkedHashMap<>();
    routes.put("GET /weather", route("$0.01"));
    return new X402HttpResourceServer(core, new PatternRouteResolver(routes));
  }

  private static void await(java.util.function.BooleanSupplier condition) throws Exception {
    long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
    while (!condition.getAsBoolean() && System.nanoTime() < deadline) {
      Thread.sleep(10);
    }
    assertThat(condition.getAsBoolean()).isTrue();
  }

  @Test
  void theResyncBacksOffUntilTheFacilitatorAnswers() throws Exception {
    AtomicInteger failures = new AtomicInteger();
    FakeFacilitatorClient facilitator = new FakeFacilitatorClient("f",
        Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));
    facilitator.supported(() -> {
      if (failures.incrementAndGet() <= 4) {
        throw new IllegalStateException("down " + failures.get());
      }
      return Fixtures.supported(Fixtures.kind(Fixtures.PREPROD));
    });
    X402HttpResourceServer http = http(facilitator);
    ResourceServerSync sync = new ResourceServerSync(http, FAST);
    sync.start();
    sync.start(); // already running: no second sync
    await(() -> http.state() != null && http.state().failedFacilitators().isEmpty());
    assertThat(failures.get()).isGreaterThan(4);
    sync.stop();
  }

  @Test
  void anApplicationSyncThatLeftRoutesWaitingGetsTheBackgroundResync() throws Exception {
    AtomicInteger calls = new AtomicInteger();
    FakeFacilitatorClient facilitator = new FakeFacilitatorClient("f",
        Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));
    facilitator.supported(() -> {
      if (calls.incrementAndGet() <= 1) {
        throw new IllegalStateException("down");
      }
      return Fixtures.supported(Fixtures.kind(Fixtures.PREPROD));
    });
    X402HttpResourceServer http = http(facilitator);
    try {
      http.initialize();
    } catch (RuntimeException expected) {
      // the application's own sync: the facilitator is down
    }
    assertThat(http.state().affectedRoutes()).isNotEmpty();
    ResourceServerSync sync = new ResourceServerSync(http, FAST);
    sync.start();
    await(() -> http.state().affectedRoutes().isEmpty());
    sync.stop();
  }

  @Test
  void aFacilitatorNoRouteNeedsDoesNotDelayStartup() {
    FakeFacilitatorClient serving = new FakeFacilitatorClient("serving",
        Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));
    FakeFacilitatorClient broken = new FakeFacilitatorClient("broken",
        Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)))
        .failSupported(new IllegalStateException("down"));
    X402HttpResourceServer http = http(serving, broken);
    ResourceServerSync sync = new ResourceServerSync(http, FAST);
    sync.start();
    assertThat(http.state()).isNotNull();
    sync.stop();
  }

  @Test
  void stoppingBeforeStartingIsHarmlessAndAStoppedResyncDoesNothing() throws Exception {
    ResourceServerSync idle = new ResourceServerSync(http(new FakeFacilitatorClient("f",
        Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)))), FAST);
    idle.stop();

    FakeFacilitatorClient down = new FakeFacilitatorClient("f",
        Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)))
        .failSupported(new IllegalStateException("down"));
    ResourceServerSync sync = new ResourceServerSync(http(down), FAST);
    sync.start();
    sync.stop();
    int calls = down.supportedCalls.get();
    Thread.sleep(100);
    assertThat(down.supportedCalls.get()).isEqualTo(calls);
  }
}
