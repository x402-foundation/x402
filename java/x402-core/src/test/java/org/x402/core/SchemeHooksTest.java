package org.x402.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.server.ServerHooks.SchemeServerHooks;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.server.ServerVerifyResult;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedKind;
import org.x402.core.types.VerifyResponse;

/** Scheme-scoped hooks run after the server-wide hooks, only for their scheme. */
class SchemeHooksTest {

  private final List<String> calls = new CopyOnWriteArrayList<>();
  private final List<VerifiedPaymentCanceledContext> cancels = new CopyOnWriteArrayList<>();
  private final FakeFacilitatorClient f = new FakeFacilitatorClient("f",
      supported(kind(PREPROD), new SupportedKind(2, "other", PREPROD, null)));
  private final X402ResourceServer server = X402ResourceServer.builder().facilitator(f).build();
  private final PaymentRequirements req = Fixtures.requirements();

  private static SchemeServerHooks hooks(
      org.x402.core.server.ServerHooks.BeforeVerifyHook beforeVerify,
      org.x402.core.server.ServerHooks.AfterVerifyHook afterVerify,
      org.x402.core.server.ServerHooks.BeforeSettleHook beforeSettle,
      org.x402.core.server.ServerHooks.OnSettleFailureHook onSettleFailure,
      org.x402.core.server.ServerHooks.OnVerifiedPaymentCanceledHook canceled) {
    return new SchemeServerHooks(beforeVerify, afterVerify, beforeSettle, null, null,
        onSettleFailure, canceled);
  }

  @Test
  void afterVerifyAbortInvalidatesAndCancelsExactlyOnce() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.hooks = hooks(null, ctx -> {
      calls.add("scheme-after");
      return AfterVerifyResult.abort("terms_mismatch", "quote differs");
    }, null, null, ctx -> {
      calls.add("scheme-cancel");
      cancels.add(ctx);
    });
    server.register(PREPROD, scheme);
    server.onAfterVerify(ctx -> {
      calls.add("global-after");
      return AfterVerifyResult.proceed();
    });
    server.onVerifiedPaymentCanceled(ctx -> calls.add("global-cancel"));
    server.initialize();

    ServerVerifyResult v = server.verifyPayment(Fixtures.payload(req), req, null, null);

    assertThat(v.isValid()).isFalse();
    assertThat(v.response().invalidReason()).isEqualTo("terms_mismatch");
    assertThat(v.response().invalidMessage()).isEqualTo("quote differs");
    assertThat(calls).containsExactly("global-after", "scheme-after", "global-cancel",
        "scheme-cancel");
    assertThat(cancels).singleElement().satisfies(c -> {
      assertThat(c.reason()).isEqualTo(CancellationReason.AFTER_VERIFY_ABORTED);
      assertThat(c.phase()).isEqualTo(SettlePhase.CANCEL);
      assertThat(c.settledPhases()).isEmpty();
    });
    assertThat(f.settleCalls).hasValue(0);
  }

  @Test
  void schemeHooksRunOnlyForTheirScheme() {
    FakeServerScheme exact = new FakeServerScheme();
    exact.hooks = hooks(ctx -> {
      calls.add("exact-before");
      return BeforeResult.proceed();
    }, null, null, null, null);
    server.register(PREPROD, exact);
    server.register(PREPROD, new FakeServerScheme("other"));
    server.onBeforeVerify(ctx -> {
      calls.add("global-before");
      return BeforeResult.proceed();
    });
    server.initialize();

    PaymentRequirements other = new PaymentRequirements("other", PREPROD, "USDM", "1", "p", 300,
        null);
    server.verifyPayment(Fixtures.payload(other), other, null, null);
    assertThat(calls).containsExactly("global-before");
    server.verifyPayment(Fixtures.payload(req), req, null, null);
    assertThat(calls).containsExactly("global-before", "global-before", "exact-before");
  }

  @Test
  void schemeBeforeVerifySkipAndBeforeSettleAbort() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.hooks = hooks(ctx -> BeforeResult.skip(VerifyResponse.valid("skip")), null,
        ctx -> BeforeResult.abort("not_now", "later"), null, null);
    server.register(PREPROD, scheme);
    server.initialize();

    ServerVerifyResult v = server.verifyPayment(Fixtures.payload(req), req, null, null);
    assertThat(v.response().payer()).isEqualTo("skip");
    assertThat(f.verifyCalls).hasValue(0);

    assertThatThrownBy(() -> server.settlePayment(Fixtures.payload(req), req, null, null, null,
        SettlePhase.AFTER_HANDLER))
        .isInstanceOfSatisfying(SettleException.class, e -> {
          assertThat(e.statusCode()).isEqualTo(400);
          assertThat(e.response().errorReason()).isEqualTo("not_now");
          assertThat(e.response().errorMessage()).isEqualTo("later");
          assertThat(e.response().transaction()).isEmpty();
          assertThat(e.response().network()).isEqualTo(PREPROD);
        });
    assertThat(f.settleCalls).hasValue(0);
  }

  @Test
  void schemeSettleFailureHookMayRecover() {
    FakeServerScheme scheme = new FakeServerScheme();
    SettleResponse recovered = SettleResponse.success("recovered", PREPROD, null);
    scheme.hooks = hooks(null, null, null, ctx -> Recovery.recovered(recovered), null);
    f.settleAlways((p, r) -> {
      throw new IllegalStateException("boom");
    });
    server.register(PREPROD, scheme);
    server.initialize();
    assertThat(server.settlePayment(Fixtures.payload(req), req, null, null, null,
        SettlePhase.AFTER_HANDLER)).isSameAs(recovered);
  }

  @Test
  void reRegisteringASchemeWithoutHooksRemovesThem() {
    FakeServerScheme withHooks = new FakeServerScheme();
    withHooks.hooks = hooks(ctx -> BeforeResult.abort("x", null), null, null, null, null);
    server.register(PREPROD, withHooks);
    server.register(PREPROD, new FakeServerScheme());
    server.initialize();
    assertThat(server.verifyPayment(Fixtures.payload(req), req, null, null).isValid()).isTrue();
  }
}
