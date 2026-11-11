package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.server.FacilitatorRoute;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerVerifyResult;
import org.x402.core.server.SettlementRouting;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.VerifyResponse;

/**
 * Verify failover: one hop, transport failures only, identical kind only; settle
 * follows the verifier and never fails over.
 */
class VerifyFailoverTest {

  private static final Map<String, Object> EXTRA = map("feePayer", "same");

  private final FakeServerScheme scheme = new FakeServerScheme();
  private final FakeFacilitatorClient a = new FakeFacilitatorClient("A",
      supported(kind(PREPROD, EXTRA)));
  private final FakeFacilitatorClient b = new FakeFacilitatorClient("B",
      supported(kind(PREPROD, map("feePayer", "other"))));
  private final FakeFacilitatorClient c = new FakeFacilitatorClient("C",
      supported(kind(PREPROD, EXTRA)));
  private final FakeFacilitatorClient d = new FakeFacilitatorClient("D",
      supported(kind(PREPROD, EXTRA)));
  private final List<Throwable> failureHookErrors = new CopyOnWriteArrayList<>();
  private final X402ResourceServer server;
  private final PaymentRequirements req = Fixtures.requirements().withExtra(EXTRA);

  VerifyFailoverTest() {
    server = X402ResourceServer.builder().facilitators(List.of(a, b, c, d)).build();
    server.register(PREPROD, scheme);
    server.onVerifyFailure(ctx -> {
      failureHookErrors.add(ctx.error());
      return Recovery.none();
    });
  }

  private ServerVerifyResult verify(FacilitatorRoute route) {
    server.initialize();
    return server.verifyPayment(Fixtures.payload(req), req, null, null, route, null);
  }

  private void settle(FacilitatorRoute route, String verifiedBy) {
    server.settlePayment(Fixtures.payload(req), req, null, null, null, SettlePhase.AFTER_HANDLER,
        new SettlementRouting(route, verifiedBy, null));
  }

  private void ownerFailsWith(Supplier<RuntimeException> error) {
    a.verifyAlways((p, r) -> {
      throw error.get();
    });
  }

  @Test
  void timeoutFailsOverOneHopToTheNextIdenticalKindAndSettleFollows() {
    ownerFailsWith(() -> new FacilitatorResponseException.Timeout("verify", 15000));
    ServerVerifyResult v = verify(FacilitatorRoute.autoWithVerifyFailover());
    assertThat(v.isValid()).isTrue();
    assertThat(v.verifiedBy()).isEqualTo("C");
    assertThat(b.verifyCalls).hasValue(0);

    settle(FacilitatorRoute.autoWithVerifyFailover(), v.verifiedBy());
    assertThat(c.settleCalls).hasValue(1);
    assertThat(a.settleCalls).hasValue(0);
    assertThat(b.settleCalls).hasValue(0);
    assertThat(failureHookErrors).isEmpty();
  }

  @Test
  void connectionErrors5xxAnd429WithoutVerdictFailOver() {
    for (RuntimeException e : List.of(
        new FacilitatorResponseException("connect refused", 0, null),
        new FacilitatorStatusException("Facilitator verify failed (503): busy", 503),
        new FacilitatorStatusException("Facilitator verify failed (429): slow down", 429))) {
      ownerFailsWith(() -> e);
      assertThat(verify(FacilitatorRoute.autoWithVerifyFailover()).verifiedBy())
          .as(e.getMessage()).isEqualTo("C");
    }
    assertThat(c.verifyCalls).hasValue(3);
  }

  @Test
  void aVerdictBodyIsFinalWhateverTheStatus() {
    VerifyException verdict = new VerifyException(500, VerifyResponse.invalid("nonce_spent", null));
    ownerFailsWith(() -> verdict);
    assertThatThrownBy(() -> verify(FacilitatorRoute.autoWithVerifyFailover())).isSameAs(verdict);
    assertThat(c.verifyCalls).hasValue(0);
    assertThat(failureHookErrors).containsExactly(verdict);
  }

  @Test
  void a4xxOtherThan429AndAnUnusableBodyAreFinal() {
    ownerFailsWith(() -> new FacilitatorStatusException("Facilitator verify failed (400): x", 400));
    assertThatThrownBy(() -> verify(FacilitatorRoute.autoWithVerifyFailover()))
        .isInstanceOf(FacilitatorStatusException.class);
    ownerFailsWith(() -> new FacilitatorResponseException("invalid data", 200, null));
    assertThatThrownBy(() -> verify(FacilitatorRoute.autoWithVerifyFailover()))
        .isInstanceOf(FacilitatorResponseException.class);
    assertThat(c.verifyCalls).hasValue(0);
  }

  @Test
  void failoverOffOrPinnedNeverFailsOver() {
    ownerFailsWith(() -> new FacilitatorResponseException.Timeout("verify", 15000));
    assertThatThrownBy(() -> verify(FacilitatorRoute.auto()))
        .isInstanceOf(FacilitatorResponseException.Timeout.class);
    assertThatThrownBy(() -> verify(FacilitatorRoute.pinned("A")))
        .isInstanceOf(FacilitatorResponseException.Timeout.class);
    assertThat(c.verifyCalls).hasValue(0);
    assertThat(d.verifyCalls).hasValue(0);
  }

  @Test
  void onlyOneHopIsTaken() {
    ownerFailsWith(() -> new FacilitatorResponseException.Timeout("verify", 15000));
    c.verifyAlways((p, r) -> {
      throw new FacilitatorResponseException.Timeout("verify", 15000);
    });
    assertThatThrownBy(() -> verify(FacilitatorRoute.autoWithVerifyFailover()))
        .isInstanceOf(FacilitatorResponseException.Timeout.class);
    assertThat(c.verifyCalls).hasValue(1);
    assertThat(d.verifyCalls).hasValue(0);
    assertThat(failureHookErrors).hasSize(1);
  }

  @Test
  void aSettleErrorNeverFailsOver() {
    server.initialize();
    a.settleAlways((p, r) -> {
      throw new FacilitatorResponseException.Timeout("settle", 90000);
    });
    assertThatThrownBy(() -> settle(FacilitatorRoute.autoWithVerifyFailover(), null))
        .isInstanceOf(FacilitatorResponseException.Timeout.class);
    assertThat(a.settleCalls).hasValue(1);
    assertThat(b.settleCalls.get() + c.settleCalls.get() + d.settleCalls.get()).isZero();
  }

  @Test
  void skipVerifyHookSettlesAtTheBuildFacilitatorOrThePin() {
    server.onBeforeVerify(ctx -> BeforeResult.skip(VerifyResponse.valid("p")));
    ServerVerifyResult v = verify(FacilitatorRoute.autoWithVerifyFailover());
    assertThat(v.verifiedBy()).isNull();
    settle(FacilitatorRoute.autoWithVerifyFailover(), v.verifiedBy());
    assertThat(a.settleCalls).hasValue(1);

    ServerVerifyResult pinned = verify(FacilitatorRoute.pinned("D"));
    settle(FacilitatorRoute.pinned("D"), pinned.verifiedBy());
    assertThat(d.settleCalls).hasValue(1);
    assertThat(a.verifyCalls.get() + d.verifyCalls.get()).isZero();
  }

  @Test
  void upfrontFlowWithFailoverSettlesAtTheBuildFacilitator() {
    scheme.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT),
        PaymentFlow.UPFRONT));
    ownerFailsWith(() -> new FacilitatorResponseException.Timeout("verify", 15000));
    ServerVerifyResult v = verify(FacilitatorRoute.autoWithVerifyFailover());
    assertThat(v.isValid()).isTrue();
    assertThat(v.verifiedBy()).isNull();
    assertThat(a.verifyCalls.get() + c.verifyCalls.get()).isZero();
    settle(FacilitatorRoute.autoWithVerifyFailover(), null);
    assertThat(a.settleCalls).hasValue(1);
    assertThat(c.settleCalls).hasValue(0);
  }

  @Test
  void noCandidateWithAnIdenticalKindMeansNoFailover() {
    X402ResourceServer two = X402ResourceServer.builder().facilitators(List.of(a, b)).build();
    two.register(PREPROD, scheme);
    two.initialize();
    ownerFailsWith(() -> new FacilitatorResponseException.Timeout("verify", 15000));
    assertThatThrownBy(() -> two.verifyPayment(Fixtures.payload(req), req, null, null,
        FacilitatorRoute.autoWithVerifyFailover(), null))
        .isInstanceOf(FacilitatorResponseException.Timeout.class);
    assertThat(b.verifyCalls).hasValue(0);
  }
}
