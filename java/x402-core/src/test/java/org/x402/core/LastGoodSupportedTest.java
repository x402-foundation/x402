package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.X402ResourceServer;

/**
 * A facilitator that served before keeps its last answer through a failed re-sync, so a
 * transient failure does not take its routes down; it is still reported as failed.
 */
class LastGoodSupportedTest {

  private static X402ResourceServer server(FakeFacilitatorClient a, FakeFacilitatorClient b) {
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(a, b)).build();
    server.register("cardano:*", new FakeServerScheme());
    return server;
  }

  @Test
  void aServingFacilitatorKeepsItsKindsWhenOneResyncFails() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", null)
        .failSupported(new IllegalStateException("B down"));
    X402ResourceServer server = server(a, b);
    server.publish(server.sync());
    assertThat(server.snapshot().owner(2, PREPROD, "exact")).isEqualTo("A");

    a.failSupported(new IllegalStateException("A timed out once"));
    RoutingSnapshot next = server.sync();
    server.publish(next);

    assertThat(next.owner(2, PREPROD, "exact")).isEqualTo("A");
    assertThat(next.hasKinds()).isTrue();
    assertThat(next.failures()).containsKeys("A", "B");
  }

  @Test
  void theParallelSyncKeepsTheLastAnswerToo() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", null)
        .failSupported(new IllegalStateException("B down"));
    X402ResourceServer server = server(a, b);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      server.publish(server.sync(Duration.ofSeconds(5), pool));
      a.failSupported(new IllegalStateException("A timed out once"));
      RoutingSnapshot next = server.sync(Duration.ofSeconds(5), pool);
      assertThat(next.owner(2, PREPROD, "exact")).isEqualTo("A");
      assertThat(next.failures()).containsKey("A");
    } finally {
      pool.shutdownNow();
    }
  }

  @Test
  void aFacilitatorThatNeverAnsweredHasNothingToKeep() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", null)
        .failSupported(new IllegalStateException("A down"));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", null)
        .failSupported(new IllegalStateException("B down"));
    X402ResourceServer server = server(a, b);
    server.publish(server.sync());
    RoutingSnapshot next = server.sync();
    assertThat(next.hasKinds()).isFalse();
  }
}
