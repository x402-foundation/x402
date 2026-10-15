package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.X402ResourceServer;

/** Overlapping syncs: a snapshot from an older sync never replaces a newer one. */
class SnapshotPublishOrderTest {

  @Test
  void anOlderSnapshotDoesNotReplaceANewerOne() {
    X402ResourceServer server = X402ResourceServer.builder()
        .facilitator(new FakeFacilitatorClient("a", Fixtures.supported(Fixtures.kind("test:net"))))
        .build();
    RoutingSnapshot older = server.sync();
    RoutingSnapshot newer = server.sync();

    server.publish(newer);
    server.publish(older);

    assertThat(server.snapshot()).isSameAs(newer);
  }

  /** A sync that started first but answered last is the older one, whatever its finish time. */
  @Test
  void aSyncThatStartedFirstButFinishedLastDoesNotWin() throws Exception {
    java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
    FakeFacilitatorClient facilitator =
        new FakeFacilitatorClient("a", Fixtures.supported(Fixtures.kind("test:net")));
    facilitator.supported(() -> {
      if (calls.getAndIncrement() == 0) {
        try {
          release.await();
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
      }
      return Fixtures.supported(Fixtures.kind("test:net"));
    });
    X402ResourceServer server = X402ResourceServer.builder().facilitator(facilitator).build();
    java.util.concurrent.CompletableFuture<RoutingSnapshot> slow =
        java.util.concurrent.CompletableFuture.supplyAsync(server::sync);
    while (calls.get() == 0) {
      Thread.onSpinWait();
    }

    RoutingSnapshot fast = server.sync();
    server.publish(fast);
    release.countDown();
    server.publish(slow.get(5, java.util.concurrent.TimeUnit.SECONDS));

    assertThat(server.snapshot()).isSameAs(fast);
  }
}
