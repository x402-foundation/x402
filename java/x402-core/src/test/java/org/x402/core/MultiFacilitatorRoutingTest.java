package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PAY_TO;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.x402.core.server.FacilitatorCapabilityError;
import org.x402.core.server.FacilitatorRoute;
import org.x402.core.server.ResourceConfig;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerVerifyResult;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.VerifyResponse;

/** Multi-facilitator routing rules, including that settle never loops over facilitators. */
class MultiFacilitatorRoutingTest {

  private static X402ResourceServer server(FacilitatorClient... clients) {
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(clients)).build();
    server.register("cardano:*", new FakeServerScheme());
    server.register("cardano:*", new FakeServerScheme("other"));
    return server;
  }

  @Test
  void theFirstDeclaredFacilitatorOwnsAKind() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD),
        kind(MAINNET)));
    RoutingSnapshot snap = server(a, b).initialize();
    assertThat(snap.owner(2, PREPROD, "exact")).isEqualTo("A");
    assertThat(snap.owner(2, MAINNET, "exact")).isEqualTo("B");
    assertThat(snap.owner(1, PREPROD, "exact")).isNull();
    assertThat(snap.facilitatorIdentifiers()).containsExactly("A", "B");
    assertThat(snap.supported("B").kinds()).hasSize(2);
    assertThat(snap.extensions("A")).isEmpty();
  }

  @Test
  void anExactNetworkKeyBeatsAWildcardRegardlessOfOrder() {
    FakeFacilitatorClient wildcard = new FakeFacilitatorClient("W", supported(kind("cardano:*")));
    FakeFacilitatorClient exact = new FakeFacilitatorClient("E", supported(kind(PREPROD)));
    RoutingSnapshot snap = server(wildcard, exact).initialize();
    assertThat(snap.owner(2, PREPROD, "exact")).isEqualTo("E");
    assertThat(snap.owner(2, MAINNET, "exact")).isEqualTo("W");
  }

  @Test
  void anExactKeyWithoutTheSchemeDoesNotFallBackToThePattern() {
    FakeFacilitatorClient wildcard = new FakeFacilitatorClient("W", supported(kind("cardano:*")));
    FakeFacilitatorClient other = new FakeFacilitatorClient("O",
        supported(new SupportedKind(2, "other", PREPROD, null)));
    RoutingSnapshot snap = server(wildcard, other).initialize();
    assertThat(snap.owner(2, PREPROD, "exact")).isNull();
    assertThat(snap.owner(2, PREPROD, "other")).isEqualTo("O");
  }

  @Test
  void wildcardKindsRouteButCannotBuildRequirements() {
    FakeFacilitatorClient wildcard = new FakeFacilitatorClient("W", supported(kind("cardano:*")));
    X402ResourceServer server = server(wildcard);
    server.initialize();
    assertThat(server.getSupportedKind(2, PREPROD, "exact")).isNull();
    assertThatThrownBy(() -> server.buildPaymentRequirements(
        ResourceConfig.of("exact", PREPROD, PAY_TO, new Money("$1"))))
        .hasMessageStartingWith("Facilitator does not support exact on cardano:preprod.");
    PaymentRequirements r = Fixtures.requirements();
    assertThat(server.verifyPayment(Fixtures.payload(r), r, null, null).verifiedBy())
        .isEqualTo("W");
  }

  @Test
  void aFailingFacilitatorWarnsAndInitializeContinuesAndReportsIt() {
    FacilitatorResponseException down = new FacilitatorResponseException("down", 0, null);
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", null).failSupported(down);
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    RoutingSnapshot snap = server(a, b).initialize();
    assertThat(snap.owner(2, PREPROD, "exact")).isEqualTo("B");
    assertThat(snap.failures()).containsOnlyKeys("A");
    assertThat(snap.failures().get("A")).isSameAs(down);
    assertThat(snap.supported("A")).isNull();
    assertThat(snap.hasKinds()).isTrue();
  }

  @Test
  void parallelSyncWithinABudgetKeepsDeclarationPrecedence() throws Exception {
    FakeFacilitatorClient slow = new FakeFacilitatorClient("slow", null).supported(() -> {
      try {
        Thread.sleep(2000);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      return supported(kind(MAINNET));
    });
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    var pool = Executors.newCachedThreadPool();
    try {
      X402ResourceServer server = server(slow, b, a);
      long start = System.nanoTime();
      RoutingSnapshot snap = server.sync(Duration.ofMillis(300), pool);
      assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(2));
      assertThat(snap.owner(2, PREPROD, "exact")).isEqualTo("B");
      assertThat(snap.failures()).containsOnlyKeys("slow");
      assertThat(snap.failures().get("slow")).isInstanceOf(FacilitatorResponseException.Timeout.class);
      assertThat(server.snapshot()).isNull();
      server.publish(snap);
      assertThat(server.snapshot()).isSameAs(snap);
    } finally {
      pool.shutdownNow();
    }
  }

  @Test
  void anUnmappedKindVerifiesOnEveryFacilitatorInOrderButNeverSettlesElsewhere() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind("eip155:1")))
        .verifyAlways((p, r) -> {
          throw new IllegalStateException("A cannot");
        });
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind("eip155:2")))
        .verifyAlways((p, r) -> VerifyResponse.valid("b"));
    X402ResourceServer server = server(a, b);
    server.initialize();
    PaymentRequirements r = Fixtures.requirements();

    ServerVerifyResult v = server.verifyPayment(Fixtures.payload(r), r, null, null);
    assertThat(v.verifiedBy()).isEqualTo("B");
    assertThat(a.verifyCalls).hasValue(1);

    assertThatThrownBy(() -> server.settlePayment(Fixtures.payload(r), r, null, null, null,
        SettlePhase.AFTER_HANDLER))
        .hasMessage("No facilitator supports exact on cardano:preprod for v2");
    assertThat(a.settleCalls.get() + b.settleCalls.get()).isZero();
  }

  @Test
  void unmappedVerifyRethrowsTheLastErrorWhenEveryFacilitatorFails() {
    IllegalStateException last = new IllegalStateException("B cannot");
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind("eip155:1")))
        .verifyAlways((p, r) -> {
          throw new IllegalStateException("A cannot");
        });
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind("eip155:2")))
        .verifyAlways((p, r) -> {
          throw last;
        });
    X402ResourceServer server = server(a, b);
    server.initialize();
    PaymentRequirements r = Fixtures.requirements();
    assertThatThrownBy(() -> server.verifyPayment(Fixtures.payload(r), r, null, null))
        .isSameAs(last);
  }

  @Test
  void aSettleTimeoutAtTheTargetIsNotRetriedElsewhere() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)))
        .settleAlways((p, r) -> {
          throw new FacilitatorResponseException.Timeout("settle", 90000);
        });
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    X402ResourceServer server = server(a, b);
    server.initialize();
    PaymentRequirements r = Fixtures.requirements();
    assertThatThrownBy(() -> server.settlePayment(Fixtures.payload(r), r, null, null, null,
        SettlePhase.AFTER_HANDLER)).isInstanceOf(FacilitatorResponseException.Timeout.class);
    assertThat(a.settleCalls).hasValue(1);
    assertThat(b.settleCalls).hasValue(0);
  }

  @Test
  void capabilityValidationCollectsEveryProblemAcrossOwners() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.capabilityCheck = k -> "bad " + k.network();
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(MAINNET)));
    X402ResourceServer server = X402ResourceServer.builder().facilitators(List.of(a, b)).build();
    server.register(PREPROD, scheme);
    server.register(MAINNET, scheme);
    server.register("eip155:1", scheme);
    assertThatThrownBy(server::initialize)
        .isInstanceOfSatisfying(FacilitatorCapabilityError.class, e -> assertThat(e.problems())
            .containsExactly("exact on cardano:preprod: bad cardano:preprod",
                "exact on cardano:mainnet: bad cardano:mainnet"));
    assertThat(server.validateFacilitatorCapabilities(server.snapshot())).hasSize(2);
  }

  @Test
  void routeHelpersExposeTheBuildFacilitator() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    X402ResourceServer server = server(a);
    RoutingSnapshot snap = server.initialize();
    assertThat(FacilitatorRoute.of(null, false)).isEqualTo(FacilitatorRoute.auto());
    assertThat(FacilitatorRoute.of(null, true)).isEqualTo(FacilitatorRoute.autoWithVerifyFailover());
    assertThat(FacilitatorRoute.of("A", true)).isEqualTo(FacilitatorRoute.pinned("A"));
    assertThat(server.buildFacilitator(ResourceConfig.of("exact", MAINNET, PAY_TO,
        new Money("$1")), snap)).isNull();
  }
}
