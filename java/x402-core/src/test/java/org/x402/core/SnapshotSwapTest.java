package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.x402.core.server.FacilitatorRoute;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerVerifyResult;
import org.x402.core.server.SettlementRouting;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SupportedResponse;

/**
 * Re-sync publishes a new immutable snapshot with one swap: requests running concurrently with
 * repeated {@code initialize()} never see a partial owner map.
 */
class SnapshotSwapTest {

  private static final SupportedResponse BOTH = supported(kind(PREPROD), kind(MAINNET));
  private static final SupportedResponse NONE = supported(kind("eip155:1"));

  @Test
  void concurrentVerifyAndSettleNeverSeeAPartialMap() throws Exception {
    AtomicInteger phase = new AtomicInteger();
    // Phase even: A owns both networks. Phase odd: A answers nothing useful, B owns both.
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", null)
        .supported(() -> phase.get() % 2 == 0 ? BOTH : NONE);
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", BOTH);
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(a, b)).build();
    server.register("cardano:*", new FakeServerScheme());
    server.initialize();

    AtomicBoolean stop = new AtomicBoolean();
    ConcurrentLinkedQueue<String> failures = new ConcurrentLinkedQueue<>();
    ExecutorService pool = Executors.newFixedThreadPool(6);
    CountDownLatch started = new CountDownLatch(5);
    pool.submit(() -> {
      try {
        started.await();
        for (int i = 0; i < 300; i++) {
          phase.incrementAndGet();
          server.initialize();
        }
      } catch (Exception e) {
        failures.add("resync: " + e);
      } finally {
        stop.set(true);
      }
      return null;
    });
    for (int t = 0; t < 5; t++) {
      pool.submit(() -> {
        started.countDown();
        while (!stop.get()) {
          RoutingSnapshot snap = server.snapshot();
          String preprodOwner = snap.owner(2, PREPROD, "exact");
          String mainnetOwner = snap.owner(2, MAINNET, "exact");
          if (preprodOwner == null || !preprodOwner.equals(mainnetOwner)) {
            failures.add("partial snapshot: " + preprodOwner + "/" + mainnetOwner);
          }
          PaymentRequirements r = Fixtures.requirements(PREPROD, "1");
          try {
            ServerVerifyResult v = server.verifyPayment(Fixtures.payload(r), r, null, null,
                FacilitatorRoute.auto(), snap);
            if (!v.isValid()) {
              failures.add("invalid: " + v.response());
            }
            server.settlePayment(Fixtures.payload(r), r, null, null, null,
                SettlePhase.AFTER_HANDLER, new SettlementRouting(FacilitatorRoute.auto(),
                    v.verifiedBy(), snap));
            if (!preprodOwner.equals(v.verifiedBy())) {
              failures.add("verified by " + v.verifiedBy() + " under owner " + preprodOwner);
            }
          } catch (RuntimeException e) {
            failures.add("request: " + e);
          }
        }
        return null;
      });
    }
    pool.shutdown();
    assertThat(pool.awaitTermination(60, TimeUnit.SECONDS)).isTrue();
    assertThat(failures).isEmpty();
    assertThat(a.verifyCalls.get() + b.verifyCalls.get())
        .isEqualTo(a.settleCalls.get() + b.settleCalls.get());
  }

  @Test
  void aCapturedSnapshotStaysUsableAfterLaterSyncs() {
    AtomicInteger phase = new AtomicInteger();
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", null)
        .supported(() -> phase.get() == 0 ? BOTH : NONE);
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", BOTH);
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(a, b)).build();
    server.register("cardano:*", new FakeServerScheme());
    RoutingSnapshot old = server.initialize();
    phase.set(1);
    RoutingSnapshot current = server.initialize();

    assertThat(old.owner(2, PREPROD, "exact")).isEqualTo("A");
    assertThat(current.owner(2, PREPROD, "exact")).isEqualTo("B");
    PaymentRequirements r = Fixtures.requirements();
    server.settlePayment(Fixtures.payload(r), r, null, null, null, SettlePhase.AFTER_HANDLER,
        new SettlementRouting(FacilitatorRoute.auto(), null, old));
    assertThat(a.settleCalls).hasValue(1);
    assertThat(b.settleCalls).hasValue(0);
  }
}
